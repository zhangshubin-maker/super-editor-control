// 驱动器：通过插件进程内置的 127.0.0.1 RPC 中继控制普通浏览器页面。
// 设置环境变量 SUPER_EDITOR_MOCK=1 可进入 mock 模式（不连接编辑器，便于测试 MCP 服务本身）。

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  RPC_ORIGIN,
  ensureLocalRpcBroker,
  stopLocalRpcBroker
} from './rpc-broker.js'
import { calculateSemanticSnapshotStableHash } from './semanticSnapshotFile.js'

const MOCK = process.env.SUPER_EDITOR_MOCK === '1'
const RPC_REQUEST_TIMEOUT_MS = 90000
const DISCOVERY_TIMEOUT_MS = 3000
const RECONNECT_DISCOVERY_TIMEOUT_MS = 30000
const DISCOVERY_RETRY_MS = 100
const BOOK_SWITCH_READY_TIMEOUT_MS = 30000
const CONTROL_TIMEOUT_MS = 3000
const CLIENT_ID = 'mcp-' + randomUUID()
const LEASE_RENEW_INTERVAL_MS = 10000
const MAX_INLINE_FILE_BYTES = 70 * 1024 * 1024
const MOCK_SEMANTIC_SNAPSHOT_UNSUPPORTED =
  process.env.SUPER_EDITOR_MOCK_SEMANTIC_SNAPSHOT_UNSUPPORTED === '1'
const MOCK_SEMANTIC_SNAPSHOT_INCOMPLETE =
  process.env.SUPER_EDITOR_MOCK_SEMANTIC_SNAPSHOT_INCOMPLETE === '1'

let active = null // { mode: 'rpc'|'mock', origin, instanceId, page }
let connectPromise = null
let pinnedWindowId = null
let mockDirty = process.env.SUPER_EDITOR_MOCK_DIRTY === '1'
const mockBridgeCalls = []

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
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

// 浏览器不能直接读取 MCP 进程所在机器的路径，因此先把本地文件转成 dataURL。
// broker 单请求上限为 100MB；base64 还会膨胀约 1/3，主动限制在 70MB 以内。
async function resolveFileInput(
  args = {},
  { pathKey = 'filePath', defaultMime = 'application/octet-stream' } = {}
) {
  const out = { ...args }
  const localPath = out[pathKey]
  if (!localPath) return out
  const resolvedPath = path.resolve(localPath)
  const ext = path.extname(resolvedPath).toLowerCase()
  const mime = out.mimeType || MIME_BY_EXT[ext] || defaultMime
  out.mimeType = mime
  out.fileName = out.fileName || path.basename(resolvedPath)
  delete out.filePath
  delete out.imagePath
  if (MOCK) {
    out.data = `data:${mime};base64,mock`
    return out
  }
  const fileStat = await stat(resolvedPath)
  if (!fileStat.isFile()) throw new Error('本地路径不是文件：' + resolvedPath)
  if (fileStat.size > MAX_INLINE_FILE_BYTES) {
    throw new Error(
      `本地文件超过 ${Math.floor(MAX_INLINE_FILE_BYTES / 1024 / 1024)}MB，` +
        '无法通过当前 base64 RPC 通道上传，请先压缩或使用远程素材 URL'
    )
  }
  const buf = await readFile(resolvedPath)
  out.data = `data:${mime};base64,${buf.toString('base64')}`
  return out
}

// 旧图片工具继续使用 imagePath，并保持未知扩展名默认 image/png 的行为。
async function resolveImageInput(args = {}) {
  return resolveFileInput(args, { pathKey: 'imagePath', defaultMime: 'image/png' })
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

async function claimInstance(preferredInstance, preferredWindowId, excludedInstance) {
  return postBrokerControl('/claim', {
    clientId: CLIENT_ID,
    preferredInstance: preferredInstance || undefined,
    preferredWindowId: preferredWindowId || undefined,
    excludedInstance: excludedInstance || undefined
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

async function rpcRequest(method, args, targetInstance, requestTimeoutMs = RPC_REQUEST_TIMEOUT_MS) {
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
        timeoutMs: requestTimeoutMs,
        targetInstance: targetInstance || undefined,
        clientId: CLIENT_ID
      }),
      signal: timeoutSignal(requestTimeoutMs + CONTROL_TIMEOUT_MS)
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
  const excludedInstanceId = options.excludedInstanceId || null
  if (active && active.instanceId && active.instanceId !== excludedInstanceId) return active
  if (active && active.instanceId === excludedInstanceId) await closeActive()
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
      claimed = await claimInstance(null, preferredWindowId, excludedInstanceId)
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
  if (MOCK) {
    mockBridgeCalls.push({ method, args })
    return mockResult(method, args)
  }
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

function readBookId(value) {
  if (!value || typeof value !== 'object') return null
  if (value.bookId !== undefined && value.bookId !== null) return value.bookId
  return value.bookInfo && value.bookInfo.id !== undefined ? value.bookInfo.id : null
}

function isBookSwitching(value) {
  return !!(
    value &&
    typeof value === 'object' &&
    (value.bookSwitching === true || value.switchInProgress === true)
  )
}

function contextEpochReached(observed, expected) {
  if (expected === undefined || expected === null) return true
  if (observed === undefined || observed === null) return false
  const observedNumber = Number(observed)
  const expectedNumber = Number(expected)
  if (Number.isFinite(observedNumber) && Number.isFinite(expectedNumber)) {
    return observedNumber >= expectedNumber
  }
  return String(observed) === String(expected)
}

function observedContextEpoch(page, state) {
  const stateEpoch = state && state.contextEpoch
  if (stateEpoch !== undefined && stateEpoch !== null) return stateEpoch
  return page && page.contextEpoch !== undefined ? page.contextEpoch : null
}

function isExpectedContextReady(page, state, minimumContextEpoch) {
  if (minimumContextEpoch === undefined || minimumContextEpoch === null) return true
  const observedEpochs = [page && page.contextEpoch, state && state.contextEpoch].filter(
    (value) => value !== undefined && value !== null
  )
  return (
    observedEpochs.length > 0 &&
    observedEpochs.every((epoch) => contextEpochReached(epoch, minimumContextEpoch))
  )
}

function readContentReadiness(page, state) {
  const readBoolean = (key) => {
    if (state && typeof state[key] === 'boolean') return state[key]
    if (page && typeof page[key] === 'boolean') return page[key]
    return undefined
  }
  return {
    contentReady: readBoolean('contentReady'),
    currentSlidePlaceholder: readBoolean('currentSlidePlaceholder'),
    emptyBook: readBoolean('emptyBook')
  }
}

function isExpectedContentReady(state, readiness, required) {
  if (!required) return true
  if (readiness.emptyBook === true || readiness.currentSlidePlaceholder === true) {
    return true
  }
  const currentSlideId = state && state.currentSlideId
  const hasCurrentSlide =
    currentSlideId !== undefined &&
    currentSlideId !== null &&
    String(currentSlideId).trim() !== ''
  return hasCurrentSlide && readiness.contentReady === true
}

function contentReadinessResult(readiness) {
  const result = {}
  for (const key of ['contentReady', 'currentSlidePlaceholder', 'emptyBook']) {
    if (typeof readiness[key] === 'boolean') result[key] = readiness[key]
  }
  return result
}

async function waitForBookReady(
  bookId,
  windowId,
  {
    initialInstanceId = null,
    minimumContextEpoch = null,
    requireContentReady = false,
    requireNewInstance = false
  } = {}
) {
  const deadline = Date.now() + BOOK_SWITCH_READY_TIMEOUT_MS
  let lastError = null
  let lastObservedBookId = null
  let lastObservedContextEpoch = null
  let lastObservedInstanceId = initialInstanceId
  let lastObservedSwitching = null
  let lastObservedReadiness = {
    contentReady: undefined,
    currentSlidePlaceholder: undefined,
    emptyBook: undefined
  }

  while (Date.now() < deadline) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now())
      const connection = await ensureConnected({
        windowId,
        timeoutMs: Math.min(1000, remainingMs),
        excludedInstanceId: requireNewInstance ? initialInstanceId : null
      })
      if (
        requireNewInstance &&
        initialInstanceId &&
        connection.instanceId === initialInstanceId
      ) {
        lastObservedInstanceId = connection.instanceId
        await closeActive()
        await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_MS))
        continue
      }
      const page = await rpcRequest(
        'ping',
        [],
        connection.instanceId,
        Math.max(1000, deadline - Date.now())
      )
      connection.page = page
      lastObservedInstanceId = connection.instanceId
      lastObservedBookId = readBookId(page)
      lastObservedContextEpoch = page && page.contextEpoch
      lastObservedSwitching = isBookSwitching(page)

      if (String(lastObservedBookId) === String(bookId) && !lastObservedSwitching) {
        const state = await rpcRequest(
          'getState',
          [],
          connection.instanceId,
          Math.max(1000, deadline - Date.now())
        )
        const stateBookId = readBookId(state)
        lastObservedBookId = stateBookId
        lastObservedContextEpoch = observedContextEpoch(page, state)
        lastObservedSwitching = isBookSwitching(page) || isBookSwitching(state)
        lastObservedReadiness = readContentReadiness(page, state)
        if (
          String(stateBookId) === String(bookId) &&
          !lastObservedSwitching &&
          isExpectedContextReady(page, state, minimumContextEpoch) &&
          isExpectedContentReady(state, lastObservedReadiness, requireContentReady)
        ) {
          return Object.assign(
            {
              ready: true,
              bridgeReady: true,
              instanceId: connection.instanceId,
              windowId: connection.windowId || windowId || null,
              currentSlideId: state.currentSlideId === undefined ? null : state.currentSlideId,
              instancePreserved:
                !!initialInstanceId && connection.instanceId === initialInstanceId
            },
            lastObservedContextEpoch === undefined || lastObservedContextEpoch === null
              ? {}
              : { contextEpoch: lastObservedContextEpoch },
            contentReadinessResult(lastObservedReadiness)
          )
        }
      }
    } catch (error) {
      lastError = error
      // 热切书期间优先保留当前实例和租约。只有实例确实失活（旧 Bridge 刷新路径）
      // 或 rpcRequest 已清空 active 时，才释放并按原 windowId 等待新实例。
      if (
        !active ||
        ['INSTANCE_STALE', 'INSTANCE_UNREGISTERED'].includes(error && error.code)
      ) {
        await closeActive()
      }
    }

    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, DISCOVERY_RETRY_MS))
    }
  }

  const observed =
    lastObservedBookId === undefined || lastObservedBookId === null
      ? '未发现可读取的书本'
      : `最后检测到书本 ${lastObservedBookId}`
  const detail = lastError && lastError.message ? `；${lastError.message}` : ''
  const epochDetail =
    minimumContextEpoch === undefined || minimumContextEpoch === null
      ? ''
      : `；上下文版本 ${lastObservedContextEpoch ?? '未上报'}/${minimumContextEpoch}`
  const switchingDetail = lastObservedSwitching ? '；书本仍在切换中' : ''
  const contentDetail = requireContentReady
    ? `；内容就绪=${lastObservedReadiness.contentReady ?? '未上报'}，占位目录=${lastObservedReadiness.currentSlidePlaceholder ?? '未上报'}，空书=${lastObservedReadiness.emptyBook ?? '未上报'}`
    : ''
  const instanceDetail = lastObservedInstanceId ? `；实例 ${lastObservedInstanceId}` : ''
  const newInstanceDetail =
    requireNewInstance &&
    (!lastObservedInstanceId || lastObservedInstanceId === initialInstanceId)
      ? '；尚未发现刷新后的新实例'
      : ''
  throw new RpcBridgeError(
    'BOOK_SWITCH_TIMEOUT',
    `等待目标书本 ${bookId} 加载就绪超时（${observed}${epochDetail}${switchingDetail}${contentDetail}${instanceDetail}${newInstanceDetail}${detail}）`
  )
}

