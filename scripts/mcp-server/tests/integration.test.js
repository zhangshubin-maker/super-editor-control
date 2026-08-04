import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER_PATH = fileURLToPath(new URL('../index.js', import.meta.url))

async function getFreePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(check, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await wait(50)
  }
  throw lastError || new Error('等待条件超时')
}

function createMcpClient(port) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, SUPER_EDITOR_RPC_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let stdoutBuffer = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()
  const invalidStdout = []

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim()
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          const waiter = pending.get(message.id)
          if (waiter) {
            pending.delete(message.id)
            clearTimeout(waiter.timer)
            waiter.resolve(message)
          }
        } catch {
          invalidStdout.push(line)
        }
      }
      newline = stdoutBuffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.once('exit', (code, signal) => {
    pending.forEach((waiter) => {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`MCP 进程提前退出：code=${code} signal=${signal}\n${stderr}`))
    })
    pending.clear()
  })

  function startCall(method, params = {}, timeoutMs = 10000) {
    const id = nextId++
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}\n${stderr}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    return { id, promise }
  }

  function call(method, params = {}, timeoutMs = 10000) {
    return startCall(method, params, timeoutMs).promise
  }

  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async function close(timeoutMs = 7000) {
    if (child.exitCode !== null) return
    child.stdin.end()
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      wait(timeoutMs).then(() => {
        child.kill()
        throw new Error('MCP 进程未在限定时间内退出\n' + stderr)
      })
    ])
  }

  return {
    child,
    call,
    close,
    notify,
    startCall,
    get stderr() {
      return stderr
    },
    invalidStdout
  }
}

async function initialize(client) {
  const response = await client.call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  })
  assert.equal(response.result.serverInfo.name, 'super-editor-control-mcp')
}

function readToolResult(response) {
  assert.ok(response.result)
  const text = response.result.content[0].text
  return { isError: !!response.result.isError, data: JSON.parse(text) }
}

async function getHealth(port) {
  const response = await fetch(`http://127.0.0.1:${port}/ai-control/rpc/health`)
  assert.equal(response.status, 200)
  return response.json()
}

