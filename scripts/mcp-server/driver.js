// 驱动器：通过同源 RPC 通道控制编辑器页面，把 window.__superEditor 桥接 API 封装为可调用函数。
// 页面带 ai_control=1 打开时，轮询 {origin}/ai-control/rpc（dev server / 后端提供）。
// 设置环境变量 SUPER_EDITOR_MOCK=1 可进入 mock 模式（不连接编辑器，便于测试 MCP 服务本身）。

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const MOCK = process.env.SUPER_EDITOR_MOCK === '1'

let active = null // { mode: 'rpc'|'mock', origin, pageUrl }

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
    mode: active.mode || 'rpc',
    pageUrl: active.pageUrl || null,
    origin: active.origin || null,
    instanceId: active.instanceId || null
  }
}

async function resolveRpcOrigin(httpUrl, pageUrl) {
  let origin = ''
  if (pageUrl && /^https?:\/\//.test(pageUrl)) {
    origin = new URL(pageUrl).origin
  } else if (httpUrl) {
    origin = httpUrl.replace(/\/+$/, '')
  } else {
    throw new Error('需要 pageUrl（课件完整 URL）或 httpUrl（编辑器 origin，如 http://localhost:8090）')
  }
  const probe = await fetch(origin + '/ai-control/rpc/instances', {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
  }).catch(() => null)
  if (!probe || !probe.ok) {
    throw new Error(
      'RPC 端点不可达：' + origin + '/ai-control/rpc（请确认编辑器已带 ai_control=1 打开，且 dev server / 后端已挂载 /ai-control/rpc 路由）'
    )
  }
  return origin
}

export async function connect(httpUrl, pageUrl) {
  if (MOCK) {
    active = { mode: 'mock', origin: 'mock://super-editor', pageUrl: pageUrl || 'mock://super-editor' }
    return { pageUrl: active.pageUrl, title: 'MOCK', mode: 'mock' }
  }
  const origin = await resolveRpcOrigin(httpUrl, pageUrl)
  await closeActive()
  active = { mode: 'rpc', origin, pageUrl: pageUrl || origin }
  // 探测页面实例：不带 targetInstance 路由到最近活跃实例，之后所有调用固定到该实例
  let probe
  try {
    probe = await rpcBridgeCall('ping')
  } catch (err) {
    await closeActive()
    throw new Error('未发现活跃的编辑器页面实例：' + err.message + '（请确认页面已带 ai_control=1 打开并完成加载）')
  }
  active.instanceId = (probe && probe.instanceId) || null
  return { pageUrl: active.pageUrl, title: 'RPC', mode: 'rpc', origin, instanceId: active.instanceId }
}

export async function closeActive() {
  active = null
}

async function rpcBridgeCall(method, args) {
  const resp = await fetch(active.origin + '/ai-control/rpc/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args: args || [], timeoutMs: 90000, targetInstance: active.instanceId || undefined })
  })
  if (!resp.ok) {
    throw new Error('RPC 请求失败：HTTP ' + resp.status + ' ' + resp.statusText)
  }
  const out = await resp.json()
  if (!out.ok) throw new Error(out.error || ('RPC 调用 ' + method + ' 失败'))
  return out.value
}

export async function bridgeCall(method, args = []) {
  if (MOCK) return mockResult(method, args)
  if (!active) throw new Error('尚未连接编辑器页面：请先调用 editor_connect')
  return rpcBridgeCall(method, args)
}

export async function captureScreenshot(opts = {}) {
  if (MOCK) return TINY_PNG_DATA_URL
  if (!active) throw new Error('尚未连接编辑器页面：请先调用 editor_connect')
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

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

function mockResult(method, args = []) {
  const arg = (args && args[0]) || {}
  switch (method) {
    case 'ping':
      return { version: '0.1.0-mock', editorType: 'content-editor', bookId: 'mock-book', mode: 'ai-control' }
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
