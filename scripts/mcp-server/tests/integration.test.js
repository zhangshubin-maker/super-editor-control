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

async function runBrowserPage(port, instance, signal, options = {}) {
  const baseUrl = `http://127.0.0.1:${port}/ai-control/rpc`
  const windowId = options.windowId || ''
  const bookId = options.bookId || 'book-browser'
  const currentSlideId = options.bookId ? 'slide-' + bookId : 'slide-browser'
  while (!signal.aborted) {
    try {
      const query =
        '?instance=' +
        encodeURIComponent(instance) +
        (windowId ? '&windowId=' + encodeURIComponent(windowId) : '')
      const response = await fetch(baseUrl + '/poll' + query, { signal })
      if (response.status === 204) continue
      if (!response.ok) throw new Error('poll HTTP ' + response.status)
      const command = await response.json()
      let value
      if (command.method === 'ping') {
        value = {
          version: '1.2.0',
          editorType: 'content-editor',
          bookId,
          instanceId: instance,
          windowId: windowId || null
        }
      } else if (command.method === 'getState') {
        value = { bookInfo: { id: bookId }, currentSlideId }
      } else {
        value = { method: command.method }
      }
      if (typeof options.onCommand === 'function') {
        value = await options.onCommand(command, value)
      }
      await fetch(baseUrl + '/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: command.id, instance, ok: true, value })
      })
      if (typeof options.afterResult === 'function') {
        await options.afterResult(command, value)
      }
    } catch (error) {
      if (signal.aborted) return
      await wait(50)
    }
  }
}

