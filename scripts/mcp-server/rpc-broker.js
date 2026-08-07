import http from 'node:http'
import { randomUUID } from 'node:crypto'

const RPC_BASE_PATH = '/ai-control/rpc'
const SERVICE_NAME = 'super-editor-control-rpc'
const PROTOCOL_VERSION = 1
const INSTANCE_TTL_MS = 120000
const CLIENT_LEASE_TTL_MS = 30000
const CLEANUP_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 60000
const MIN_TIMEOUT_MS = 1000
const MAX_TIMEOUT_MS = 120000
const MAX_BODY_BYTES = 100 * 1024 * 1024
const MAX_QUEUE_LENGTH = 100
const POLL_WAIT_TIMEOUT_MS = 20000
const EXTERNAL_PROBE_CACHE_MS = 1000
const EXTERNAL_MONITOR_INTERVAL_MS = 1500
const BROKER_CLOSE_GRACE_MS = 1000

function parsePort(value, fallback = 8765) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

const configuredHost = '127.0.0.1'
const configuredPort = parsePort(process.env.SUPER_EDITOR_RPC_PORT)
const configuredOrigin = `http://${configuredHost}:${configuredPort}`

function createRpcBrokerServer(options = {}) {
  const host = options.host || configuredHost
  const port = options.port === undefined ? configuredPort : options.port
  const clientLeaseTtlMs = options.clientLeaseTtlMs || CLIENT_LEASE_TTL_MS
  const queues = new Map()
  const waiters = new Map()
  const pollWaiters = new Map()
  const inFlightCommands = new Map()
  const leases = new Map()
  const instances = []
  const lastPollAt = new Map()
  const instanceWindowIds = new Map()

  let cleanupTimer = null
  let server = null
  let startPromise = null

  function applyCommonHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.setHeader('Cache-Control', 'no-store')
  }

  function sendJson(res, statusCode, body) {
    if (res.writableEnded || res.destroyed) return
    applyCommonHeaders(res)
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  function sendNoContent(res) {
    if (res.writableEnded || res.destroyed) return
    applyCommonHeaders(res)
    res.statusCode = 204
    res.end()
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let settled = false

      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          settled = true
          reject(Object.assign(new Error('请求体超过 100 MB 限制'), { statusCode: 413 }))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }))
        }
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  }

  function generateId(prefix) {
    return prefix + randomUUID()
  }

  function touchInstance(instance, windowId) {
    if (!queues.has(instance)) {
      queues.set(instance, [])
      instances.unshift(instance)
    }
    if (windowId) instanceWindowIds.set(instance, windowId)
    lastPollAt.set(instance, Date.now())
  }

  function completeWaiter(id, entry) {
    const waiter = waiters.get(id)
    if (!waiter) return false
    waiters.delete(id)
    clearTimeout(waiter.timer)
    waiter.respond(entry)
    return true
  }

  function removeQueuedCommand(instance, id) {
    const queue = queues.get(instance)
    if (!queue) return false
    const index = queue.findIndex((command) => command.id === id)
    if (index < 0) return false
    queue.splice(index, 1)
    return true
  }

  function closePollWaiter(instance) {
    const pollWaiter = pollWaiters.get(instance)
    if (!pollWaiter) return
    pollWaiters.delete(instance)
    clearTimeout(pollWaiter.timer)
    sendNoContent(pollWaiter.res)
  }

  function dispatchCommand(instance, res, command) {
    inFlightCommands.set(command.id, {
      instance,
      method: command.method,
      clientId: command.clientId
    })
    sendJson(res, 200, {
      id: command.id,
      method: command.method,
      args: command.args
    })
  }

  function hasInFlightCommands(clientId, instance) {
    return Array.from(inFlightCommands.values()).some(
      (command) => command.clientId === clientId && command.instance === instance
    )
  }

  function finishRequestedRelease(clientId, instance) {
    const lease = leases.get(instance)
    if (!lease || lease.clientId !== clientId || !lease.releaseRequested) return
    if (!hasInFlightCommands(clientId, instance)) leases.delete(instance)
  }

  function cancelQueuedCommands(clientId, requestedInstance, options = {}) {
    const errorCode = options.errorCode || 'CLIENT_RELEASED_NOT_DISPATCHED'
    const errorPrefix = options.errorPrefix || '客户端已释放页面；命令尚未发送，已取消：'
    queues.forEach((queue, instance) => {
      if (requestedInstance && requestedInstance !== instance) return
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const command = queue[index]
        if (command.clientId !== clientId) continue
        queue.splice(index, 1)
        completeWaiter(command.id, {
          ok: false,
          value: null,
          error: errorPrefix + command.method,
          errorCode
        })
      }
    })
  }

  function deliverQueuedCommand(instance) {
    const pollWaiter = pollWaiters.get(instance)
    const queue = queues.get(instance)
    if (!pollWaiter || !queue || !queue.length) return false
    pollWaiters.delete(instance)
    clearTimeout(pollWaiter.timer)
    dispatchCommand(instance, pollWaiter.res, queue.shift())
    return true
  }

  function removeInstance(instance, reason) {
    const queue = queues.get(instance) || []
    closePollWaiter(instance)
    queues.delete(instance)
    lastPollAt.delete(instance)
    instanceWindowIds.delete(instance)
    leases.delete(instance)
    const index = instances.indexOf(instance)
    if (index >= 0) instances.splice(index, 1)
    queue.forEach((command) => {
      completeWaiter(command.id, {
        ok: false,
        value: null,
        error: reason,
        errorCode: 'INSTANCE_UNREGISTERED'
      })
    })
    Array.from(inFlightCommands.entries()).forEach(([id, command]) => {
      if (command.instance !== instance) return
      inFlightCommands.delete(id)
      completeWaiter(id, {
        ok: false,
        value: null,
        error: reason + '；命令已发送到页面，无法确认是否执行完成',
        errorCode: 'OUTCOME_UNKNOWN'
      })
    })
  }

  function pruneExpired() {
    const now = Date.now()
    Array.from(lastPollAt.entries()).forEach(([instance, lastSeen]) => {
      if (now - lastSeen > INSTANCE_TTL_MS) {
        removeInstance(instance, '目标页面实例已失活：' + instance)
      }
    })
    leases.forEach((lease, instance) => {
      const expired = now - lease.lastSeen > clientLeaseTtlMs
      if (!queues.has(instance)) {
        leases.delete(instance)
      } else if (expired && !hasInFlightCommands(lease.clientId, instance)) {
        cancelQueuedCommands(lease.clientId, instance, {
          errorCode: 'CLIENT_LEASE_EXPIRED_NOT_DISPATCHED',
          errorPrefix: '客户端页面租约已过期；命令尚未发送，已取消：'
        })
        leases.delete(instance)
      }
    })
  }

  function claimInstance(clientId, preferredInstance, preferredWindowId) {
    pruneExpired()
    const canClaim = (instance) => {
      const lease = leases.get(instance)
      return queues.has(instance) && (!lease || lease.clientId === clientId)
    }
    let instance = null
    if (preferredInstance) {
      const instanceWindowId = instanceWindowIds.get(preferredInstance) || ''
      if (
        queues.has(preferredInstance) &&
        (!preferredWindowId || instanceWindowId === preferredWindowId)
      ) {
        if (!canClaim(preferredInstance)) {
          return { instance: null, windowId: instanceWindowId, errorCode: 'INSTANCE_BUSY' }
        }
        instance = preferredInstance
      }
    }
    if (!instance && preferredWindowId) {
      const matches = instances.filter(
        (id) => queues.has(id) && instanceWindowIds.get(id) === preferredWindowId
      )
      if (matches.length > 1) {
        return { instance: null, windowId: preferredWindowId, errorCode: 'WINDOW_AMBIGUOUS' }
      }
      if (!matches.length) {
        return { instance: null, windowId: preferredWindowId, errorCode: 'WINDOW_NOT_FOUND' }
      }
      if (!canClaim(matches[0])) {
        return { instance: null, windowId: preferredWindowId, errorCode: 'INSTANCE_BUSY' }
      }
      instance = matches[0]
    } else {
      if (!instance && !preferredInstance) {
        instance = instances.find((id) => canClaim(id)) || null
      }
    }
    if (!instance) {
      const hasRegisteredInstances = instances.some((id) => queues.has(id))
      return {
        instance: null,
        windowId: preferredWindowId || '',
        errorCode: preferredInstance
          ? 'INSTANCE_STALE'
          : hasRegisteredInstances
            ? 'INSTANCE_BUSY'
            : 'NO_INSTANCES'
      }
    }
    const currentLease = leases.get(instance)
    leases.set(instance, {
      clientId,
      lastSeen: Date.now(),
      releaseRequested: !!(
        currentLease &&
        currentLease.clientId === clientId &&
        currentLease.releaseRequested
      )
    })
    return { instance, windowId: instanceWindowIds.get(instance) || '', errorCode: '' }
  }

  async function handlePoll(url, res) {
    const instance = String(url.searchParams.get('instance') || '')
    const windowId = String(url.searchParams.get('windowId') || '')
    if (!instance) {
      sendJson(res, 400, { ok: false, error: '缺少 instance 参数' })
      return
    }
    pruneExpired()
    touchInstance(instance, windowId)
    const queue = queues.get(instance)
    if (queue && queue.length > 0) {
      dispatchCommand(instance, res, queue.shift())
      return
    }
    closePollWaiter(instance)
    const timer = setTimeout(() => {
      const current = pollWaiters.get(instance)
      if (!current || current.res !== res) return
      pollWaiters.delete(instance)
      sendNoContent(res)
    }, POLL_WAIT_TIMEOUT_MS)
    pollWaiters.set(instance, { res, timer })
    res.once('close', () => {
      const current = pollWaiters.get(instance)
      if (!current || current.res !== res) return
      pollWaiters.delete(instance)
      clearTimeout(timer)
    })
  }

  async function handleResult(req, res) {
    const body = await readJsonBody(req)
    const id = String(body.id || '')
    if (!id) {
      sendJson(res, 400, { ok: false, error: '缺少 id' })
      return
    }
    const instance = String(body.instance || '')
    const command = inFlightCommands.get(id)
    if (!command) {
      sendJson(res, 200, { ok: true, accepted: false })
      return
    }
    if (!instance || command.instance !== instance) {
      sendJson(res, 409, {
        ok: false,
        error: 'RPC 结果所属页面与命令目标不一致',
        errorCode: 'INSTANCE_MISMATCH'
      })
      return
    }
    const entry = {
      ok: !!body.ok,
      value: body.value === undefined ? null : body.value,
      error: String(body.error || ''),
      errorCode: String(body.errorCode || (body.ok ? '' : 'PAGE_ERROR'))
    }
    inFlightCommands.delete(id)
    finishRequestedRelease(command.clientId, command.instance)
    completeWaiter(id, entry)
    sendJson(res, 200, { ok: true, accepted: true })
  }

  async function handleUnregister(req, res) {
    const body = await readJsonBody(req)
    const instance = String(body.instance || '')
    if (!instance) {
      sendJson(res, 400, { ok: false, error: '缺少 instance 参数' })
      return
    }
    removeInstance(instance, '页面已关闭 AI 控制：' + instance)
    sendJson(res, 200, { ok: true })
  }

  async function handleClaim(req, res) {
    const body = await readJsonBody(req)
    const clientId = String(body.clientId || '')
    if (!clientId) {
      sendJson(res, 400, { ok: false, error: '缺少 clientId', errorCode: 'CLIENT_ID_REQUIRED' })
      return
    }
    pruneExpired()
    const preferredInstance = String(body.preferredInstance || '')
    const preferredWindowId = String(body.preferredWindowId || '')
    const claim = claimInstance(clientId, preferredInstance, preferredWindowId)
    if (!claim.instance) {
      const hasInstances = instances.some((id) => queues.has(id))
      const errorMap = {
        INSTANCE_STALE: '目标页面实例已失活或未注册：' + preferredInstance,
        WINDOW_NOT_FOUND: '目标浏览器窗口尚未重新注册：' + preferredWindowId,
        WINDOW_AMBIGUOUS: '发现多个相同窗口身份的页面，为避免控制串页已停止自动认领：' + preferredWindowId,
        INSTANCE_BUSY: '目标页面正由另一个 Codex 任务使用'
      }
      const responseBody = {
        ok: false,
        instance: null,
        error:
          errorMap[claim.errorCode] ||
          (hasInstances
            ? '已开启 AI 控制的页面正由另一个 Codex 任务使用'
            : '暂无已注册的编辑器页面，请在浏览器中打开课件并开启顶部“AI 控制”'),
        errorCode: claim.errorCode || (hasInstances ? 'INSTANCE_BUSY' : 'NO_INSTANCES')
      }
      if (claim.windowId) responseBody.windowId = claim.windowId
      sendJson(res, 200, responseBody)
      return
    }
    const responseBody = { ok: true, instance: claim.instance }
    if (claim.windowId) responseBody.windowId = claim.windowId
    sendJson(res, 200, responseBody)
  }

  async function handleRelease(req, res) {
    const body = await readJsonBody(req)
    const clientId = String(body.clientId || '')
    const requestedInstance = String(body.instance || '')
    cancelQueuedCommands(clientId, requestedInstance)
    leases.forEach((lease, instance) => {
      if (lease.clientId !== clientId) return
      if (requestedInstance && requestedInstance !== instance) return
      if (hasInFlightCommands(clientId, instance)) {
        leases.set(instance, { ...lease, releaseRequested: true })
      } else {
        leases.delete(instance)
      }
    })
    sendJson(res, 200, { ok: true })
  }

  async function handleRequest(req, res) {
    const body = await readJsonBody(req)
    const method = String(body.method || '')
    const clientId = String(body.clientId || '')
    if (!method) {
      sendJson(res, 400, { ok: false, error: '缺少 method' })
      return
    }
    if (!clientId) {
      sendJson(res, 400, {
        ok: false,
        error: '缺少 clientId',
        errorCode: 'CLIENT_ID_REQUIRED'
      })
      return
    }

    pruneExpired()
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
      MAX_TIMEOUT_MS
    )
    let instance = null
    if (body.targetInstance) {
      const lease = leases.get(body.targetInstance)
      if (lease && lease.clientId !== clientId) {
        sendJson(res, 200, {
          ok: false,
          value: null,
          error: '目标页面正由另一个 Codex 任务使用',
          errorCode: 'INSTANCE_BUSY',
          instance: null
        })
        return
      }
      instance = queues.has(body.targetInstance) ? body.targetInstance : null
    } else {
      instance = claimInstance(clientId).instance
    }
    if (!instance) {
      const error = body.targetInstance
        ? '目标页面实例已失活或未注册：' + body.targetInstance
        : '暂无已注册的编辑器页面，请在浏览器中打开课件并开启顶部“AI 控制”'
      sendJson(res, 200, {
        ok: false,
        value: null,
        error,
        errorCode: body.targetInstance ? 'INSTANCE_STALE' : 'NO_INSTANCES',
        instance: null
      })
      return
    }
    leases.set(instance, { clientId, lastSeen: Date.now() })

    const id = String(body.id || generateId('req-'))
    if (waiters.has(id)) {
      sendJson(res, 409, {
        ok: false,
        value: null,
        error: 'RPC 请求 id 正在使用：' + id,
        errorCode: 'DUPLICATE_REQUEST',
        instance
      })
      return
    }
    const queue = queues.get(instance)
    if (queue.length >= MAX_QUEUE_LENGTH) {
      sendJson(res, 429, {
        ok: false,
        value: null,
        error: '目标页面 RPC 队列已满，请稍后重试',
        errorCode: 'QUEUE_FULL',
        instance
      })
      return
    }
    const timer = setTimeout(() => {
      if (!waiters.has(id)) return
      const notDispatched = removeQueuedCommand(instance, id)
      if (!notDispatched) {
        inFlightCommands.delete(id)
        finishRequestedRelease(clientId, instance)
      }
      completeWaiter(id, {
        ok: false,
        value: null,
        error: notDispatched
          ? 'RPC 超时且命令尚未发送到页面（' + timeoutMs + 'ms）：' + method
          : 'RPC 超时；命令已发送到页面，无法确认是否执行完成（' + timeoutMs + 'ms）：' + method,
        errorCode: notDispatched ? 'RPC_TIMEOUT_NOT_DISPATCHED' : 'OUTCOME_UNKNOWN'
      })
    }, timeoutMs)
    waiters.set(id, {
      timer,
      respond: (entry) => {
        sendJson(res, 200, {
          ok: entry.ok,
          value: entry.value,
          error: entry.error,
          errorCode: entry.errorCode || '',
          instance
        })
      }
    })
    const handleClientClose = () => {
      if (res.writableEnded) return
      const waiter = waiters.get(id)
      if (!waiter) return
      if (removeQueuedCommand(instance, id)) {
        waiters.delete(id)
        clearTimeout(waiter.timer)
        return
      }
      // 命令已被页面领取时不能取消；保留超时器以清理 in-flight 状态，
      // 但不再尝试向已断开的 HTTP 响应写入结果。
      waiter.respond = () => {}
    }
    res.once('close', handleClientClose)
    queue.push({
      id,
      method,
      args: Array.isArray(body.args) ? body.args : [body.args],
      clientId
    })
    if (res.destroyed && !res.writableEnded) {
      handleClientClose()
      return
    }
    deliverQueuedCommand(instance)
  }

  async function handleHttpRequest(req, res) {
    applyCommonHeaders(res)
    const url = new URL(req.url, `http://${host}`)
    if (!url.pathname.startsWith(RPC_BASE_PATH)) {
      sendJson(res, 404, { ok: false, error: 'Not Found' })
      return
    }
    if (req.method === 'OPTIONS') {
      sendNoContent(res)
      return
    }

    try {
      if (req.method === 'GET' && url.pathname === RPC_BASE_PATH + '/poll') {
        await handlePoll(url, res)
      } else if (req.method === 'POST' && url.pathname === RPC_BASE_PATH + '/result') {
        await handleResult(req, res)
      } else if (req.method === 'POST' && url.pathname === RPC_BASE_PATH + '/request') {
        await handleRequest(req, res)
      } else if (req.method === 'POST' && url.pathname === RPC_BASE_PATH + '/unregister') {
        await handleUnregister(req, res)
      } else if (req.method === 'POST' && url.pathname === RPC_BASE_PATH + '/claim') {
        await handleClaim(req, res)
      } else if (req.method === 'POST' && url.pathname === RPC_BASE_PATH + '/release') {
        await handleRelease(req, res)
      } else if (req.method === 'GET' && url.pathname === RPC_BASE_PATH + '/instances') {
        pruneExpired()
        sendJson(res, 200, instances.filter((id) => queues.has(id)))
      } else if (req.method === 'GET' && url.pathname === RPC_BASE_PATH + '/health') {
        pruneExpired()
        sendJson(res, 200, {
          ok: true,
          service: SERVICE_NAME,
          protocolVersion: PROTOCOL_VERSION,
          ownerPid: process.pid,
          runtime: { node: process.version, execPath: process.execPath },
          instances: instances.length,
          leases: leases.size
        })
      } else {
        sendJson(res, 404, { ok: false, error: 'Not Found' })
      }
    } catch (error) {
      sendJson(res, error.statusCode || 500, { ok: false, error: error.message || String(error) })
    }
  }

  function getAddress() {
    if (!server || !server.listening) return null
    const address = server.address()
    return {
      host: address.address,
      port: address.port,
      origin: `http://${address.address}:${address.port}`,
      rpcBaseUrl: `http://${address.address}:${address.port}${RPC_BASE_PATH}`
    }
  }

  async function start() {
    if (server && server.listening) return getAddress()
    if (startPromise) return startPromise
    startPromise = new Promise((resolve, reject) => {
      const nextServer = http.createServer(handleHttpRequest)
      nextServer.requestTimeout = MAX_TIMEOUT_MS + 10000
      nextServer.headersTimeout = MAX_TIMEOUT_MS + 15000
      nextServer.once('error', (error) => {
        startPromise = null
        reject(error)
      })
      nextServer.listen(port, host, () => {
        server = nextServer
        cleanupTimer = setInterval(pruneExpired, CLEANUP_INTERVAL_MS)
        cleanupTimer.unref()
        startPromise = null
        resolve(getAddress())
      })
    })
    return startPromise
  }

  async function stop() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer)
      cleanupTimer = null
    }
    queues.forEach((queue) => {
      queue.forEach((command) => {
        completeWaiter(command.id, {
          ok: false,
          value: null,
          error: 'Super Editor 本地 RPC 中继正在关闭；命令尚未发送到页面',
          errorCode: 'BROKER_SHUTDOWN_NOT_DISPATCHED'
        })
      })
    })
    inFlightCommands.forEach((command, id) => {
      completeWaiter(id, {
        ok: false,
        value: null,
        error: 'Super Editor 本地 RPC 中继正在关闭；命令已发送，无法确认是否执行完成',
        errorCode: 'OUTCOME_UNKNOWN'
      })
    })
    waiters.forEach((waiter, id) => {
      completeWaiter(id, {
        ok: false,
        value: null,
        error: 'Super Editor 本地 RPC 中继正在关闭',
        errorCode: 'BROKER_SHUTDOWN'
      })
    })
    pollWaiters.forEach((pollWaiter) => {
      clearTimeout(pollWaiter.timer)
      sendNoContent(pollWaiter.res)
    })
    pollWaiters.clear()
    inFlightCommands.clear()
    leases.clear()
    queues.clear()
    instances.splice(0)
    lastPollAt.clear()
    instanceWindowIds.clear()
    if (!server) return
    const currentServer = server
    server = null
    await new Promise((resolve) => {
      let settled = false
      let forceTimer = null
      const done = () => {
        if (settled) return
        settled = true
        if (forceTimer) clearTimeout(forceTimer)
        resolve()
      }
      forceTimer = setTimeout(() => {
        if (typeof currentServer.closeAllConnections === 'function') {
          currentServer.closeAllConnections()
        }
        done()
      }, BROKER_CLOSE_GRACE_MS)
      currentServer.close(done)
    })
  }

  return { getAddress, start, stop }
}