export async function jumpToBook(args = {}) {
  const target = args.target || 'url'
  if (MOCK) {
    const result = await bridgeCall('jumpToBook', [args])
    return target === 'current'
      ? Object.assign(result, {
          ready: true,
          bridgeReady: true,
          instanceId: 'mock-instance',
          windowId: 'mock-window',
          currentSlideId: 'slide-1',
          contentReady: true,
          currentSlidePlaceholder: false,
          emptyBook: false,
          instancePreserved: true,
          durationMs: 0
        })
      : result
  }

  if (target !== 'current') return bridgeCall('jumpToBook', [args])

  const startedAt = Date.now()
  const connection = await ensureConnected()
  const windowId = connection.windowId || pinnedWindowId
  if (!windowId) {
    throw new RpcBridgeError(
      'WINDOW_ID_UNAVAILABLE',
      '当前编辑器没有稳定 windowId，无法安全等待同一窗口完成书本切换'
    )
  }

  // 导航命令不能使用 bridgeCall 的通用“实例失活后重试”策略，否则目标页加载后
  // 可能再次执行 jumpToBook。只发送一次，再通过只读 ping/getState 收敛最终状态。
  const result = await rpcRequest('jumpToBook', [args], connection.instanceId)
  const hotSwitchConfirmed = !!(result && result.hotSwitched === true)
  const reloadExpected = !!(
    result &&
    !hotSwitchConfirmed &&
    (result.reloadScheduled === true || result.scheduled === true)
  )
  // v1.8.2 会明确安排完整刷新，保留原有释放/重连路径；v1.9.0 热切成功不释放，
  // 继续在同一个 instanceId 上等待上下文版本收敛。
  if (reloadExpected) await closeActive()
  const ready = await waitForBookReady(args.bookId, windowId, {
    initialInstanceId: connection.instanceId,
    minimumContextEpoch: hotSwitchConfirmed ? result.contextEpoch : null,
    requireContentReady: hotSwitchConfirmed,
    requireNewInstance: reloadExpected
  })
  const navigationResult = { ...result }
  if (!hotSwitchConfirmed) {
    // 刷新结果里的 epoch/内容状态属于旧页面；只允许 waitForBookReady 观测到的
    // 新实例状态进入最终返回，避免把旧上下文伪装成新书就绪状态。
    delete navigationResult.contextEpoch
    delete navigationResult.contentReady
    delete navigationResult.currentSlidePlaceholder
    delete navigationResult.emptyBook
  }
  return Object.assign({}, navigationResult, ready, {
    durationMs: Date.now() - startedAt
  })
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

export async function uploadFile(args = {}) {
  const a = await resolveFileInput(args)
  return bridgeCall('uploadFile', [a])
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

function createMockQuestion(guid = 'mock-question-guid-1') {
  return {
    guid: String(guid),
    parentGuid: null,
    title: '示例题目 ' + guid,
    stemHtml: '<p>示例题目 ' + guid + '</p>',
    stemText: '示例题目 ' + guid,
    modelId: 1,
    modelName: '单选题',
    subModelId: 1,
    difficulty: 2,
    options: [
      { key: 'A', content: '选项 A' },
      { key: 'B', content: '选项 B' }
    ],
    answers: ['A'],
    solution: '<p>A</p>',
    analysis: '<p>示例解析</p>',
    review: '',
    tags: [],
    features: [],
    hasChildren: false,
    children: [],
    hasAnswer: true,
    hasSolution: true,
    hasAnalysis: true,
    explainIds: [901],
    hasExplanation: true,
    hasImages: false,
    hasFormula: false
  }
}

function normalizeMockQuestionGuids(guids) {
  const requestedGuids = (Array.isArray(guids) ? guids : [])
    .map((guid) => String(guid === undefined || guid === null ? '' : guid).trim())
    .filter(Boolean)
  const uniqueGuids = [...new Set(requestedGuids)]
  return {
    requestedGuids,
    uniqueGuids,
    duplicateGuids: [
      ...new Set(
        requestedGuids.filter(
          (guid, index) => requestedGuids.indexOf(guid) !== index
        )
      )
    ]
  }
}

function getMockTextTarget(arg = {}) {
  if (arg.target && typeof arg.target === 'object') return { ...arg.target }
  return { kind: 'element', elementId: String(arg.elementId || '') }
}

function getMockTextIdentity(arg = {}) {
  const target = getMockTextTarget(arg)
  const ownerId =
    target.kind === 'element'
      ? target.elementId
      : target.kind === 'tableCell'
        ? target.tableId
        : target.mindId
  return {
    elementId: ownerId === undefined || ownerId === null ? null : String(ownerId),
    target,
    targetKind: target.kind,
    layoutOwner:
      target.kind === 'element' ? 'text' : target.kind === 'tableCell' ? 'table' : 'mind',
    standaloneLayoutSupported: target.kind === 'element'
  }
}

function getMockNestedTextMutationLayout(arg = {}) {
  if (getMockTextTarget(arg).kind === 'element') return {}
  const reflowRequested = arg.fitSize !== false
  return {
    extendType: null,
    width: null,
    height: null,
    dWidth: null,
    dHeight: null,
    autoResized: null,
    rendered: true,
    settled: !reflowRequested,
    deferredLayout: reflowRequested,
    reflowRequested,
    moved: []
  }
}

function mockResult(method, args = []) {
  const arg = (args && args[0]) || {}
  switch (method) {
    case 'ping':
      return {
        version: '1.12.0',
        editorType: 'content-editor',
        bookId: 'mock-book',
        mode: 'ai-control',
        contextEpoch: 1,
        bookSwitching: false
      }
    case 'getSemanticSnapshot': {
      if (MOCK_SEMANTIC_SNAPSHOT_UNSUPPORTED) {
        const error = new Error('__superEditor.getSemanticSnapshot 不存在')
        error.code = 'RPC_ERROR'
        throw error
      }
      const catalogId = String(arg.slideId || 'slide-1')
      const targetIsCurrent = catalogId === 'slide-1'
      const richTextDetail = arg.richText || 'deep'
      const richTextDocument = {
        target: { kind: 'element', elementId: 'text-1' },
        elementId: 'text-1',
        blockId: 'block-1',
        plainText: '示例文本',
        contentHash: 'mock-text-hash-1',
        htmlHash: 'mock-html-hash-1',
        hyperlinkMetadataHash: 'mock-link-hash-1',
        defaultStyle: { fontChinese: '思源黑体 CN', fontSize: 16, color: '#333333' },
        layout: { extendType: 'both', width: 200, height: 50 }
      }
      if (richTextDetail === 'deep') {
        Object.assign(richTextDocument, {
          content: '<p>示例文本</p>',
          canonicalHtml: '<p>示例文本</p>',
          paragraphs: [{ index: 0, start: 0, length: 4, text: '示例文本' }],
          runs: [{ start: 0, length: 4, text: '示例文本', formats: { bold: true } }],
          embeds: [],
          hyperlinks: []
        })
      }
      const block = {
        id: 301,
        uuid: 'block-1',
        template_type: 2,
        template_data_content: {
          name: '知识讲解',
          width: 794,
          height: 300,
          elements: [
            {
              id: 'text-1',
              sourceId: 'source-text-1',
              name: '正文',
              type: 'text',
              templateId: 'block-1',
              groupId: 0,
              left: 75,
              top: 20,
              width: 200,
              height: 50,
              rotate: 0,
              content: '<p>示例文本</p>'
            }
          ]
        }
      }
      const semanticSnapshotPayload = {
        schemaVersion: '1.0',
        snapshot: {
          identity: {
            bookId: 'mock-book',
            bookInfo: {
              id: 'mock-book',
              name: '示例语文学霸笔记',
              subject_list: [{ id: 3, name: '语文' }],
              grade_id: 3,
              volume: 1
            },
            catalogId,
            catalogName: arg.slideId ? `目录 ${catalogId}` : '第 1 页',
            catalogSort: 1,
            currentSlideId: 'slide-1',
            contextEpoch: 1,
            targetIsCurrent
          },
          state: {
            source: targetIsCurrent ? 'working' : 'persisted',
            dirty: targetIsCurrent ? mockDirty : false,
            contentReady: true,
            capturedBookId: 'mock-book',
            contextEpoch: 1
          },
          slide: { id: catalogId, name: arg.slideId ? `目录 ${catalogId}` : '第 1 页', sort: 1 },
          blocks: [block],
          elementIndex: [
            {
              elementId: 'text-1',
              sourceId: 'source-text-1',
              type: 'text',
              name: '正文',
              blockId: 'block-1',
              blockDatabaseId: 301,
              path: [0],
              groupId: 0,
              groupPath: [],
              geometry: { left: 75, top: 20, width: 200, height: 50, rotate: 0 }
            }
          ],
          outline: {
            tree: [
              {
                id: 'outline-1',
                outline_name: '学习目标',
                content_uuids: ['block-1'],
                children: []
              }
            ],
            selectedOutlineId: null,
            anchors: []
          },
          digitalModules: {
            includeRaw: true,
            items: [
              {
                elementId: 'button-1',
                blockId: 'block-1',
                blockDatabaseId: 301,
                normalized: {
                  relationId: 'mock-relation-1',
                  modelId: 991,
                  type: 84,
                  typeName: '打印',
                  name: '打印'
                },
                raw: {
                  control_id: 'button-1',
                  hypermedia_content_id: 301,
                  model_id: 991,
                  catalog_model_resp_en: { id: 991, type: 84, name: '打印' },
                  model_content_resp_en: []
                }
              }
            ]
          },
          richText: {
            detail: richTextDetail,
            items: richTextDetail === 'none' ? [] : [richTextDocument]
          },
          fonts: {
            source: targetIsCurrent ? 'current-editor' : 'book-font-configuration',
            items: [{ label: '思源黑体 CN', value: '思源黑体 CN', available: true }]
          },
          completeness: {
            complete: !MOCK_SEMANTIC_SNAPSHOT_INCOMPLETE,
            sections: {
              blocks: true,
              elementIndex: true,
              outline: true,
              outlineAnchors: true,
              digitalModules: true,
              digitalModulesRaw: true,
              richText: !MOCK_SEMANTIC_SNAPSHOT_INCOMPLETE,
              fonts: true,
              contentReady: true
            },
            warnings: MOCK_SEMANTIC_SNAPSHOT_INCOMPLETE
              ? [
                  {
                    code: 'MOCK_SECTION_INCOMPLETE',
                    section: 'richText',
                    message: 'mock semantic snapshot 富文本读取不完整'
                  }
                ]
              : []
          }
        },
        meta: {
          blockCount: 1,
          elementCount: 1,
          outlineCount: 1,
          digitalModuleCount: 1,
          richTextTargetCount: richTextDetail === 'none' ? 0 : 1
        }
      }
      semanticSnapshotPayload.stableHash =
        calculateSemanticSnapshotStableHash(semanticSnapshotPayload)
      return semanticSnapshotPayload
    }
    case 'getMockCallLog':
      return mockBridgeCalls
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
        editorUrl: `https://mock.example.com/#/content-editor?book_id=${bookId}&ai_control=1`
      }
    }
    case 'jumpToBook':
      return {
        bookId: arg.bookId,
        url: `https://mock.example.com/#/content-editor?book_id=${arg.bookId}&ai_control=1`,
        target: arg.target || 'url',
        scheduled: false,
        hotSwitched: arg.target === 'current',
        reloadScheduled: false,
        contextEpoch: arg.target === 'current' ? 2 : undefined,
        opened: arg.target === 'new'
      }
    case 'getBookManifest':
      return {
        bookId: 'mock-book',
        scope: arg.scope || 'current',
        detail: arg.detail || 'summary',
        currentSlideId: arg.slideId || 'slide-1',
        pages: [
          {
            id: arg.slideId || 'slide-1',
            name: '第 1 页',
            blockCount: 1,
            elementCount: 1,
            textPreview: arg.include && arg.include.textPreview ? '示例文本' : undefined
          }
        ],
        pagination: {
          pageNo: arg.pageNo || 0,
          pageSize: arg.pageSize || (arg.scope === 'book' ? 40 : 1),
          totalSlides: 1,
          returnedSlides: 1,
          hasMore: false
        },
        stats: { loadedSlides: 1, blockCount: 1, elementCount: 1, textTargetCount: 1 },
        contentHash: 'mock-book-hash-1',
        warnings: []
      }
    case 'searchBookContent': {
      const pageNo = arg.pageNo ?? 0
      const pageSize = arg.pageSize ?? (arg.scope === 'book' ? 40 : 1)
      const totalSlides = arg.scope === 'book' ? 100 : 1
      return {
        query: arg.query,
        scope: arg.scope || 'current',
        targetKinds: arg.targetKinds || ['element', 'tableCell', 'mindNode'],
        searchedSlides: 1,
        totalSlides,
        searchedTargets: 1,
        pagination: {
          pageNo,
          pageSize,
          totalSlides,
          returnedSlides: 1,
          hasMore: (pageNo + 1) * pageSize < totalSlides,
          nextPageNo: (pageNo + 1) * pageSize < totalSlides ? pageNo + 1 : null
        },
        items: [
          {
            slideId: arg.slideId || 'slide-1',
            target: { kind: 'element', elementId: 'el-1' },
            text: `包含 ${arg.query} 的示例文本`
          }
        ],
        total: 1,
        truncated: false,
        warnings: []
      }
    }
    case 'saveVerified': {
      mockDirty = false
      const contentHash = arg.expectedContentHash || 'mock-slide-hash-1'
      return {
        scope: arg.scope || 'current',
        saved: true,
        savedScope: 'current',
        savedSlides: [arg.expectedSlideId || 'slide-1'],
        verified: arg.verify !== false,
        verifiedScope: arg.verify === false ? null : 'current',
        slideId: arg.expectedSlideId || 'slide-1',
        dirty: false,
        contentHash,
        persistedContentHash: contentHash,
        authoringContentHash: 'mock-authoring-hash-1',
        persistedAuthoringContentHash: 'mock-authoring-hash-1',
        normalizationOnly: false,
        reconciled: false,
        reloadedContentHash: null,
        businessDiffPaths: [],
        warnings: [],
        ...(arg.scope === 'book'
          ? {
              bookManifestChecked: true,
              bookManifestComplete: true,
              bookManifestPageCount: 1,
              bookCheckedSlides: 1,
              bookContentHash: 'mock-book-hash-1'
            }
          : {})
      }
    }
    case 'listBookVersions':
      return {
        scope: arg.scope || 'current',
        slideId: arg.slideId || 'slide-1',
        versions: [{ id: 'version-1', name: '版本 1', createdAt: '2026-01-01T00:00:00.000Z' }],
        pages: [
          {
            slideId: arg.slideId || 'slide-1',
            versions: [{ id: 'version-1', name: '版本 1' }]
          }
        ],
        pageNo: arg.pageNo || 0,
        pageSize: arg.pageSize || 20,
        versionPageNo: arg.scope === 'book' ? arg.versionPageNo || 0 : arg.pageNo || 0,
        versionPageSize: arg.scope === 'book' ? arg.versionPageSize || 20 : arg.pageSize || 20,
        totalVersions: 1
      }
    case 'getBookVersion':
      return {
        scope: arg.scope || 'current',
        slideId: arg.slideId || 'slide-1',
        versionId: arg.versionId,
        contentHash: 'mock-version-hash-1',
        blocks: []
      }
    case 'restoreBookVersion':
      return arg.validateOnly === true
        ? {
            scope: arg.scope || 'current',
            slideId: arg.slideId || 'slide-1',
            versionId: arg.versionId,
            canRestore: true,
            reasons: []
          }
        : {
            scope: arg.scope || 'current',
            slideId: arg.slideId || 'slide-1',
            versionId: arg.versionId,
            restored: true
          }
    case 'planQuestionLesson':
      return {
        scope: arg.scope || 'current',
        detail: arg.detail || 'summary',
        layout: arg.layout || 'auto',
        guids: arg.guids || [],
        styleReference: arg.styleReference || null,
        sections: [{ role: 'practice', questionGuids: arg.guids || [] }]
      }
    case 'renderQuestionsToBlock':
      return arg.validateOnly === true
        ? {
            slideId: arg.slideId || 'slide-1',
            block: { requestedBlockId: arg.blockId || null, verified: true },
            mode: arg.mode || 'append',
            valid: true,
            validateOnly: true,
            rendered: false,
            questionGuids: arg.guids || (arg.plan && arg.plan.guids) || []
          }
        : {
            slideId: arg.slideId || 'slide-1',
            blockId: arg.blockId || 'mock-question-block-1',
            mode: arg.mode || 'append',
            validateOnly: false,
            rendered: true,
            questionGuids: arg.guids || (arg.plan && arg.plan.guids) || []
          }
    case 'auditContent': {
      const scope = arg.scope === 'book' ? 'book' : 'current'
      const allSlideIds =
        Array.isArray(arg.slideIds) && arg.slideIds.length
          ? arg.slideIds.map((slideId) => String(slideId))
          : [String(arg.slideId || 'slide-1')]
      const cursor = scope === 'book' && Number.isInteger(arg.cursor) ? arg.cursor : 0
      const limit =
        scope === 'book' && Number.isInteger(arg.limit) ? Math.min(arg.limit, 100) : 1
      const selectedIds = allSlideIds.slice(cursor, cursor + limit)
      const slides = selectedIds.map((slideId) => ({
        slideId,
        sourceHash: `mock-audit-hash-${slideId}`,
        issueCount: 0,
        severityCounts: { error: 0, warning: 0, info: 0 },
        issues: []
      }))
      return {
        scope,
        cursor,
        limit,
        scannedSlides: selectedIds.length,
        totalSlides: allSlideIds.length,
        nextCursor:
          cursor + selectedIds.length < allSlideIds.length
            ? cursor + selectedIds.length
            : null,
        issueCount: 0,
        sourceHashes: slides.map((slide) => ({
          slideId: slide.slideId,
          hash: slide.sourceHash
        })),
        issues: [],
        slides
      }
    }
    case 'searchTemplates':
      return [
        {
          id: arg.kind === 'block' ? 'block-template-1' : 'chapter-template-1',
          name: arg.kind === 'block' ? '示例区块模板' : '示例样章模板',
          type: arg.kind === 'block' ? 2 : 3,
          kind: arg.kind === 'block' ? 'block' : 'chapter',
          scope: arg.scope || 'book',
          suitType:
            arg.interactionType === 'interface'
              ? 2
              : arg.interactionType === 'hypermedia'
                ? 1
                : null,
          interactionType: arg.interactionType || null,
          parentId: null,
          classifyId: null,
          classifyIds: [],
          cover: 'https://mock.example.com/template.png',
          updatedAt: null
        }
      ]
    case 'getTemplateDetail':
      return {
        id: arg.templateId,
        name: '示例模板',
        type: 3,
        kind: 'chapter',
        suitType: 2,
        interactionType: 'interface',
        bookId: null,
        parentId: null,
        classifyIds: [],
        cover: 'https://mock.example.com/template.png',
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
        bookId: 'mock-book',
        bookInfo: { id: 'mock-book', name: '示例课件（MOCK）' },
        contextEpoch: 1,
        bookSwitching: false,
        contentReady: true,
        currentSlidePlaceholder: false,
        emptyBook: false,
        slides: [
          { id: 'slide-1', name: '第 1 页', pageId: null },
          { id: 'slide-2', name: '第 2 页', pageId: null }
        ],
        currentSlideId: 'slide-1',
        selection: [],
        dirty: mockDirty
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
    case 'updateElement': {
      const protectedTextFields = new Set([
        'content',
        'hyperlinkParamList',
        'wordCount',
        'letterCount',
        'spaceCount'
      ])
      const blocked =
        String(arg.elementId || '').startsWith('text-') &&
        Object.keys(arg.patch || {}).some((key) => protectedTextFields.has(key))
      if (blocked) {
        const error = new Error('文本内容和链接元数据必须使用 editor_text_* 专用工具')
        error.code = 'TEXT_SPECIALIZED_UPDATE_REQUIRED'
        throw error
      }
      return null
    }
    case 'groupElements':
      return { groupId: 'mock-group-' + Date.now() }
    case 'selectSlide': {
      const payload =
        arg && typeof arg === 'object' && !Array.isArray(arg) ? arg : { slideId: arg }
      const slideId = String(payload.slideId)
      const previousSlideId = 'slide-1'
      const changed = slideId !== previousSlideId
      const dirtyBefore = changed && mockDirty
      let dirtyAction = 'none'
      if (dirtyBefore) {
        if (payload.saveBeforeSwitch) dirtyAction = 'saved'
        else if (payload.discardChanges) dirtyAction = 'discarded'
        else throw new Error('当前页面有未保存改动；请先保存或明确丢弃')
        mockDirty = false
      }
      return {
        slideId,
        previousSlideId,
        changed,
        dirtyBefore,
        dirtyAction
      }
    }
    case 'addSlide':
    case 'deleteSlide':
    case 'moveSlide':
    case 'updateBlock':
    case 'deleteBlock':
    case 'moveBlock':
    case 'deleteElement':
    case 'resizeElement':
    case 'rotateElement':
    case 'duplicateElement':
    case 'orderElement':
    case 'ungroup':
    case 'undo':
    case 'redo':
    case 'save':
      return null
    case 'moveElement':
      return {
        elementCount: 1,
        x: arg.x,
        y: arg.y,
        dx: 0,
        dy: 0,
        coordinateSpace: 'block'
      }
    case 'moveElements':
      return {
        elementCount: (arg.elementIds || []).length,
        x: arg.x,
        y: arg.y,
        dx: 0,
        dy: 0,
        coordinateSpace: 'block'
      }
    case 'moveElementsByOffset':
      return {
        elementCount: (arg.elementIds || []).length,
        dx: arg.dx || 0,
        dy: arg.dy || 0,
        coordinateSpace: 'block'
      }
    case 'alignElements':
      return {
        align: arg.align,
        target: arg.target || 'selection',
        elementCount: (arg.elementIds || []).length,
        coordinateSpace:
          arg.coordinateSpace || (arg.target === 'page' ? 'page' : 'block')
      }
    case 'setElementSpacing':
      return {
        direction: arg.direction,
        spacing: arg.spacing,
        elementCount: (arg.elementIds || []).length,
        coordinateSpace: 'block'
      }
    case 'centerElementInBlock':
      return {
        elementId: String(arg.elementId),
        blockId: 'block-1',
        axis: arg.axis || 'both',
        coordinateSpace: 'block'
      }
    case 'getElementsBounds': {
      const options = (args && args[1]) || {}
      return {
        minX: 10,
        minY: 20,
        maxX: 210,
        maxY: 120,
        width: 200,
        height: 100,
        centerX: 110,
        centerY: 70,
        coordinateSpace: options.coordinateSpace || 'block'
      }
    }
    case 'getCanvasInfo':
      return {
        slideId: 'slide-1',
        canvasWidth: 794,
        canvasHeight: 1123,
        scale: 1,
        viewportLeft: 0,
        viewportTop: 0,
        stats: { blockCount: 1, elementCount: 1, typeCounts: { text: 1 } }
      }
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
        ...getMockTextIdentity(arg),
        blockId: 'block-1',
        content: '<p>示例文本</p>',
        text: '示例文本',
        wordCount: 4,
        font: { size: 16, name: '思源黑体 CN', weight: 400, color: '#333333' },
        lineHeight: 1.6,
        maxWidth: 700,
        maxHeight: null,
        background: { type: 'color', extendType: 'both' },
        geometry:
          getMockTextTarget(arg).kind === 'element'
            ? { left: 75, top: 20, width: 200, height: 50 }
            : null,
        groupId: 0
      }
    case 'setTextContent':
      return {
        ...getMockTextIdentity(arg),
        content: String(arg.content || ''),
        text: String(arg.content || ''),
        plainText: String(arg.content || ''),
        displayText: String(arg.content || ''),
        indexText: String(arg.content || ''),
        dryRun: arg.dryRun === true,
        changed: true,
        expectedContentHash: arg.expectedContentHash,
        previousContentHash: 'mock-text-hash-1',
        contentHash: 'mock-text-hash-2',
        extendType: 'both',
        width: arg.dryRun === true ? undefined : 260,
        height: arg.dryRun === true ? undefined : 50,
        dWidth: arg.dryRun === true ? undefined : 60,
        dHeight: arg.dryRun === true ? undefined : 0,
        autoResized: arg.dryRun === true ? undefined : true,
        moved: arg.dryRun === true ? undefined : [],
        ...getMockNestedTextMutationLayout(arg)
      }
    case 'setTextAdaptive':
      return { elementId: arg.elementId, extendType: arg.extendType, previous: 'both', waitMs: arg.waitMs, width: 200, height: 50, dWidth: 0, dHeight: 0, autoResized: false, moved: [] }
    case 'fitTextSize':
      return { elementId: arg.elementId, width: 200, height: 50, dWidth: 0, dHeight: 0, autoResized: false, moved: [] }
    case 'getTextDocument':
      return {
        ...getMockTextIdentity(arg),
        blockId: 'block-1',
        contentHash: 'mock-text-hash-1',
        content: '<p>示例文本</p>',
        html: '<p>示例文本</p>',
        canonicalHtml: '<p>示例文本</p>',
        plainText: '示例文本',
        displayText: '示例文本',
        displayLength: 4,
        indexText: '示例文本',
        displayIndexMap: [
          {
            type: 'text',
            indexStart: 0,
            indexEnd: 4,
            indexLength: 4,
            displayStart: 0,
            displayEnd: 4,
            displayLength: 4,
            displayText: '示例文本'
          }
        ],
        length: 4,
        indexUnit: 'utf16-code-unit',
        indexModel: 'quill',
        terminalNewline: true,
        canonicalized: true,
        roundTripSafe: true,
        roundTripWarnings: [],
        paragraphs: arg.includeParagraphs === false
          ? undefined
          : [{ index: 0, start: 0, length: 4, text: '示例文本', formats: { align: 'left' } }],
        runs: arg.includeRuns === false
          ? undefined
          : [{ start: 0, length: 4, text: '示例文本', formats: { bold: true } }],
        embeds: arg.includeEmbeds === false ? undefined : [],
        hyperlinks: [],
        orphanedHyperlinkMetadata: [],
        defaultStyle: {
          fontChinese: '思源黑体 CN',
          fontEnglish: 'Arial',
          fontNumber: 'Arial',
          fontSize: 16,
          color: '#333333'
        },
        layout: {
          extendType: 'both',
          textAlign: 'left',
          verticalAlign: 'top',
          width: 200,
          height: 50
        },
        geometry:
          getMockTextTarget(arg).kind === 'element'
            ? { left: 75, top: 20, width: 200, height: 50 }
            : null
      }
    case 'editText': {
      const index = Number.isInteger(arg.index) ? arg.index : 0
      const insertedText = arg.text !== undefined ? String(arg.text) : String(arg.html || '')
      return {
        ...getMockTextIdentity(arg),
        action: arg.action,
        dryRun: arg.dryRun === true,
        changed: arg.dryRun !== true,
        changes: [{ index, length: arg.length || 0, replacement: insertedText }],
        beforeHash: 'mock-text-hash-1',
        previousContentHash: 'mock-text-hash-1',
        contentHash: arg.dryRun === true ? 'mock-text-hash-1' : 'mock-text-hash-2',
        plainText: '示例文本',
        content: '<p>示例文本</p>',
        canonical: true,
        indexUnit: 'utf16-code-unit',
        indexModel: 'quill',
        width: 200,
        height: 50,
        moved: [],
        ...getMockNestedTextMutationLayout(arg)
      }
    }
    case 'setTextLink': {
      const hyperlinkId =
        arg.hyperlinkId ||
        (arg.hyperlink && (arg.hyperlink.hyperlink_id || arg.hyperlink.hyperlinkId)) ||
        'mock-link-1'
      return {
        ...getMockTextIdentity(arg),
        changed: arg.dryRun !== true,
        dryRun: arg.dryRun === true,
        range: { index: arg.index, length: arg.length },
        hyperlinkId,
        hyperlink: {
          ...(arg.hyperlink || {}),
          hyperlink_id: hyperlinkId
        },
        previousContentHash: 'mock-text-hash-1',
        contentHash: arg.dryRun === true ? 'mock-text-hash-1' : 'mock-text-hash-2',
        plainText: '示例文本',
        content: '<p>示例文本</p>',
        ...getMockNestedTextMutationLayout(arg)
      }
    }
    case 'removeTextLink':
      return {
        ...getMockTextIdentity(arg),
        changed: arg.dryRun !== true,
        dryRun: arg.dryRun === true,
        ranges: arg.hyperlinkId
          ? [{ index: 0, length: 2 }]
          : [{ index: arg.index, length: arg.length }],
        hyperlinkId: arg.hyperlinkId || null,
        previousContentHash: 'mock-text-hash-1',
        contentHash: arg.dryRun === true ? 'mock-text-hash-1' : 'mock-text-hash-2',
        plainText: '示例文本',
        content: '<p>示例文本</p>',
        ...getMockNestedTextMutationLayout(arg)
      }
    case 'editTextEmbed':
      return {
        ...getMockTextIdentity(arg),
        action: arg.action,
        changed: arg.dryRun !== true,
        dryRun: arg.dryRun === true,
        index: arg.index,
        embedType: arg.embedType || 'image',
        value: arg.action === 'delete' ? null : arg.value,
        previousContentHash: 'mock-text-hash-1',
        contentHash: arg.dryRun === true ? 'mock-text-hash-1' : 'mock-text-hash-2',
        plainText: '示例文本',
        content: '<p>示例文本</p>',
        embeds:
          arg.action === 'delete'
            ? []
            : [{ start: arg.index, length: 1, type: arg.embedType || 'image', value: arg.value }],
        ...getMockNestedTextMutationLayout(arg)
      }
    case 'formatText':
      return {
        ...getMockTextIdentity(arg),
        scope: arg.scope,
        appliedFormats: arg.formats,
        dryRun: arg.dryRun === true,
        changed: arg.dryRun !== true,
        expectedContentHash: arg.expectedContentHash,
        ranges: [{ index: arg.index || 0, length: arg.length || 4 }],
        beforeHash: 'mock-text-hash-1',
        previousContentHash: 'mock-text-hash-1',
        contentHash: arg.dryRun === true ? 'mock-text-hash-1' : 'mock-text-hash-2',
        content: '<p>示例文本</p>',
        canonical: true,
        width: 200,
        height: 50,
        moved: [],
        ...getMockNestedTextMutationLayout(arg)
      }
    case 'setTextLayout':
      return {
        elementId: arg.elementId,
        before: { extendType: 'both', padding: { left: 0, right: 0, top: 0, bottom: 0 } },
        layout: {
          extendType: arg.layout.extendType || 'both',
          overflowType:
            arg.layout.overflowType === undefined
              ? ['auto', 'overWithBreak']
              : arg.layout.overflowType,
          padding: {
            left: arg.layout.paddingLeft || 0,
            right: arg.layout.paddingRight || 0,
            top: arg.layout.paddingTop || 0,
            bottom: arg.layout.paddingBottom || 0
          },
          fill:
            arg.layout.fill === undefined
              ? { enabled: true, color: null }
              : arg.layout.fill
        },
        geometry: { left: 75, top: 20, width: 200, height: 50 },
        changedKeys: Object.keys(arg.layout || {}),
        width: 200,
        height: 50,
        dWidth: 0,
        dHeight: 0,
        rendered: true,
        settled: true,
        deferredLayout: false,
        moved: []
      }
    case 'inspectTextLayout':
      return {
        elementId: arg.elementId,
        rendered: true,
        measurement: {
          clientWidth: 200,
          clientHeight: 50,
          contentWidth: 64,
          contentHeight: 26,
          overflowX: false,
          overflowY: false,
          overflow: false
        },
        geometry: { left: 75, top: 20, width: 200, height: 50 },
        overflow: false,
        clipped: false,
        needResetSize: false,
        fontNames: ['思源黑体 CN'],
        extendType: 'both',
        overflowType: null,
        paragraphCount: 1,
        runCount: 1,
        embedCount: 0,
        textLength: 4,
        defaultStyle: { fontChinese: '思源黑体 CN', fontSize: 16 },
        warnings: []
      }
    case 'fitTextToBox': {
      if (
        arg.expectedContentHash &&
        arg.expectedContentHash !== 'mock-text-hash-1'
      ) {
        const error = new Error('文本内容已变化，请重新读取后再缩小字号')
        error.code = 'TEXT_CONTENT_CONFLICT'
        error.expectedContentHash = arg.expectedContentHash
        error.actualContentHash = 'mock-text-hash-1'
        throw error
      }
      const hasMixedSizes = arg.elementId === 'text-mixed-sizes'
      if (hasMixedSizes && arg.allowUniformizeMixedSizes !== true) {
        return {
          elementId: arg.elementId,
          applied: false,
          fitted: false,
          reason: 'mixed-font-sizes',
          fontSizes: [14, 20],
          invalidFontSizes: [],
          requiresExplicitUniformization: true,
          uniformizedMixedSizes: false,
          contentHash: 'mock-text-hash-1'
        }
      }
      return {
        elementId: arg.elementId,
        applied: true,
        fitted: true,
        overflow: false,
        previousFontSize: 20,
        fontSize: Math.min(Number(arg.maxFontSize) || 16, 16),
        inspectionBefore: { measurement: { overflow: true } },
        inspectionAfter: { measurement: { overflow: false } },
        fits: true,
        attempts: 3,
        reachedMinimum: false,
        conservativeSinglePass: true,
        uniformizedMixedSizes: hasMixedSizes && arg.allowUniformizeMixedSizes === true,
        contentHash: 'mock-text-hash-2'
      }
    }
    case 'searchTextElements': {
      const targetKinds = arg.targetKinds || ['element', 'tableCell', 'mindNode']
      const examples = {
        element: { kind: 'element', elementId: 'el-1' },
        tableCell: { kind: 'tableCell', tableId: 'table-1', cellId: 'cell-1' },
        mindNode: { kind: 'mindNode', mindId: 'mind-1', nodeId: 'node-1' }
      }
      const query = String(arg.query || '')
      const matches = targetKinds.map((kind) => {
        const identity = getMockTextIdentity({ target: examples[kind] })
        return {
          ...identity,
          elementName: kind === 'element' ? '示例文本' : kind === 'tableCell' ? '示例表格' : '示例思维导图',
          blockId: 'block-1',
          text: '示例文本',
          snippet: '示例文本',
          snippetStart: 0,
          index: 0,
          length: query.length,
          displayIndex: 0,
          displayLength: query.length,
          paragraphIndex: 0,
          contentHash: 'mock-text-hash-1'
        }
      })
      return {
        query,
        scope: arg.blockId ? 'block' : 'current-slide',
        blockId: arg.blockId || null,
        targetKinds,
        searchedTargets: matches.length,
        searchedElements: matches.length,
        total: matches.length,
        truncated: false,
        warnings: [],
        ranges: matches,
        items: matches.map((match) => ({
          elementId: match.elementId,
          target: match.target,
          targetKind: match.targetKind,
          layoutOwner: match.layoutOwner,
          standaloneLayoutSupported: match.standaloneLayoutSupported,
          elementName: match.elementName,
          blockId: match.blockId,
          contentHash: match.contentHash,
          ranges: [
            {
              index: match.index,
              length: match.length,
              displayIndex: match.displayIndex,
              displayLength: match.displayLength,
              text: match.text,
              paragraphIndex: match.paragraphIndex,
              snippet: match.snippet,
              snippetStart: match.snippetStart
            }
          ]
        })),
        matches
      }
    }
    case 'copyTextStyle': {
      const sourceTarget = getMockTextTarget({
        elementId: arg.sourceElementId,
        target: arg.sourceTarget
      })
      const targetTargets = arg.targetTargets ||
        (arg.targetElementIds || []).map((elementId) => ({ kind: 'element', elementId }))
      return {
        sourceElementId: getMockTextIdentity({ target: sourceTarget }).elementId,
        sourceTarget,
        targetElementIds: targetTargets
          .filter((target) => target.kind === 'element')
          .map((target) => target.elementId),
        targetTargets,
        scope: arg.scope || 'default',
        copied: targetTargets,
        results: targetTargets.map((target) => ({
          ...getMockTextIdentity({ target }),
          fitted: target.kind === 'element' ? { width: 200, height: 50, settled: true } : null
        }))
      }
    }
    case 'listTextFonts': {
      const language = arg.language || 'all'
      const fonts = [
        {
          label: '思源黑体 CN',
          value: '思源黑体 CN',
          languages: ['chinese'],
          source: 'system',
          available: true
        },
        {
          label: 'Arial',
          value: 'Arial',
          languages: ['english', 'number'],
          source: 'system',
          available: true
        }
      ]
      return {
        language,
        items:
          language === 'all'
            ? fonts
            : fonts.filter((font) => font.languages.includes(language))
      }
    }
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
    case 'uploadFile': {
      const fileName = String(arg.fileName || 'ai-file.bin')
      return {
        url: 'https://mock.example.com/upload/' + encodeURIComponent(fileName),
        fileId: 'mock-file-' + Date.now(),
        fileName,
        mimeType: String(arg.mimeType || 'application/octet-stream')
      }
    }
    case 'listDigitalModuleTypes':
      return [
        { type: 81, key: 'jump', name: '跳转', supported: true },
        { type: 85, key: 'timer', name: '计时器', supported: true },
        { type: 77, key: 'audio', name: '音频', supported: true },
        { type: 78, key: 'video', name: '视频', supported: true }
      ].filter((item) => arg.type === undefined || String(item.type) === String(arg.type))
    case 'getDigitalModule':
      return {
        id: 'mock-relation-1',
        relationId: 'mock-relation-1',
        modelId: 'mock-model-1',
        elementId: String(arg.elementId || 'el-1'),
        type: 81,
        typeName: '跳转',
        name: '示例网页跳转',
        config: { url: 'https://example.com' }
      }
    case 'listDigitalModules': {
      const elementIds = Array.isArray(arg.elementIds) && arg.elementIds.length
        ? arg.elementIds
        : ['el-1']
      return elementIds.map((elementId, index) => ({
        id: 'mock-relation-' + (index + 1),
        relationId: 'mock-relation-' + (index + 1),
        modelId: 'mock-model-' + (index + 1),
        elementId: String(elementId),
        type: arg.type === undefined ? 81 : Number(arg.type),
        typeName: arg.type === undefined || Number(arg.type) === 81 ? '跳转' : '数字模块',
        name: '示例数字模块',
        config: { url: 'https://example.com' }
      }))
    }
    case 'createDigitalModule':
      return {
        created: !arg.validateOnly,
        validated: true,
        relationId: arg.validateOnly ? null : 'mock-relation-' + Date.now(),
        modelId: arg.validateOnly ? null : 'mock-model-' + Date.now(),
        elementId: String(arg.elementId || ''),
        type: arg.type,
        name: arg.name || '数字模块',
        config: arg.config || {}
      }
    case 'updateDigitalModule':
      return {
        updated: !arg.validateOnly,
        validated: true,
        relationId: 'mock-relation-1',
        modelId: 'mock-model-1',
        elementId: String(arg.elementId || ''),
        type: arg.type === undefined ? 81 : arg.type,
        name: arg.name || '示例数字模块',
        config: arg.config || {}
      }
    case 'deleteDigitalModule':
      return {
        deleted: true,
        elementId: String(arg.elementId || ''),
        relationId: 'mock-relation-1',
        modelId: 'mock-model-1'
      }
    case 'copyDigitalModule':
      return {
        copied: true,
        sharedModel: true,
        sourceElementId: arg.sourceElementId || null,
        targetElementId: String(arg.targetElementId || ''),
        relationId: 'mock-relation-' + Date.now(),
        modelId: arg.modelId || 'mock-model-1'
      }
    case 'listQuestionPaths': {
      const child = {
        id: 'mock-path-2',
        name: '第一节 示例知识点',
        parentId: 'mock-path-1',
        depth: 1,
        pathName: '第一章 示例章节 / 第一节 示例知识点',
        bookId: arg.bookId || 'mock-book'
      }
      const root = {
        id: 'mock-path-1',
        name: '第一章 示例章节',
        parentId: null,
        depth: 0,
        pathName: '第一章 示例章节',
        bookId: arg.bookId || 'mock-book'
      }
      const tree = [
        {
          id: 'mock-path-1',
          catalog_name: '第一章 示例章节',
          parent_id: 0,
          child_list: [
            {
              id: 'mock-path-2',
              catalog_name: '第一节 示例知识点',
              parent_id: 'mock-path-1',
              child_list: []
            }
          ]
        }
      ]
      return {
        bookId: arg.bookId || 'mock-book',
        flatten: arg.flatten !== false,
        total: 2,
        isPartial: false,
        ...(arg.flatten === false ? { tree } : { items: [root, child] })
      }
    }
    case 'getQuestionSearchOptions':
      return {
        bookId: arg.bookId || 'mock-book',
        difficulties: [
          { id: 1, name: '易' },
          { id: 2, name: '较易' },
          { id: 3, name: '中档' },
          { id: 4, name: '较难' },
          { id: 5, name: '难' }
        ],
        questionModels: [
          { modelId: 5, name: '单选题' },
          { modelId: 14, name: '普通复合题' }
        ],
        features: [{ id: 1, name: '常考题' }],
        dictionaries: {
          subjects: [{ id: 2, name: '数学' }],
          grades: [{ id: 7, name: '七年级' }],
          volumes: [{ id: 1, name: '上册' }],
          byType: {
            1: [{ id: 2, name: '数学' }],
            3: [{ id: 7, name: '七年级' }],
            5: [{ id: 1, name: '上册' }]
          }
        },
        searchMap: [],
        context: {
          bookId: arg.bookId || 'mock-book',
          subjectId: 2,
          gradeId: 7,
          volume: 1,
          period: 2
        }
      }
    case 'searchQuestions': {
      const scope = arg.scope || 'currentCatalog'
      const canonicalScope = scope === 'book' ? 'learningPath' : scope
      const filterKeys = [
        'period',
        'subjectId',
        'gradeId',
        'volume',
        'difficulty',
        'features',
        'guidList',
        'haveResolution',
        'haveReview',
        'haveSolution',
        'haveSolutionVideo',
        'subModelIds',
        'searchAreaTypes',
        'sourceInfos',
        'businessTypes',
        'haveTag',
        'tagNodeIds'
      ]
      const sourceFilters =
        arg.filters && typeof arg.filters === 'object' && !Array.isArray(arg.filters)
          ? arg.filters
          : {}
      const filters = {}
      filterKeys.forEach((key) => {
        if (sourceFilters[key] !== undefined) filters[key] = sourceFilters[key]
        if (arg[key] !== undefined) filters[key] = arg[key]
      })
      const ignoredFilters = canonicalScope === 'global' ? [] : Object.keys(filters)
      const item = {
        ...createMockQuestion('mock-question-guid-1'),
        resourceMappingId: ['currentCatalog', 'currentBookResources'].includes(canonicalScope)
          ? 501
          : null
      }
      const result = {
        scope,
        canonicalScope,
        query: arg.query || '',
        items: [item],
        pageNo: Math.max(0, Number(arg.pageNo === undefined ? 0 : arg.pageNo) || 0),
        pageSize: Math.min(
          100,
          Math.max(1, Number(arg.pageSize === undefined ? 20 : arg.pageSize) || 20)
        ),
        total: 1,
        appliedFilters: canonicalScope === 'global' ? filters : {},
        isPartial: false,
        warnings: ignoredFilters.length
          ? [`${canonicalScope} 范围不支持高级筛选，已忽略：${ignoredFilters.join(', ')}`]
          : []
      }
      if (canonicalScope === 'global') {
        return { ...result, paginator: { total_count: 1 } }
      }
      if (['currentCatalog', 'currentBookResources'].includes(canonicalScope)) {
        return {
          ...result,
          bookId: arg.bookId || 'mock-book',
          catalogId:
            canonicalScope === 'currentCatalog' ? arg.catalogId || 'mock-catalog' : null,
          sourceTotal: 1,
          scannedCount: 1,
          paginator: { total_count: 1 },
          filteredLocally: !!arg.query,
          ignoredFilters
        }
      }
      return {
        ...result,
        bookId: arg.bookId || 'mock-book',
        pathsTotal: 1,
        pathsQueried: [arg.pathId || 'mock-path-1'],
        ignoredFilters,
        truncatedPaths: false
      }
    }
    case 'getQuestions': {
      const guidInfo = normalizeMockQuestionGuids(arg.guids)
      const missingGuids = guidInfo.uniqueGuids.filter((guid) => guid.startsWith('missing-'))
      const items = guidInfo.uniqueGuids
        .filter((guid) => !missingGuids.includes(guid))
        .map((guid) => createMockQuestion(guid))
      if (arg.includeDiagnostics || arg.returnEnvelope) {
        return {
          items,
          requestedGuids: guidInfo.requestedGuids,
          uniqueGuids: guidInfo.uniqueGuids,
          foundGuids: items.map((item) => item.guid),
          missingGuids,
          duplicateGuids: guidInfo.duplicateGuids
        }
      }
      return items
    }
    case 'validateQuestionSelection': {
      const guidInfo = normalizeMockQuestionGuids(arg.guids)
      const requestedGuids = guidInfo.requestedGuids
      const selectedGuids = guidInfo.uniqueGuids
      const duplicateGuids = guidInfo.duplicateGuids
      const missingGuids = selectedGuids.filter((guid) => guid.startsWith('missing-'))
      const foundGuids = selectedGuids.filter((guid) => !missingGuids.includes(guid))
      const parentChildConflicts =
        foundGuids.includes('mock-parent-guid') && foundGuids.includes('mock-child-guid')
          ? [{ parentGuid: 'mock-parent-guid', childGuid: 'mock-child-guid' }]
          : []
      const reasons = []
      if (missingGuids.length) {
        reasons.push({
          code: 'MISSING_QUESTIONS',
          message: '部分题目不存在或详情未返回',
          guids: missingGuids
        })
      }
      if (duplicateGuids.length) {
        reasons.push({
          code: 'DUPLICATE_GUIDS',
          message: '题目 GUID 存在重复',
          guids: duplicateGuids
        })
      }
      if (parentChildConflicts.length) {
        reasons.push({
          code: 'PARENT_CHILD_CONFLICT',
          message: '不能同时选择复合题父题及其子题',
          conflicts: parentChildConflicts
        })
      }
      if (Number(arg.targetModuleType) === 93 && foundGuids.length !== 1) {
        reasons.push({
          code: 'SINGLE_TARGET_REQUIRED',
          message: '题目详情模块必须且只能关联一道题目',
          expected: 1,
          actual: foundGuids.length
        })
      }
      const config = arg.config && typeof arg.config === 'object' ? arg.config : {}
      const timeMode =
        config.timeMode === undefined || config.timeMode === null ? 0 : Number(config.timeMode)
      if (
        Number(arg.targetModuleType) === 82 &&
        Number(config.questionMode) === 2 &&
        timeMode === 0
      ) {
        reasons.push({
          code: 'INVALID_TIME_MODE',
          message: '考核模式不支持不限时，请设置 timeMode=1 和 timeLimit'
        })
      }
      if (
        Number(arg.targetModuleType) === 82 &&
        timeMode === 1 &&
        (config.timeLimit === undefined || config.timeLimit === null || config.timeLimit === '')
      ) {
        reasons.push({
          code: 'TIME_LIMIT_REQUIRED',
          message: '倒计时模式需要设置 timeLimit'
        })
      }
      return {
        compatible: reasons.length === 0,
        targetModuleType: Number(arg.targetModuleType),
        requestedGuids,
        selectedGuids,
        foundGuids,
        missingGuids,
        duplicateGuids,
        parentChildConflicts,
        items: selectedGuids.map((guid) => ({
          guid,
          found: !missingGuids.includes(guid),
          compatible: !missingGuids.includes(guid),
          hasAnswer: !missingGuids.includes(guid),
          hasSolution: !missingGuids.includes(guid),
          hasAnalysis: !missingGuids.includes(guid),
          hasExplanation: !missingGuids.includes(guid),
          explainIds: missingGuids.includes(guid) ? [] : [901],
          reasons: missingGuids.includes(guid)
            ? [{ code: 'QUESTION_NOT_FOUND', message: `未找到题目 ${guid}`, guid }]
            : []
        })),
        reasons
      }
    }
    case 'getQuestionSolutions': {
      const guidInfo = normalizeMockQuestionGuids(arg.guids)
      return {
        items: guidInfo.uniqueGuids.map((guid) => ({
          guid,
          solutions: [
            {
              answer: ['A'],
              solution: '<p>示例解析</p>'
            }
          ],
          hasSolution: true
        })),
        requestedGuids: guidInfo.uniqueGuids,
        missingGuids: []
      }
    }
    case 'addQuestionsToCatalog': {
      const allRequestedGuids = (Array.isArray(arg.guids) ? arg.guids : []).map(String)
      const requestedGuids = [...new Set(allRequestedGuids)]
      const duplicateGuids = [
        ...new Set(
          allRequestedGuids.filter(
            (guid, index) => allRequestedGuids.indexOf(guid) !== index
          )
        )
      ]
      const missingGuids = requestedGuids.filter((guid) => guid.startsWith('missing-'))
      const existingGuids = requestedGuids.filter((guid) => guid.startsWith('existing-'))
      const addableGuids = requestedGuids.filter(
        (guid) => !missingGuids.includes(guid) && !existingGuids.includes(guid)
      )
      const canAdd = !arg.validateOnly && missingGuids.length === 0 && addableGuids.length > 0
      return {
        bookId: arg.bookId || 'mock-book',
        catalogId: arg.catalogId || 'mock-catalog',
        requestedGuids,
        duplicateGuids,
        existingGuids,
        missingGuids,
        addableGuids,
        addedGuids: canAdd ? addableGuids : [],
        added: canAdd,
        validated: missingGuids.length === 0,
        validateOnly: !!arg.validateOnly,
        persistedImmediately: canAdd
      }
    }
    case 'removeCatalogQuestion':
      return {
        removed: true,
        deleted: true,
        resourceMappingId: Number(arg.resourceMappingId),
        persistedImmediately: true
      }
    case 'moveCatalogQuestion':
      return {
        moved: true,
        resourceMappingId: Number(arg.resourceMappingId),
        toIndex: Number(arg.toIndex),
        persistedImmediately: true
    }
    case 'getQuestionExplanations': {
      const guidInfo = normalizeMockQuestionGuids(arg.guids)
      return {
        items: guidInfo.uniqueGuids.map((guid, index) => {
          const id = 901 + index
          return {
            guid,
            explanations: [
              {
                id,
                questionGuid: guid,
                content: '<p>示例 AI 讲解</p>',
                sort: 1,
                isSelected: true,
                available: true
              }
            ],
            explainIds: [id]
          }
        }),
        requestedGuids: guidInfo.uniqueGuids,
        missingGuids: []
      }
    }
    case 'startQuestionExplanationGeneration': {
      const guids = normalizeMockQuestionGuids(arg.guids).uniqueGuids
      return {
        started: true,
        batch: guids.length > 1,
        bookId: arg.bookId || 'mock-book',
        guids,
        taskId: 801
      }
    }
    case 'getQuestionExplanationStatus': {
      const guids = normalizeMockQuestionGuids(arg.guids).uniqueGuids
      return {
        bookId: arg.bookId || 'mock-book',
        items: guids.map((guid, index) => {
          const id = 901 + index
          return {
            guid,
            taskId: 801 + index,
            taskStatus: 2,
            status: 'succeeded',
            done: true,
            ...(arg.includeResults
              ? {
                  explanations: [
                    {
                      id,
                      questionGuid: guid,
                      content: '<p>示例 AI 讲解</p>',
                      sort: 1,
                      isSelected: true,
                      available: true
                    }
                  ],
                  explainIds: [id]
                }
              : {})
          }
        })
      }
    }
    case 'saveQuestionExplanation':
      return {
        saved: true,
        id: arg.id || 901,
        questionGuid: String(arg.questionGuid),
        persistedImmediately: true
      }
    case 'deleteQuestionExplanation':
      return {
        deleted: true,
        explanationId: Number(arg.explanationId),
        persistedImmediately: true
      }
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