test('MCP 刷新切书不沿用旧实例 epoch，并等待同一 windowId 的目标书本就绪', { timeout: 20000 }, async () => {
  const port = await getFreePort()
  const client = createMcpClient(port)
  const otherController = new AbortController()
  const oldController = new AbortController()
  const newController = new AbortController()
  let oldPage = null
  let newPage = null
  let resolveJumpResult
  const jumpResultPosted = new Promise((resolve) => {
    resolveJumpResult = resolve
  })
  const otherPage = runBrowserPage(port, 'page-other-book', otherController.signal, {
    windowId: 'window-other',
    bookId: 'book-other'
  })

  try {
    await initialize(client)
    await waitForInstance(port, 'page-other-book')
    oldPage = runBrowserPage(port, 'page-target-old', oldController.signal, {
      windowId: 'window-target',
      bookId: 'book-old',
      onCommand(command, fallback) {
        if (command.method === 'ping' || command.method === 'getState') {
          return { ...fallback, contextEpoch: 7 }
        }
        if (command.method !== 'jumpToBook') return fallback
        return {
          bookId: command.args[0].bookId,
          target: 'current',
          hotSwitched: false,
          contextEpoch: 7,
          scheduled: true,
          reloadScheduled: true
        }
      },
      afterResult(command) {
        if (command.method === 'jumpToBook') resolveJumpResult()
      }
    })
    await waitForInstance(port, 'page-target-old')

    const connected = readToolResult(
      await client.call('tools/call', { name: 'editor_connect', arguments: {} })
    )
    assert.equal(connected.isError, false)
    assert.equal(connected.data.windowId, 'window-target')

    const switchPromise = client.call(
      'tools/call',
      {
        name: 'editor_jump_to_book',
        arguments: { bookId: 'book-new', target: 'current' }
      },
      15000
    )
    await jumpResultPosted
    oldController.abort()
    await oldPage
    await fetch(`http://127.0.0.1:${port}/ai-control/rpc/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: 'page-target-old' })
    })

    newPage = runBrowserPage(port, 'page-target-new', newController.signal, {
      windowId: 'window-target',
      bookId: 'book-new',
      onCommand(command, fallback) {
        if (command.method === 'ping' || command.method === 'getState') {
          return { ...fallback, contextEpoch: 0 }
        }
        return fallback
      }
    })
    await waitForInstance(port, 'page-target-new')

    const switched = readToolResult(await switchPromise)
    assert.equal(switched.isError, false)
    assert.equal(switched.data.ready, true)
    assert.equal(switched.data.bridgeReady, true)
    assert.equal(switched.data.bookId, 'book-new')
    assert.equal(switched.data.windowId, 'window-target')
    assert.equal(switched.data.instanceId, 'page-target-new')
    assert.equal(switched.data.instancePreserved, false)
    assert.equal(switched.data.currentSlideId, 'slide-book-new')
    assert.equal(switched.data.contextEpoch, 0)
    assert.equal(Object.hasOwn(switched.data, 'contentReady'), false)
    assert.equal(Object.hasOwn(switched.data, 'currentSlidePlaceholder'), false)
    assert.equal(Object.hasOwn(switched.data, 'emptyBook'), false)
    assert.equal(typeof switched.data.durationMs, 'number')
  } finally {
    otherController.abort()
    oldController.abort()
    newController.abort()
    await Promise.all([otherPage, oldPage, newPage].filter(Boolean))
    await client.close()
  }
})

test('MCP 刷新延迟期间拒绝仍存活的旧实例，只接受真正的新实例', { timeout: 20000 }, async () => {
  const port = await getFreePort()
  const client = createMcpClient(port)
  const oldController = new AbortController()
  const newController = new AbortController()
  let oldReportsTarget = false
  let resolveJumpResult
  const jumpResultPosted = new Promise((resolve) => {
    resolveJumpResult = resolve
  })
  const oldPage = runBrowserPage(port, 'page-delayed-old', oldController.signal, {
    windowId: 'window-delayed-refresh',
    bookId: 'book-old',
    onCommand(command, fallback) {
      if (command.method === 'jumpToBook') {
        oldReportsTarget = true
        return {
          bookId: 'book-new',
          target: 'current',
          hotSwitched: false,
          scheduled: true,
          reloadScheduled: true,
          contextEpoch: 8
        }
      }
      if (!oldReportsTarget) return fallback
      if (command.method === 'ping') {
        return { ...fallback, bookId: 'book-new', contextEpoch: 8 }
      }
      if (command.method === 'getState') {
        return {
          bookId: 'book-new',
          bookInfo: { id: 'book-new' },
          currentSlideId: 'slide-old-instance-target-state',
          contextEpoch: 8,
          dirty: false
        }
      }
      return fallback
    },
    afterResult(command) {
      if (command.method === 'jumpToBook') resolveJumpResult()
    }
  })
  let newPage = null

  try {
    await initialize(client)
    await waitForInstance(port, 'page-delayed-old')
    const connected = readToolResult(
      await client.call('tools/call', { name: 'editor_connect', arguments: {} })
    )
    assert.equal(connected.data.instanceId, 'page-delayed-old')

    let switchSettled = false
    const switchPromise = client.call(
      'tools/call',
      {
        name: 'editor_jump_to_book',
        arguments: { bookId: 'book-new', target: 'current' }
      },
      15000
    )
    switchPromise.then(
      () => {
        switchSettled = true
      },
      () => {
        switchSettled = true
      }
    )
    await jumpResultPosted
    await wait(250)
    assert.equal(oldReportsTarget, true)
    assert.equal(switchSettled, false)

    newPage = runBrowserPage(port, 'page-delayed-new', newController.signal, {
      windowId: 'window-delayed-refresh',
      bookId: 'book-new'
    })
    await waitForInstance(port, 'page-delayed-new')

    const switched = readToolResult(await switchPromise)
    assert.equal(switched.isError, false)
    assert.equal(switched.data.ready, true)
    assert.equal(switched.data.instanceId, 'page-delayed-new')
    assert.equal(switched.data.instancePreserved, false)
    assert.equal(switched.data.currentSlideId, 'slide-book-new')
  } finally {
    oldController.abort()
    newController.abort()
    await Promise.all([oldPage, newPage].filter(Boolean))
    await client.close()
  }
})

test('MCP 热切书会保留原实例并等待 contextEpoch 收敛', { timeout: 15000 }, async () => {
  const port = await getFreePort()
  const releases = []
  let phase = 'old'
  let postJumpPingCount = 0
  let postJumpStateCount = 0
  const fakeBroker = await createFakeDriverBroker(port, {
    instance: 'page-hot-switch',
    onRelease(body) {
      releases.push(body)
    },
    onRequest(body, res) {
      if (body.method === 'ping') {
        if (phase === 'switching') {
          postJumpPingCount += 1
          const ready = postJumpPingCount >= 2
          sendJsonResponse(res, {
            ok: true,
            value: {
              version: '1.9.0',
              editorType: 'content-editor',
              bookId: 'book-new',
              instanceId: 'page-hot-switch',
              windowId: 'window-hot-switch',
              contextEpoch: ready ? 2 : 1,
              bookSwitching: !ready
            }
          })
          return
        }
        sendJsonResponse(res, {
          ok: true,
          value: {
            version: '1.9.0',
            editorType: 'content-editor',
            bookId: 'book-old',
            instanceId: 'page-hot-switch',
            windowId: 'window-hot-switch',
            contextEpoch: 1,
            bookSwitching: false
          }
        })
        return
      }
      if (body.method === 'getState') {
        const contextReady = phase === 'switching' && postJumpPingCount >= 2
        if (contextReady) postJumpStateCount += 1
        const contentReady = contextReady && postJumpStateCount >= 2
        sendJsonResponse(res, {
          ok: true,
          value: {
            bookId: contextReady ? 'book-new' : 'book-old',
            bookInfo: { id: contextReady ? 'book-new' : 'book-old' },
            currentSlideId: contextReady ? 'slide-book-new' : 'slide-book-old',
            contextEpoch: contextReady ? 2 : 1,
            bookSwitching: phase === 'switching' && !contextReady,
            contentReady,
            currentSlidePlaceholder: false,
            emptyBook: false,
            dirty: false
          }
        })
        return
      }
      if (body.method === 'jumpToBook') {
        phase = 'switching'
        sendJsonResponse(res, {
          ok: true,
          value: {
            bookId: body.args[0].bookId,
            target: 'current',
            hotSwitched: true,
            reloadScheduled: false,
            contextEpoch: 2
          }
        })
        return
      }
      sendJsonResponse(res, { ok: true, value: null })
    }
  })
  const client = createMcpClient(port)

  try {
    await initialize(client)
    const switched = readToolResult(
      await client.call(
        'tools/call',
        {
          name: 'editor_jump_to_book',
          arguments: { bookId: 'book-new', target: 'current' }
        },
        10000
      )
    )
    assert.equal(switched.isError, false)
    assert.equal(switched.data.ready, true)
    assert.equal(switched.data.hotSwitched, true)
    assert.equal(switched.data.reloadScheduled, false)
    assert.equal(switched.data.contextEpoch, 2)
    assert.equal(switched.data.contentReady, true)
    assert.equal(switched.data.currentSlidePlaceholder, false)
    assert.equal(switched.data.emptyBook, false)
    assert.equal(switched.data.instanceId, 'page-hot-switch')
    assert.equal(switched.data.instancePreserved, true)
    assert.equal(switched.data.windowId, 'window-hot-switch')
    assert.equal(switched.data.currentSlideId, 'slide-book-new')
    assert.ok(postJumpPingCount >= 2)
    assert.ok(postJumpStateCount >= 2)
    assert.equal(releases.length, 0)
  } finally {
    await client.close()
    await new Promise((resolve) => fakeBroker.close(resolve))
  }
})

test('MCP 热切空书和 PDF 占位目录可作为显式内容就绪例外', { timeout: 15000 }, async () => {
  const port = await getFreePort()
  let current = {
    bookId: 'book-old',
    contextEpoch: 1,
    currentSlideId: 'slide-old',
    contentReady: true,
    currentSlidePlaceholder: false,
    emptyBook: false
  }
  const fakeBroker = await createFakeDriverBroker(port, {
    instance: 'page-hot-exceptions',
    onRequest(body, res) {
      if (body.method === 'ping') {
        sendJsonResponse(res, {
          ok: true,
          value: {
            version: '1.9.0',
            editorType: 'content-editor',
            bookId: current.bookId,
            instanceId: 'page-hot-exceptions',
            windowId: 'window-hot-exceptions',
            contextEpoch: current.contextEpoch,
            bookSwitching: false
          }
        })
        return
      }
      if (body.method === 'getState') {
        sendJsonResponse(res, {
          ok: true,
          value: {
            ...current,
            bookInfo: { id: current.bookId },
            bookSwitching: false,
            dirty: false
          }
        })
        return
      }
      if (body.method === 'jumpToBook') {
        const targetBookId = body.args[0].bookId
        const nextEpoch = current.contextEpoch + 1
        current =
          targetBookId === 'book-empty'
            ? {
                bookId: targetBookId,
                contextEpoch: nextEpoch,
                currentSlideId: null,
                contentReady: false,
                currentSlidePlaceholder: false,
                emptyBook: true
              }
            : {
                bookId: targetBookId,
                contextEpoch: nextEpoch,
                currentSlideId: 'pdf-placeholder-1',
                contentReady: false,
                currentSlidePlaceholder: true,
                emptyBook: false
              }
        sendJsonResponse(res, {
          ok: true,
          value: {
            bookId: targetBookId,
            target: 'current',
            hotSwitched: true,
            reloadScheduled: false,
            contextEpoch: nextEpoch
          }
        })
        return
      }
      sendJsonResponse(res, { ok: true, value: null })
    }
  })
  const client = createMcpClient(port)

  try {
    await initialize(client)
    const emptyBook = readToolResult(
      await client.call('tools/call', {
        name: 'editor_jump_to_book',
        arguments: { bookId: 'book-empty', target: 'current' }
      })
    )
    assert.equal(emptyBook.isError, false)
    assert.equal(emptyBook.data.ready, true)
    assert.equal(emptyBook.data.currentSlideId, null)
    assert.equal(emptyBook.data.contentReady, false)
    assert.equal(emptyBook.data.currentSlidePlaceholder, false)
    assert.equal(emptyBook.data.emptyBook, true)
    assert.equal(emptyBook.data.instancePreserved, true)

    const pdfPlaceholder = readToolResult(
      await client.call('tools/call', {
        name: 'editor_jump_to_book',
        arguments: { bookId: 'book-pdf', target: 'current' }
      })
    )
    assert.equal(pdfPlaceholder.isError, false)
    assert.equal(pdfPlaceholder.data.ready, true)
    assert.equal(pdfPlaceholder.data.currentSlideId, 'pdf-placeholder-1')
    assert.equal(pdfPlaceholder.data.contentReady, false)
    assert.equal(pdfPlaceholder.data.currentSlidePlaceholder, true)
    assert.equal(pdfPlaceholder.data.emptyBook, false)
    assert.equal(pdfPlaceholder.data.instancePreserved, true)
  } finally {
    await client.close()
    await new Promise((resolve) => fakeBroker.close(resolve))
  }
})

test('MCP 刷新重连保持原窗口绑定，不会认领其他书本页面', { timeout: 20000 }, async () => {
  const port = await getFreePort()
  const client = createMcpClient(port)
  const otherController = new AbortController()
  const targetController = new AbortController()
  let refreshedController = null
  const otherPage = runBrowserPage(port, 'page-other-book', otherController.signal, {
    windowId: 'window-other',
    bookId: 'book-other'
  })
  let targetPage = null
  let refreshedPage = null

  try {
    await initialize(client)
    await waitForInstance(port, 'page-other-book')
    targetPage = runBrowserPage(port, 'page-target-old', targetController.signal, {
      windowId: 'window-target',
      bookId: 'book-target-old'
    })
    await waitForInstance(port, 'page-target-old')

    const connected = readToolResult(
      await client.call('tools/call', { name: 'editor_connect', arguments: {} })
    )
    assert.equal(connected.isError, false)
    assert.equal(connected.data.windowId, 'window-target')

    targetController.abort()
    await targetPage
    await fetch(`http://127.0.0.1:${port}/ai-control/rpc/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance: 'page-target-old' })
    })

    const statePromise = client.call(
      'tools/call',
      { name: 'editor_get_state', arguments: {} },
      15000
    )
    await wait(250)
    refreshedController = new AbortController()
    refreshedPage = runBrowserPage(port, 'page-target-new', refreshedController.signal, {
      windowId: 'window-target',
      bookId: 'book-target-new'
    })
    await waitForInstance(port, 'page-target-new')

    const state = readToolResult(await statePromise)
    assert.equal(state.isError, false)
    assert.equal(state.data.bookInfo.id, 'book-target-new')
    assert.notEqual(state.data.bookInfo.id, 'book-other')
  } finally {
    otherController.abort()
    if (!targetController.signal.aborted) targetController.abort()
    if (refreshedController) refreshedController.abort()
    await Promise.all([otherPage, targetPage, refreshedPage].filter(Boolean))
    await client.close()
  }
})

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