let ownedServer = null
let externalBroker = false
let lastExternalProbeAt = 0
let ensurePromise = null
let monitorTimer = null
let shuttingDown = false

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(timeoutMs)
    : undefined
}

async function probeBroker(timeoutMs = 500) {
  try {
    const healthResponse = await fetch(configuredOrigin + RPC_BASE_PATH + '/health', {
      signal: timeoutSignal(timeoutMs)
    })
    if (!healthResponse.ok) return null
    const health = await healthResponse.json()
    if (health.service === SERVICE_NAME && health.protocolVersion === PROTOCOL_VERSION) {
      return { compatible: true, health, kind: 'plugin' }
    }
    return null
  } catch {
    return null
  }
}

function startExternalMonitor() {
  if (monitorTimer || shuttingDown) return
  monitorTimer = setInterval(() => {
    ensureLocalRpcBroker({ forceProbe: true }).catch(() => {})
  }, EXTERNAL_MONITOR_INTERVAL_MS)
  monitorTimer.unref()
}

function stopExternalMonitor() {
  if (!monitorTimer) return
  clearInterval(monitorTimer)
  monitorTimer = null
}

async function waitForBrokerAfterPortConflict() {
  const deadline = Date.now() + 3500
  while (Date.now() < deadline) {
    const probe = await probeBroker(250)
    if (probe) return probe
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

async function acquireOrJoinBroker() {
  const existing = await probeBroker()
  if (existing) {
    externalBroker = true
    lastExternalProbeAt = Date.now()
    startExternalMonitor()
    return { origin: configuredOrigin, rpcBaseUrl: configuredOrigin + RPC_BASE_PATH, role: existing.kind }
  }

  const candidate = createRpcBrokerServer({ host: configuredHost, port: configuredPort })
  try {
    const address = await candidate.start()
    ownedServer = candidate
    externalBroker = false
    stopExternalMonitor()
    return Object.assign({ role: 'owner' }, address)
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error
    const joined = await waitForBrokerAfterPortConflict()
    if (!joined) {
      throw new Error(
        `本机端口 ${configuredPort} 已被不兼容的程序占用，无法启动 Super Editor RPC 中继`
      )
    }
    externalBroker = true
    lastExternalProbeAt = Date.now()
    startExternalMonitor()
    return { origin: configuredOrigin, rpcBaseUrl: configuredOrigin + RPC_BASE_PATH, role: joined.kind }
  }
}

async function ensureLocalRpcBroker(options = {}) {
  if (shuttingDown) throw new Error('Super Editor 本地 RPC 中继正在关闭')
  if (ownedServer && ownedServer.getAddress()) {
    return Object.assign({ role: 'owner' }, ownedServer.getAddress())
  }
  if (
    externalBroker &&
    !options.forceProbe &&
    Date.now() - lastExternalProbeAt < EXTERNAL_PROBE_CACHE_MS
  ) {
    return {
      origin: configuredOrigin,
      rpcBaseUrl: configuredOrigin + RPC_BASE_PATH,
      role: 'external'
    }
  }
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    if (externalBroker) {
      const probe = await probeBroker()
      if (probe) {
        lastExternalProbeAt = Date.now()
        startExternalMonitor()
        return {
          origin: configuredOrigin,
          rpcBaseUrl: configuredOrigin + RPC_BASE_PATH,
          role: probe.kind
        }
      }
      externalBroker = false
    }
    return acquireOrJoinBroker()
  })()
  try {
    return await ensurePromise
  } finally {
    ensurePromise = null
  }
}

async function stopLocalRpcBroker() {
  shuttingDown = true
  stopExternalMonitor()
  if (ownedServer) {
    const server = ownedServer
    ownedServer = null
    await server.stop()
  }
  externalBroker = false
}

export {
  PROTOCOL_VERSION,
  RPC_BASE_PATH,
  SERVICE_NAME,
  configuredOrigin as RPC_ORIGIN,
  createRpcBrokerServer,
  ensureLocalRpcBroker,
  stopLocalRpcBroker
}
