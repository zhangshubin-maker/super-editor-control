// 驱动器：通过插件进程内置的 127.0.0.1 RPC 中继控制普通浏览器页面。
// 设置环境变量 SUPER_EDITOR_MOCK=1 可进入 mock 模式（不连接编辑器，便于测试 MCP 服务本身）。

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  RPC_ORIGIN,
  ensureLocalRpcBroker,
  stopLocalRpcBroker
} from './rpc-broker.js'

const MOCK = process.env.SUPER_EDITOR_MOCK === '1'
const RPC_REQUEST_TIMEOUT_MS = 90000
const DISCOVERY_TIMEOUT_MS = 3000
const RECONNECT_DISCOVERY_TIMEOUT_MS = 30000
const DISCOVERY_RETRY_MS = 100
const CONTROL_TIMEOUT_MS = 3000
const CLIENT_ID = 'mcp-' + randomUUID()
const LEASE_RENEW_INTERVAL_MS = 10000

let active = null // { mode: 'rpc'|'mock', origin, instanceId, page }
let connectPromise = null
let pinnedWindowId = null

class RpcBridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code || 'RPC_ERROR'
  }
}

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
}

// 把本地图片路径读取为 dataURL；已有 data/base64 时原样透传
async function resolveImageInput(args = {}) {
  const out = { ...args }
  if (!out.imagePath) return out
  if (MOCK) {
    out.data = 'data:image/png;base64,mock'
    return out
  }
  const filePath = path.resolve(out.imagePath)
  const buf = await readFile(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME_BY_EXT[ext] || 'image/png'
  out.data = `data:${mime};base64,${buf.toString('base64')}`
  out.mimeType = out.mimeType || mime
  out.fileName = out.fileName || path.basename(filePath)
  return out
}

export function isMock() {
  return MOCK
}

export function isConnected() {
  return !!active
}

export function pageInfo() {
  if (!active) return { connected: false, mock: MOCK }
  return {
    connected: true,
    mock: MOCK,
    mode: active.mode || 'local-rpc',
    rpcOrigin: active.origin || RPC_ORIGIN,
    instanceId: active.instanceId || null,
    windowId: active.windowId || pinnedWindowId || null,
    page: active.page || null
  }
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(timeoutMs)
    : undefined
}

export async function initialize() {
  if (MOCK) return { origin: 'mock://super-editor', role: 'mock' }
  return ensureLocalRpcBroker()
}

async function fetchInstances({ waitForPage = false } = {}) {
  const deadline = Date.now() + (waitForPage ? DISCOVERY_TIMEOUT_MS : 0)
  do {
    let broker = await ensureLocalRpcBroker()
    let response = await fetch(broker.rpcBaseUrl + '/instances', {
      signal: timeoutSignal(DISCOVERY_TIMEOUT_MS)
    }).catch(() => null)
    if (!response || !response.ok) {
      broker = await ensureLocalRpcBroker({ forceProbe: true })
      response = await fetch(broker.rpcBaseUrl + '/instances', {
        signal: timeoutSignal(DISCOVERY_TIMEOUT_MS)
      }).catch(() => null)
      if (!response || !response.ok) {
        throw new RpcBridgeError('BROKER_UNAVAILABLE', '插件本地 RPC 中继不可达：' + RPC_ORIGIN)
      }
    }
    const instances = await response.json()
    if (Array.isArray(instances) && instances.length) return { broker, instances }
    if (!waitForPage || Date.now() >= deadline) {
      return { broker, instances: Array.isArray(instances) ? instances : [] }
    }
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_MS))
  } while (Date.now() <= deadline)
  return { broker: await ensureLocalRpcBroker(), instances: [] }
}

async function postBrokerControl(pathname, body, retryAfterRecovery = true) {
  let broker = await ensureLocalRpcBroker()
  let response = await fetch(broker.rpcBaseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(CONTROL_TIMEOUT_MS)
  }).catch(() => null)
  if ((!response || !response.ok) && retryAfterRecovery) {
    broker = await ensureLocalRpcBroker({ forceProbe: true })
    response = await fetch(broker.rpcBaseUrl + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: timeoutSignal(CONTROL_TIMEOUT_MS)
    }).catch(() => null)
  }
  if (!response || !response.ok) {
    throw new RpcBridgeError(
      'BROKER_UNAVAILABLE',
      '插件本地 RPC 中继不可达：' + RPC_ORIGIN
    )
  }
  return response.json()
}