async function waitForInstance(port, instance) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ai-control/rpc/instances`)
    const instances = await response.json()
    return instances.includes(instance)
  })
}

async function runBrowserPage(port, instance, signal) {
  const baseUrl = `http://127.0.0.1:${port}/ai-control/rpc`
  while (!signal.aborted) {
    try {
      const response = await fetch(baseUrl + '/poll?instance=' + encodeURIComponent(instance), {
        signal
      })
      if (response.status === 204) continue
      if (!response.ok) throw new Error('poll HTTP ' + response.status)
      const command = await response.json()
      let value
      if (command.method === 'ping') {
        value = {
          version: '1.2.0',
          editorType: 'content-editor',
          bookId: 'book-browser',
          instanceId: instance
        }
      } else if (command.method === 'getState') {
        value = { bookInfo: { id: 'book-browser' }, currentSlideId: 'slide-browser' }
      } else {
        value = { method: command.method }
      }
      await fetch(baseUrl + '/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: command.id, instance, ok: true, value })
      })
    } catch (error) {
      if (signal.aborted) return
      await wait(50)
    }
  }
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function sendJsonResponse(res, body, statusCode = 200) {
  if (res.writableEnded || res.destroyed) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function createFakeDriverBroker(port, hooks = {}) {
  const instance = hooks.instance || 'page-fake'
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`)
      if (url.pathname.endsWith('/health')) {
        sendJsonResponse(res, {
          ok: true,
          service: 'super-editor-control-rpc',
          protocolVersion: 1,
          ownerPid: process.pid,
          instances: 1,
          leases: 0
        })
        return
      }
      if (url.pathname.endsWith('/instances')) {
        sendJsonResponse(res, [instance])
        return
      }

      const body = await readJsonBody(req)
      if (url.pathname.endsWith('/claim')) {
        if (hooks.onClaim) hooks.onClaim(body)
        sendJsonResponse(res, { ok: true, instance })
        return
      }
      if (url.pathname.endsWith('/release')) {
        if (hooks.onRelease) hooks.onRelease(body)
        sendJsonResponse(res, { ok: true })
        return
      }
      if (url.pathname.endsWith('/request')) {
        if (hooks.onRequest) {
          await hooks.onRequest(body, res)
        } else {
          sendJsonResponse(res, { ok: true, value: null })
        }
        return
      }
      sendJsonResponse(res, { ok: false, error: 'Not Found' }, 404)
    } catch (error) {
      sendJsonResponse(res, { ok: false, error: error.message }, 500)
    }
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return server
}

test('取消尚未开始的 tools/call 不执行；已开始的工具不中断', { timeout: 15000 }, async () => {
  const port = await getFreePort()
  let getStateResponse = null
  let resolveGetStateStarted
  const getStateStarted = new Promise((resolve) => {
    resolveGetStateStarted = resolve
  })
  let holdStartedSave = false
  let saveResponse = null
  let resolveSaveStarted
  let saveStarted = null
  let saveCount = 0

  const fakeBroker = await createFakeDriverBroker(port, {
    onRequest(body, res) {
      if (body.method === 'ping') {
        sendJsonResponse(res, { ok: true, value: { instanceId: 'page-fake' } })
        return
      }
      if (body.method === 'getState') {
        getStateResponse = res
        resolveGetStateStarted()
        return
      }
      if (body.method === 'save') {
        saveCount += 1
        if (holdStartedSave) {
          saveResponse = res
          resolveSaveStarted()
          return
        }
        sendJsonResponse(res, { ok: true, value: { saved: true } })
        return
      }
      sendJsonResponse(res, { ok: true, value: null })
    }
  })
  const client = createMcpClient(port)

  try {
    await initialize(client)
    await client.call('tools/call', { name: 'editor_connect', arguments: {} })

    const firstCall = client.startCall('tools/call', {
      name: 'editor_get_state',
      arguments: {}
    })
    await getStateStarted

    const queuedSave = client.startCall('tools/call', {
      name: 'editor_save',
      arguments: {}
    })
    client.notify('notifications/cancelled', {
      requestId: queuedSave.id,
      reason: 'test cancellation before execution'
    })
    const cancelled = await queuedSave.promise
    assert.equal(cancelled.error.code, -32800)
    assert.match(cancelled.error.message, /cancelled before execution/i)
    await wait(50)
    assert.equal(saveCount, 0)

    sendJsonResponse(getStateResponse, {
      ok: true,
      value: { currentSlideId: 'slide-after-cancel' }
    })
    getStateResponse = null
    const firstResult = readToolResult(await firstCall.promise)
    assert.equal(firstResult.isError, false)
    await wait(50)
    assert.equal(saveCount, 0)

    holdStartedSave = true
    saveStarted = new Promise((resolve) => {
      resolveSaveStarted = resolve
    })
    const startedSave = client.startCall('tools/call', {
      name: 'editor_save',
      arguments: {}
    })
    await saveStarted
    client.notify('notifications/cancelled', {
      requestId: startedSave.id,
      reason: 'must not abort a started write'
    })
    await wait(20)
    holdStartedSave = false
    sendJsonResponse(saveResponse, { ok: true, value: { saved: true } })
    saveResponse = null
    const startedResult = readToolResult(await startedSave.promise)
    assert.equal(startedResult.isError, false)
    assert.deepEqual(startedResult.data, { saved: true })
    assert.equal(saveCount, 1)
  } finally {
    if (getStateResponse) sendJsonResponse(getStateResponse, { ok: false, error: 'test cleanup' })
    if (saveResponse) sendJsonResponse(saveResponse, { ok: false, error: 'test cleanup' })
    await client.close()
    await new Promise((resolve) => fakeBroker.close(resolve))
  }
})

test('editor_connect 不会在 editor_save 执行期间释放页面租约', { timeout: 15000 }, async () => {
  const port = await getFreePort()
  const events = []
  let saveInFlight = false
  let releaseDuringSave = false
  let saveResponse = null
  let resolveSaveStarted
  const saveStarted = new Promise((resolve) => {
    resolveSaveStarted = resolve
  })

  const fakeBroker = await createFakeDriverBroker(port, {
    onClaim() {
      events.push('claim')
    },
    onRelease() {
      events.push('release')
      if (saveInFlight) releaseDuringSave = true
    },
    onRequest(body, res) {
      events.push('request:' + body.method)
      if (body.method === 'save') {
        saveInFlight = true
        saveResponse = res
        resolveSaveStarted()
        return
      }
      sendJsonResponse(res, { ok: true, value: { instanceId: 'page-fake' } })
    }
  })
  const client = createMcpClient(port)

  try {
    await initialize(client)
    await client.call('tools/call', { name: 'editor_connect', arguments: {} })
    events.length = 0

    const saveCall = client.startCall('tools/call', {
      name: 'editor_save',
      arguments: {}
    })
    await saveStarted
    const reconnectCall = client.startCall('tools/call', {
      name: 'editor_connect',
      arguments: {}
    })

    await wait(100)
    assert.deepEqual(events, ['request:save'])
    assert.equal(releaseDuringSave, false)

    saveInFlight = false
    sendJsonResponse(saveResponse, { ok: true, value: { saved: true } })
    saveResponse = null
    const saveResult = readToolResult(await saveCall.promise)
    assert.equal(saveResult.isError, false)
    const reconnectResult = readToolResult(await reconnectCall.promise)
    assert.equal(reconnectResult.isError, false)
    assert.equal(releaseDuringSave, false)
    assert.deepEqual(events, ['request:save', 'release', 'claim', 'request:ping'])
  } finally {
    if (saveResponse) sendJsonResponse(saveResponse, { ok: false, error: 'test cleanup' })
    await client.close()
    await new Promise((resolve) => fakeBroker.close(resolve))
  }
})

test('两个 MCP 进程自动选主，owner 被杀后 follower 接管且网页继续可用', { timeout: 25000 }, async () => {
  const port = await getFreePort()
  const clientA = createMcpClient(port)
  let clientB = null
  const pageController = new AbortController()
  const pageTask = runBrowserPage(port, 'page-browser', pageController.signal)

  try {
    await initialize(clientA)
    clientB = createMcpClient(port)
    await initialize(clientB)
    await waitForInstance(port, 'page-browser')

    const firstHealth = await getHealth(port)
    assert.equal(firstHealth.ownerPid, clientA.child.pid)
    assert.match(firstHealth.runtime.node, /^v\d+/)

    const statusResponse = await clientB.call('tools/call', {
      name: 'editor_status',
      arguments: {}
    })
    const status = readToolResult(statusResponse)
    assert.equal(status.isError, false)
    assert.equal(status.data.bridgeReady, true)
    assert.equal(status.data.connected, false)
    const healthAfterStatus = await getHealth(port)
    assert.equal(healthAfterStatus.leases, 0)

    const stateResponse = await clientB.call('tools/call', {
      name: 'editor_get_state',
      arguments: {}
    })
    const state = readToolResult(stateResponse)
    assert.equal(state.isError, false)
    assert.equal(state.data.currentSlideId, 'slide-browser')

    clientA.child.kill()
    await new Promise((resolve) => clientA.child.once('exit', resolve))
    const takeoverHealth = await waitFor(async () => {
      const health = await getHealth(port)
      return health.ownerPid === clientB.child.pid ? health : null
    })
    assert.equal(takeoverHealth.ownerPid, clientB.child.pid)
    await waitForInstance(port, 'page-browser')

    const stateAfterTakeoverResponse = await clientB.call(
      'tools/call',
      { name: 'editor_get_state', arguments: {} },
      12000
    )
    const stateAfterTakeover = readToolResult(stateAfterTakeoverResponse)
    assert.equal(stateAfterTakeover.isError, false)
    assert.equal(stateAfterTakeover.data.currentSlideId, 'slide-browser')
    assert.deepEqual(clientA.invalidStdout, [])
    assert.deepEqual(clientB.invalidStdout, [])
  } finally {
    pageController.abort()
    await pageTask
    if (clientA.child.exitCode === null) clientA.child.kill()
    if (clientB) await clientB.close()
  }
})

test('截断的 HTTP 200 响应返回 OUTCOME_UNKNOWN，claim 随即释放', { timeout: 15000 }, async () => {
  const port = await getFreePort()
  let releaseCount = 0
  const fakeBroker = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (url.pathname.endsWith('/health')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        ok: true,
        service: 'super-editor-control-rpc',
        protocolVersion: 1,
        ownerPid: process.pid,
        instances: 1,
        leases: 0
      }))
      return
    }
    if (url.pathname.endsWith('/instances')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(['page-truncated']))
      return
    }
    if (url.pathname.endsWith('/claim')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, instance: 'page-truncated' }))
      return
    }
    if (url.pathname.endsWith('/release')) {
      releaseCount += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (url.pathname.endsWith('/request')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"ok":true,"value":')
      res.socket.destroy()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => fakeBroker.listen(port, '127.0.0.1', resolve))
  const client = createMcpClient(port)
  try {
    await initialize(client)
    const response = await client.call('tools/call', {
      name: 'editor_get_state',
      arguments: {}
    })
    const result = readToolResult(response)
    assert.equal(result.isError, true)
    assert.equal(result.data.errorCode, 'OUTCOME_UNKNOWN')
    await waitFor(() => releaseCount > 0)
  } finally {
    await client.close()
    await new Promise((resolve) => fakeBroker.close(resolve))
  }
})

test('不兼容服务占用端口时会在 MCP 启动超时前明确退出', { timeout: 12000 }, async () => {
  const port = await getFreePort()
  const incompatible = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, service: 'unrelated-service', protocolVersion: 1 }))
  })
  await new Promise((resolve) => incompatible.listen(port, '127.0.0.1', resolve))
  const startedAt = Date.now()
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, SUPER_EDITOR_RPC_PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
  const exitCode = await new Promise((resolve) => child.once('exit', resolve))
  await new Promise((resolve) => incompatible.close(resolve))
  assert.notEqual(exitCode, 0)
  assert.ok(Date.now() - startedAt < 8000)
  assert.match(stderr, /端口 .* 已被不兼容的程序占用/)
})

test('stdin 关闭时即使存在半读 HTTP 请求也会有界退出', { timeout: 12000 }, async () => {
  const port = await getFreePort()
  const client = createMcpClient(port)
  await initialize(client)

  const socket = net.createConnection({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write(
    'POST /ai-control/rpc/result HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 100000\r\n\r\n' +
      '{'
  )

  const startedAt = Date.now()
  await client.close(5000)
  socket.destroy()
  assert.ok(Date.now() - startedAt < 4000)
})