async function claimInstance(preferredInstance, preferredWindowId) {
  return postBrokerControl('/claim', {
    clientId: CLIENT_ID,
    preferredInstance: preferredInstance || undefined,
    preferredWindowId: preferredWindowId || undefined
  })
}

async function releaseInstance(instanceId) {
  if (MOCK) return
  await postBrokerControl(
    '/release',
    { clientId: CLIENT_ID, instance: instanceId || undefined },
    false
  ).catch(() => {})
}

async function rpcRequest(method, args, targetInstance) {
  const broker = await ensureLocalRpcBroker()
  let response
  const leaseTimer = setInterval(() => {
    claimInstance(targetInstance, pinnedWindowId).catch(() => {})
  }, LEASE_RENEW_INTERVAL_MS)
  leaseTimer.unref()
  try {
    response = await fetch(broker.rpcBaseUrl + '/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method,
        args: Array.isArray(args) ? args : [],
        timeoutMs: RPC_REQUEST_TIMEOUT_MS,
        targetInstance: targetInstance || undefined,
        clientId: CLIENT_ID
      }),
      signal: timeoutSignal(RPC_REQUEST_TIMEOUT_MS + CONTROL_TIMEOUT_MS)
    })
  } catch (error) {
    active = null
    await ensureLocalRpcBroker({ forceProbe: true }).catch(() => {})
    throw new RpcBridgeError(
      'OUTCOME_UNKNOWN',
      '本地 RPC 中继连接中断，已尝试恢复。为避免重复写入，本次操作没有自动重放，请先读取页面状态后重试：' +
        error.message
    )
  } finally {
    clearInterval(leaseTimer)
  }
  if (!response.ok) {
    throw new RpcBridgeError(
      'RPC_HTTP_ERROR',
      '本地 RPC 请求失败：HTTP ' + response.status + ' ' + response.statusText
    )
  }
  let result
  try {
    result = await response.json()
  } catch (error) {
    active = null
    await ensureLocalRpcBroker({ forceProbe: true }).catch(() => {})
    throw new RpcBridgeError(
      'OUTCOME_UNKNOWN',
      '本地 RPC 响应在读取时中断。为避免重复写入，本次操作没有自动重放，请先读取页面状态后重试：' +
        error.message
    )
  }
  if (!result.ok) {
    throw new RpcBridgeError(result.errorCode, result.error || 'RPC 调用 ' + method + ' 失败')
  }
  return result.value
}

async function ensureConnected(options = {}) {
  if (active && active.instanceId) return active
  if (connectPromise) return connectPromise
  connectPromise = (async () => {
    const preferredWindowId =
      options.windowId === undefined ? pinnedWindowId : options.windowId
    const timeoutMs =
      options.timeoutMs === undefined
        ? preferredWindowId
          ? RECONNECT_DISCOVERY_TIMEOUT_MS
          : DISCOVERY_TIMEOUT_MS
        : options.timeoutMs
    const deadline = Date.now() + timeoutMs
    let claimed
    do {
      claimed = await claimInstance(null, preferredWindowId)
      if (claimed.ok) break
      const waitingForTargetWindow =
        preferredWindowId &&
        ['NO_INSTANCES', 'WINDOW_NOT_FOUND', 'INSTANCE_STALE'].includes(claimed.errorCode)
      if (claimed.errorCode !== 'NO_INSTANCES' && !waitingForTargetWindow) {
        throw new RpcBridgeError(claimed.errorCode, claimed.error)
      }
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_MS))
    } while (Date.now() < deadline)
    if (!claimed || !claimed.ok) {
      throw new RpcBridgeError(
        claimed && claimed.errorCode,
        (claimed && claimed.error) ||
          '暂无可控制的编辑器页面，请在浏览器中打开课件并点击顶部“AI 控制”开关'
      )
    }
    const instanceId = claimed.instance
    try {
      const page = await rpcRequest('ping', [], instanceId)
      const windowId = claimed.windowId || (page && page.windowId) || preferredWindowId || null
      pinnedWindowId = windowId
      active = { mode: 'local-rpc', origin: RPC_ORIGIN, instanceId, windowId, page }
      return active
    } catch (error) {
      await releaseInstance(instanceId)
      throw error
    }
  })()
  try {
    return await connectPromise
  } finally {
    connectPromise = null
  }
}

export async function connect() {
  if (MOCK) {
    active = { mode: 'mock', origin: 'mock://super-editor', page: mockResult('ping') }
    return pageInfo()
  }
  await closeActive({ clearPinnedWindow: true })
  await ensureConnected({ windowId: null, timeoutMs: DISCOVERY_TIMEOUT_MS })
  return pageInfo()
}

export async function closeActive({ clearPinnedWindow = false } = {}) {
  const instanceId = active && active.instanceId
  active = null
  if (clearPinnedWindow) pinnedWindowId = null
  await releaseInstance(instanceId)
}

export async function getStatus() {
  if (MOCK) {
    if (!active) await connect()
    return Object.assign(pageInfo(), { bridgeReady: true, brokerRole: 'mock' })
  }
  try {
    const result = await fetchInstances()
    const broker = result.broker
    let instances = result.instances
    let reconnectError = null
    if (active && !instances.includes(active.instanceId)) await closeActive()
    if (!active && pinnedWindowId) {
      try {
        await ensureConnected({ timeoutMs: DISCOVERY_TIMEOUT_MS })
      } catch (error) {
        if (!['NO_INSTANCES', 'WINDOW_NOT_FOUND', 'INSTANCE_STALE'].includes(error.code)) {
          throw error
        }
        reconnectError = error
      }
    }
    if (active && !instances.includes(active.instanceId)) {
      instances = [active.instanceId, ...instances]
    }
    if (!instances.length) {
      return {
        connected: false,
        bridgeReady: false,
        mode: 'local-rpc',
        rpcOrigin: RPC_ORIGIN,
        brokerRole: broker.role,
        instanceId: null,
        windowId: pinnedWindowId,
        instances,
        bridgeError: '尚未发现已开启 AI 控制的浏览器页面'
      }
    }
    if (!active && pinnedWindowId) {
      return {
        connected: false,
        bridgeReady: false,
        available: false,
        mode: 'local-rpc',
        rpcOrigin: RPC_ORIGIN,
        brokerRole: broker.role,
        instanceId: null,
        windowId: pinnedWindowId,
        instances,
        bridgeError:
          (reconnectError && reconnectError.message) || '正在等待原浏览器窗口重新注册'
      }
    }
    if (!active) {
      return {
        connected: false,
        bridgeReady: true,
        available: true,
        mode: 'local-rpc',
        rpcOrigin: RPC_ORIGIN,
        brokerRole: broker.role,
        instanceId: null,
        windowId: pinnedWindowId,
        instances
      }
    }
    const connection = active
    const page = await rpcRequest('ping', [], connection.instanceId)
    connection.page = page
    return Object.assign(pageInfo(), {
      bridgeReady: true,
      brokerRole: broker.role,
      instances
    })
  } catch (error) {
    await closeActive()
    return {
      connected: false,
      bridgeReady: false,
      mode: 'local-rpc',
      rpcOrigin: RPC_ORIGIN,
      instanceId: null,
      windowId: pinnedWindowId,
      instances: [],
      bridgeError: error.message
    }
  }
}

export async function bridgeCall(method, args = []) {
  if (MOCK) return mockResult(method, args)
  const connection = await ensureConnected()
  try {
    return await rpcRequest(method, args, connection.instanceId)
  } catch (error) {
    if (!['INSTANCE_STALE', 'INSTANCE_UNREGISTERED'].includes(error.code)) throw error
    const targetWindowId = connection.windowId || pinnedWindowId
    await closeActive()
    if (!targetWindowId) throw error
    const nextConnection = await ensureConnected({
      windowId: targetWindowId,
      timeoutMs: RECONNECT_DISCOVERY_TIMEOUT_MS
    })
    return rpcRequest(method, args, nextConnection.instanceId)
  }
}

export async function captureScreenshot(opts = {}) {
  if (MOCK) return TINY_PNG_DATA_URL
  const data = await bridgeCall('screenshot', [opts])
  if (typeof data === 'string' && data.startsWith('data:image')) return data
  throw new Error('桥接 screenshot 不可用（fullPage 拼接失败或浏览器不支持 html-to-image）')
}

export async function uploadImage(args = {}) {
  const a = await resolveImageInput(args)
  return bridgeCall('uploadImage', [a])
}

export async function addImageElement(args = {}) {
  const a = await resolveImageInput(args)
  return bridgeCall('addImageElement', [a])
}

export async function setImageElementSrc(args = {}) {
  const a = await resolveImageInput(args)
  return bridgeCall('setImageElementSrc', [a])
}

export async function shutdown() {
  await closeActive({ clearPinnedWindow: true })
  await stopLocalRpcBroker()
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function mockResult(method, args = []) {
  const arg = (args && args[0]) || {}
  switch (method) {
    case 'ping':
      return { version: '1.0.0-mock', editorType: 'content-editor', bookId: 'mock-book', mode: 'ai-control' }
    case 'getUserInfo':
      return { uid: 'mock-user', name: '示例用户', nickname: '示例用户' }
    case 'searchBooks':
      return {
        items: [
          {
            id: 'mock-book-source',
            name: '示例超媒教辅',
            type: 6,
            smart_book_type: 3,
            smart_book_type_name: '超媒交互型',
            cover_img_id: 'mock-cover-1',
            cover_img_url: 'https://mock.example.com/book-cover.png'
          }
        ],
        pageNo: arg.pageNo || 0,
        pageSize: arg.pageSize || 20,
        total: 1,
        paginator: { total_count: 1 }
      }
    case 'getBookInfo':
      return {
        book_info: {
          id: arg.bookId || 'mock-book-source',
          name: '示例超媒教辅',
          type: 6,
          smart_book_type: 3,
          smart_book_type_name: '超媒交互型',
          cover_img_id: 'mock-cover-1',
          cover_img_url: 'https://mock.example.com/book-cover.png'
        },
        subject_list: [{ id: 3, name: '语文' }],
        book_mapping_list: [],
        category_list: [],
        edition_id: 1
      }
    case 'createBookFromSource': {
      const bookId = 'mock-book-' + Date.now()
      const copyMode = arg.copyMode || 'light'
      return {
        sourceBookId: arg.sourceBookId,
        bookId,
        copyMode,
        includesCatalogAndContent: copyMode === 'full',
        cloneMethod: copyMode === 'full' ? 'deepcopyhypermediabook' : 'addbook',
        book: {
          book_info: {
            id: bookId,
            name: arg.name || '示例超媒教辅_copy',
            smart_book_type: arg.smartBookType || 3
          }
        },
        editorUrl: `https://mock.example.com/content-editor?book_id=${bookId}`
      }
    }
    case 'jumpToBook':
      return {
        bookId: arg.bookId,
        url: `https://mock.example.com/content-editor?book_id=${arg.bookId}`,
        target: arg.target || 'url',
        scheduled: arg.target === 'current',
        opened: arg.target === 'new'
      }
    case 'searchTemplates':
      return [
        {
          id: arg.kind === 'block' ? 'block-template-1' : 'chapter-template-1',
          name: arg.kind === 'block' ? '示例区块模板' : '示例样章模板',
          type: arg.kind === 'block' ? 2 : 3,
          kind: arg.kind === 'block' ? 'block' : 'chapter',
          parentId: null,
          classifyId: null,
          cover: 'https://mock.example.com/template.png',
          updatedAt: null
        }
      ]
    case 'getTemplateDetail':
      return {
        id: arg.templateId,
        name: '示例模板',
        type: 3,
        content: {},
        childList: [],
        lines: []
      }
    case 'applyTemplate':
      return arg.kind === 'block'
        ? { templateId: arg.templateId, blockId: 'mock-block-' + Date.now() }
        : { slideId: 'mock-slide-' + Date.now() }
    case 'searchComponents':
      return [
        {
          id: 'component-1',
          name: '示例排版组件',
          scope: 'system',
          classifyIds: ['classify-1'],
          classifyType: 1,
          cover: 'https://mock.example.com/component.png',
          version: 1,
          hasContent: true
        }
      ]
    case 'applyComponent':
      return { componentId: arg.componentId, elementIds: ['mock-component-el-' + Date.now()] }
    case 'searchImageLibrary':
      return [
        {
          id: 'image-1',
          name: '示例图片素材',
          url: 'https://mock.example.com/library/image-1.png',
          format: 'png',
          width: 640,
          height: 480,
          groupId: 'group-1',
          groupName: '示例分组',
          scope: arg.scope || 'book'
        }
      ]
    case 'applyLibraryImage':
      return {
        imageId: arg.imageId || null,
        url: arg.url || 'https://mock.example.com/library/image-1.png',
        elementId: arg.elementId || 'mock-image-el-' + Date.now()
      }
    case 'getState':
      return {
        bookInfo: { id: 'mock-book', name: '示例课件（MOCK）' },
        slides: [
          { id: 'slide-1', name: '第 1 页', pageId: null },
          { id: 'slide-2', name: '第 2 页', pageId: null }
        ],
        currentSlideId: 'slide-1',
        selection: [],
        dirty: false
      }
    case 'listSlides':
      return mockResult('getState').slides
    case 'getSlide':
      return {
        slide: { id: arg.slideId || 'slide-1', name: '第 1 页' },
        blocks: [
          {
            uuid: 'block-1',
            name: '区块 1',
            size: { width: 794, height: 300 },
            elements: [{ id: 'el-1', type: 'text', templateId: 'block-1', groupId: 0, text: '示例文本' }]
          }
        ]
      }
    case 'addBlock':
      return { blockId: 'mock-block-' + Date.now() }
    case 'cloneBlock':
      return { blockId: 'mock-block-clone-' + Date.now() }
    case 'addElement':
      return { elementId: 'mock-el-' + Date.now() }
    case 'groupElements':
      return { groupId: 'mock-group-' + Date.now() }
    case 'selectSlide':
    case 'addSlide':
    case 'deleteSlide':
    case 'moveSlide':
    case 'updateBlock':
    case 'deleteBlock':
    case 'moveBlock':
    case 'updateElement':
    case 'deleteElement':
    case 'moveElement':
    case 'resizeElement':
    case 'rotateElement':
    case 'duplicateElement':
    case 'orderElement':
    case 'ungroup':
    case 'undo':
    case 'redo':
    case 'save':
      return null
    case 'fitTableHeights':
      return { tableId: arg.tableId, changed: true, heights: [32, 70], oldHeights: [45, 85], height: 102 }
    case 'getTableInfo':
      return { tableId: arg.tableId, rows: 2, cols: 3, widths: [100, 100, 100], heights: [40, 40], mergedCells: [], border: {}, style: {} }
    case 'getTableGrid':
      return { tableId: arg.tableId, rows: 2, cols: 3, mergedCells: [], grid: [[{ row: 0, col: 0, id: 'c1', rowspan: 1, colspan: 1, isOrigin: false, isCovered: false, content: 'A', contentHtml: 'A' }]] }
    case 'insertTableRow':
    case 'deleteTableRow':
    case 'insertTableColumn':
    case 'deleteTableColumn':
    case 'mergeTableCells':
    case 'splitTableCell':
      return { tableId: arg.tableId, rows: 2, cols: 3 }
    case 'getMindData':
      return {
        mindId: arg.mindId,
        template: 'right',
        theme: 'mind-default',
        version: '1.4.0',
        connectColor: null,
        root: { data: { id: 'root-1', text: '<p>中心主题</p>', type: 0 }, children: [] }
      }
    case 'getMindTree':
      return {
        mindId: arg.mindId,
        template: 'right',
        theme: 'mind-default',
        nodeCount: 1,
        depth: 0,
        root: { id: 'root-1', text: '中心主题', textHtml: '<p>中心主题</p>', type: 0, depth: 0, path: ['root-1'], attrs: {}, children: [] }
      }
    case 'setMindData':
      return { mindId: arg.mindId, nodeCount: 1 }
    case 'setMindNodeText':
      return { mindId: arg.mindId, nodeId: arg.nodeId, text: String(arg.text || '') }
    case 'updateMindNode':
      return { mindId: arg.mindId, nodeId: arg.nodeId, updated: true }
    case 'addMindNode':
      return { mindId: arg.mindId, nodeId: 'mock-node-' + Date.now(), position: arg.position || 'child', parentId: arg.nodeId || 'root-1' }
    case 'deleteMindNode':
      return { mindId: arg.mindId, nodeId: arg.nodeId, deleted: true, remaining: 1 }
    case 'setMindTemplate':
      return { mindId: arg.mindId, template: arg.template }
    case 'setMindTheme':
      return { mindId: arg.mindId, theme: arg.theme }
    case 'getTextInfo':
      return {
        elementId: arg.elementId,
        blockId: 'block-1',
        content: '<p>示例文本</p>',
        text: '示例文本',
        wordCount: 4,
        font: { size: 16, name: '思源黑体 CN', weight: 400, color: '#333333' },
        lineHeight: 1.6,
        maxWidth: 700,
        maxHeight: null,
        background: { type: 'color', extendType: 'both' },
        geometry: { left: 75, top: 20, width: 200, height: 50 },
        groupId: 0
      }
    case 'setTextContent':
      return { elementId: arg.elementId, content: String(arg.content || ''), text: String(arg.content || ''), extendType: 'both', width: 260, height: 50, dWidth: 60, dHeight: 0, autoResized: true, moved: [] }
    case 'setTextAdaptive':
      return { elementId: arg.elementId, extendType: arg.extendType, previous: 'both', width: 200, height: 50, dWidth: 0, dHeight: 0, autoResized: false, moved: [] }
    case 'fitTextSize':
      return { elementId: arg.elementId, width: 200, height: 50, dWidth: 0, dHeight: 0, autoResized: false, moved: [] }
    case 'getOutline':
    case 'refreshOutline':
      return {
        slideId: String(arg.slideId || 'slide-1'),
        outline: [
          {
            id: 'outline-1',
            book_id: 'mock-book',
            catalog_id: String(arg.slideId || 'slide-1'),
            outline_name: '示例大纲（MOCK）',
            parent_id: 0,
            sort: 1,
            content_uuids: ['block-1'],
            children: [
              {
                id: 'outline-1-1',
                book_id: 'mock-book',
                catalog_id: String(arg.slideId || 'slide-1'),
                outline_name: '子节点',
                parent_id: 'outline-1',
                sort: 1,
                content_uuids: [],
                children: []
              }
            ]
          }
        ],
        selectedOutlineId: null
      }
    case 'addOutline':
      return {
        id: 'mock-outline-' + Date.now(),
        outline_name: String(arg.name || '未命名'),
        parent_id: arg.parentId || 0,
        sort: arg.sort || 1,
        content_uuids: []
      }
    case 'renameOutline':
      return { outlineId: String(arg.outlineId), outline_name: String(arg.name || '') }
    case 'deleteOutline':
      return { outlineId: String(arg.outlineId), deleted: true }
    case 'moveOutline':
      return { outlineId: String(arg.outlineId), parentId: arg.parentId || 0, sort: arg.sort }
    case 'linkOutlineBlocks':
      return { outlineId: String(arg.outlineId), content_uuids: Array.isArray(arg.blockIds) ? arg.blockIds : [] }
    case 'selectOutline':
      return arg.outlineId || null
    case 'getOutlineSelection':
      return 'outline-1'
    case 'getOutlineAnchors':
      return {
        outlineId: String(arg.outlineId),
        anchors: [
          {
            id: 'anchor-1',
            outline_id: String(arg.outlineId),
            name: '位置锚点（MOCK）',
            type: 1,
            position_x: 0,
            position_y: 10,
            width: 0,
            height: 0
          }
        ]
      }
    case 'addOutlineAnchor':
      return {
        outlineId: String(arg.outlineId),
        anchorId: 'mock-anchor-' + Date.now(),
        id: 'mock-anchor-' + Date.now(),
        name: String(arg.name || '锚点'),
        type: arg.type || 2
      }
    case 'updateOutlineAnchor':
      return { anchorId: String(arg.id), updated: true }
    case 'deleteOutlineAnchor':
      return { outlineId: String(arg.outlineId), anchorId: String(arg.anchorId), deleted: true }
    case 'uploadImage':
      return {
        url: 'https://mock.example.com/upload/ai-image-' + Date.now() + '.png',
        fileId: 'mock-file-' + Date.now(),
        fileName: String(arg.fileName || 'ai-image.png')
      }
    case 'addImageElement':
      return {
        url: String(arg.url || 'https://mock.example.com/upload/ai-image-' + Date.now() + '.png'),
        elementId: 'mock-el-' + Date.now()
      }
    case 'setImageElementSrc':
      return {
        url: String(arg.url || 'https://mock.example.com/upload/ai-image-' + Date.now() + '.png'),
        elementId: String(arg.elementId)
      }
    case 'batch': {
      const steps = (args[0] && args[0].steps) || []
      return {
        results: steps.map((st, i) => ({
          index: i,
          method: st.method,
          ok: true,
          value: { mocked: true, method: st.method, args: st.args }
        })),
        stopped: false,
        stoppedAt: null
      }
    }
    default:
      return { mocked: true, method, args }
  }
}
