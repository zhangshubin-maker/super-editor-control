import test from 'node:test'
import assert from 'node:assert/strict'
import { createRpcBrokerServer } from '../rpc-broker.js'

async function createBroker(options = {}) {
  const broker = createRpcBrokerServer({ port: 0, ...options })
  const address = await broker.start()
  return { broker, baseUrl: address.rpcBaseUrl }
}

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { response, body: await response.json() }
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw lastError || new Error('等待条件超时')
}

async function waitForInstance(baseUrl, instance) {
  return waitFor(async () => {
    const response = await fetch(baseUrl + '/instances')
    const instances = await response.json()
    return instances.includes(instance)
  })
}

test('CORS、页面路由、实例校验和重复结果均符合协议', async () => {
  const { broker, baseUrl } = await createBroker()
  try {
    const options = await fetch(baseUrl + '/poll', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://editor.example.com',
        'Access-Control-Request-Private-Network': 'true'
      }
    })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-origin'), '*')
    assert.equal(options.headers.get('access-control-allow-private-network'), 'true')

    const pollPromise = fetch(baseUrl + '/poll?instance=page-a')
    await waitForInstance(baseUrl, 'page-a')

    const claim = await postJson(baseUrl, '/claim', {
      clientId: 'client-a',
      preferredInstance: 'page-a'
    })
    assert.deepEqual(claim.body, { ok: true, instance: 'page-a' })

    const requestPromise = postJson(baseUrl, '/request', {
      method: 'getState',
      args: [],
      targetInstance: 'page-a',
      clientId: 'client-a',
      timeoutMs: 3000
    })
    const commandResponse = await pollPromise
    const command = await commandResponse.json()
    assert.equal(command.method, 'getState')

    const missingInstance = await postJson(baseUrl, '/result', {
      id: command.id,
      ok: true,
      value: { ignored: true }
    })
    assert.equal(missingInstance.response.status, 409)
    assert.equal(missingInstance.body.errorCode, 'INSTANCE_MISMATCH')

    const mismatch = await postJson(baseUrl, '/result', {
      id: command.id,
      instance: 'page-b',
      ok: true,
      value: { ignored: true }
    })
    assert.equal(mismatch.response.status, 409)
    assert.equal(mismatch.body.errorCode, 'INSTANCE_MISMATCH')

    const result = await postJson(baseUrl, '/result', {
      id: command.id,
      instance: 'page-a',
      ok: true,
      value: { slideId: 'slide-1' }
    })
    assert.equal(result.body.accepted, true)

    const request = await requestPromise
    assert.equal(request.body.ok, true)
    assert.deepEqual(request.body.value, { slideId: 'slide-1' })

    const duplicate = await postJson(baseUrl, '/result', {
      id: command.id,
      instance: 'page-a',
      ok: true,
      value: { slideId: 'slide-1' }
    })
    assert.deepEqual(duplicate.body, { ok: true, accepted: false })
  } finally {
    await broker.stop()
  }
})

test('未知的提前结果不会完成仍在队列中的命令', async () => {
  const { broker, baseUrl } = await createBroker()
  try {
    const registrationController = new AbortController()
    const registration = fetch(baseUrl + '/poll?instance=page-queued', {
      signal: registrationController.signal
    }).catch(() => null)
    await waitForInstance(baseUrl, 'page-queued')
    registrationController.abort()
    await registration

    await postJson(baseUrl, '/claim', {
      clientId: 'client-queued',
      preferredInstance: 'page-queued'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      id: 'fixed-request-id',
      method: 'save',
      args: [],
      targetInstance: 'page-queued',
      clientId: 'client-queued',
      timeoutMs: 3000
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    const earlyResult = await postJson(baseUrl, '/result', {
      id: 'fixed-request-id',
      instance: 'page-queued',
      ok: true,
      value: { forged: true }
    })
    assert.equal(earlyResult.body.accepted, false)

    const commandResponse = await fetch(baseUrl + '/poll?instance=page-queued')
    const command = await commandResponse.json()
    assert.equal(command.id, 'fixed-request-id')
    assert.equal(command.method, 'save')

    await postJson(baseUrl, '/result', {
      id: command.id,
      instance: 'page-queued',
      ok: true,
      value: { saved: true }
    })
    const request = await requestPromise
    assert.deepEqual(request.body.value, { saved: true })
  } finally {
    await broker.stop()
  }
})

test('请求客户端中断后，未发往页面的写命令会从队列移除', async () => {
  const { broker, baseUrl } = await createBroker()
  try {
    const registrationController = new AbortController()
    const registration = fetch(baseUrl + '/poll?instance=page-aborted-request', {
      signal: registrationController.signal
    }).catch(() => null)
    await waitForInstance(baseUrl, 'page-aborted-request')
    registrationController.abort()
    await registration

    await postJson(baseUrl, '/claim', {
      clientId: 'client-aborted-request',
      preferredInstance: 'page-aborted-request'
    })

    const requestController = new AbortController()
    const request = fetch(baseUrl + '/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'aborted-save',
        method: 'save',
        args: [],
        targetInstance: 'page-aborted-request',
        clientId: 'client-aborted-request',
        timeoutMs: 3000
      }),
      signal: requestController.signal
    }).catch((error) => error)
    await new Promise((resolve) => setTimeout(resolve, 50))
    requestController.abort()
    const aborted = await request
    assert.equal(aborted.name, 'AbortError')

    await new Promise((resolve) => setTimeout(resolve, 50))
    const pollController = new AbortController()
    const pollTimer = setTimeout(() => pollController.abort(), 250)
    const command = await fetch(baseUrl + '/poll?instance=page-aborted-request', {
      signal: pollController.signal
    })
      .then((response) => response.json())
      .catch(() => null)
    clearTimeout(pollTimer)
    assert.equal(command, null)
  } finally {
    await broker.stop()
  }
})

test('客户端释放页面时会取消属于它的未发送命令', async () => {
  const { broker, baseUrl } = await createBroker()
  try {
    const registrationController = new AbortController()
    const registration = fetch(baseUrl + '/poll?instance=page-released-request', {
      signal: registrationController.signal
    }).catch(() => null)
    await waitForInstance(baseUrl, 'page-released-request')
    registrationController.abort()
    await registration

    await postJson(baseUrl, '/claim', {
      clientId: 'client-released-request',
      preferredInstance: 'page-released-request'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      id: 'released-save',
      method: 'save',
      args: [],
      targetInstance: 'page-released-request',
      clientId: 'client-released-request',
      timeoutMs: 3000
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    await postJson(baseUrl, '/release', {
      clientId: 'client-released-request',
      instance: 'page-released-request'
    })
    const request = await requestPromise
    assert.equal(request.body.errorCode, 'CLIENT_RELEASED_NOT_DISPATCHED')

    const pollController = new AbortController()
    const pollTimer = setTimeout(() => pollController.abort(), 250)
    const command = await fetch(baseUrl + '/poll?instance=page-released-request', {
      signal: pollController.signal
    })
      .then((response) => response.json())
      .catch(() => null)
    clearTimeout(pollTimer)
    assert.equal(command, null)
  } finally {
    await broker.stop()
  }
})

test('已发送命令完成前，释放请求不会让另一客户端插队', async () => {
  const { broker, baseUrl } = await createBroker()
  try {
    const pollPromise = fetch(baseUrl + '/poll?instance=page-release-in-flight')
    await waitForInstance(baseUrl, 'page-release-in-flight')
    await postJson(baseUrl, '/claim', {
      clientId: 'client-flight-owner',
      preferredInstance: 'page-release-in-flight'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      method: 'save',
      args: [],
      targetInstance: 'page-release-in-flight',
      clientId: 'client-flight-owner',
      timeoutMs: 3000
    })
    const commandResponse = await pollPromise
    const command = await commandResponse.json()

    await postJson(baseUrl, '/release', {
      clientId: 'client-flight-owner',
      instance: 'page-release-in-flight'
    })
    const busyClaim = await postJson(baseUrl, '/claim', {
      clientId: 'client-waiting',
      preferredInstance: 'page-release-in-flight'
    })
    assert.equal(busyClaim.body.errorCode, 'INSTANCE_BUSY')

    await postJson(baseUrl, '/result', {
      id: command.id,
      instance: 'page-release-in-flight',
      ok: true,
      value: { saved: true }
    })
    await requestPromise

    const nextClaim = await postJson(baseUrl, '/claim', {
      clientId: 'client-waiting',
      preferredInstance: 'page-release-in-flight'
    })
    assert.equal(nextClaim.body.instance, 'page-release-in-flight')
  } finally {
    await broker.stop()
  }
})

test('租约 TTL 过期也不会中途抢走正在执行命令的页面', async () => {
  const { broker, baseUrl } = await createBroker({ clientLeaseTtlMs: 50 })
  try {
    const pollPromise = fetch(baseUrl + '/poll?instance=page-expired-in-flight')
    await waitForInstance(baseUrl, 'page-expired-in-flight')
    await postJson(baseUrl, '/claim', {
      clientId: 'client-expired-owner',
      preferredInstance: 'page-expired-in-flight'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      method: 'save',
      args: [],
      targetInstance: 'page-expired-in-flight',
      clientId: 'client-expired-owner',
      timeoutMs: 3000
    })
    const commandResponse = await pollPromise
    const command = await commandResponse.json()

    await new Promise((resolve) => setTimeout(resolve, 100))
    await fetch(baseUrl + '/health')
    const busyClaim = await postJson(baseUrl, '/claim', {
      clientId: 'client-after-expiry',
      preferredInstance: 'page-expired-in-flight'
    })
    assert.equal(busyClaim.body.errorCode, 'INSTANCE_BUSY')

    await postJson(baseUrl, '/result', {
      id: command.id,
      instance: 'page-expired-in-flight',
      ok: true,
      value: { saved: true }
    })
    await requestPromise

    const nextClaim = await postJson(baseUrl, '/claim', {
      clientId: 'client-after-expiry',
      preferredInstance: 'page-expired-in-flight'
    })
    assert.equal(nextClaim.body.instance, 'page-expired-in-flight')
  } finally {
    await broker.stop()
  }
})

test('租约 TTL 过期时会先取消旧客户端尚未派发的命令', async () => {
  const { broker, baseUrl } = await createBroker({ clientLeaseTtlMs: 50 })
  try {
    const registrationController = new AbortController()
    const registration = fetch(baseUrl + '/poll?instance=page-expired-queued', {
      signal: registrationController.signal
    }).catch(() => null)
    await waitForInstance(baseUrl, 'page-expired-queued')
    registrationController.abort()
    await registration

    await postJson(baseUrl, '/claim', {
      clientId: 'client-expired-queued',
      preferredInstance: 'page-expired-queued'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      method: 'save',
      args: [],
      targetInstance: 'page-expired-queued',
      clientId: 'client-expired-queued',
      timeoutMs: 3000
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const nextClaim = await postJson(baseUrl, '/claim', {
      clientId: 'client-after-queued-expiry',
      preferredInstance: 'page-expired-queued'
    })
    assert.equal(nextClaim.body.instance, 'page-expired-queued')
    const expiredRequest = await requestPromise
    assert.equal(expiredRequest.body.errorCode, 'CLIENT_LEASE_EXPIRED_NOT_DISPATCHED')

    const pollController = new AbortController()
    const pollTimer = setTimeout(() => pollController.abort(), 250)
    const command = await fetch(baseUrl + '/poll?instance=page-expired-queued', {
      signal: pollController.signal
    })
      .then((response) => response.json())
      .catch(() => null)
    clearTimeout(pollTimer)
    assert.equal(command, null)
  } finally {
    await broker.stop()
  }
})

test('在途命令结束后，页面轮询不会领取已过期租约的后续队列', async () => {
  const { broker, baseUrl } = await createBroker({ clientLeaseTtlMs: 50 })
  try {
    const firstPoll = fetch(baseUrl + '/poll?instance=page-expired-after-flight')
    await waitForInstance(baseUrl, 'page-expired-after-flight')
    await postJson(baseUrl, '/claim', {
      clientId: 'client-expired-after-flight',
      preferredInstance: 'page-expired-after-flight'
    })
    const firstRequest = postJson(baseUrl, '/request', {
      id: 'first-expired-flight',
      method: 'save',
      args: [],
      targetInstance: 'page-expired-after-flight',
      clientId: 'client-expired-after-flight',
      timeoutMs: 3000
    })
    const firstCommandResponse = await firstPoll
    const firstCommand = await firstCommandResponse.json()
    const queuedRequest = postJson(baseUrl, '/request', {
      id: 'queued-after-expired-flight',
      method: 'updateBlock',
      args: [],
      targetInstance: 'page-expired-after-flight',
      clientId: 'client-expired-after-flight',
      timeoutMs: 3000
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    await postJson(baseUrl, '/result', {
      id: firstCommand.id,
      instance: 'page-expired-after-flight',
      ok: true,
      value: { saved: true }
    })
    await firstRequest

    const pollController = new AbortController()
    const pollTimer = setTimeout(() => pollController.abort(), 250)
    const nextCommand = await fetch(baseUrl + '/poll?instance=page-expired-after-flight', {
      signal: pollController.signal
    })
      .then((response) => response.json())
      .catch(() => null)
    clearTimeout(pollTimer)
    assert.equal(nextCommand, null)
    const expiredQueued = await queuedRequest
    assert.equal(expiredQueued.body.errorCode, 'CLIENT_LEASE_EXPIRED_NOT_DISPATCHED')
  } finally {
    await broker.stop()
  }
})

test('broker 关闭时区分未派发和已派发命令', async (t) => {
  await t.test('队列中的命令明确为未派发', async () => {
    const { broker, baseUrl } = await createBroker()
    const registrationController = new AbortController()
    const registration = fetch(baseUrl + '/poll?instance=page-queued-stop', {
      signal: registrationController.signal
    }).catch(() => null)
    await waitForInstance(baseUrl, 'page-queued-stop')
    registrationController.abort()
    await registration

    await postJson(baseUrl, '/claim', {
      clientId: 'client-stop',
      preferredInstance: 'page-queued-stop'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      method: 'save',
      args: [],
      targetInstance: 'page-queued-stop',
      clientId: 'client-stop',
      timeoutMs: 3000
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await broker.stop()
    const request = await requestPromise
    assert.equal(request.body.errorCode, 'BROKER_SHUTDOWN_NOT_DISPATCHED')
  })

  await t.test('已发往页面的命令必须报告结果未知', async () => {
    const { broker, baseUrl } = await createBroker()
    const pollPromise = fetch(baseUrl + '/poll?instance=page-flight-stop')
    await waitForInstance(baseUrl, 'page-flight-stop')
    await postJson(baseUrl, '/claim', {
      clientId: 'client-flight',
      preferredInstance: 'page-flight-stop'
    })
    const requestPromise = postJson(baseUrl, '/request', {
      method: 'save',
      args: [],
      targetInstance: 'page-flight-stop',
      clientId: 'client-flight',
      timeoutMs: 3000
    })
    const commandResponse = await pollPromise
    const command = await commandResponse.json()
    assert.equal(command.method, 'save')
    await broker.stop()
    const request = await requestPromise
    assert.equal(request.body.errorCode, 'OUTCOME_UNKNOWN')
  })
})

test('多个 Codex 客户端会租用不同页面且第三个客户端收到忙提示', async () => {
  const { broker, baseUrl } = await createBroker()
  try {
    const controllers = ['page-1', 'page-2'].map(() => new AbortController())
    const registrations = ['page-1', 'page-2'].map((instance, index) =>
      fetch(baseUrl + '/poll?instance=' + instance, {
        signal: controllers[index].signal
      }).catch(() => null)
    )
    await waitForInstance(baseUrl, 'page-1')
    await waitForInstance(baseUrl, 'page-2')
    controllers.forEach((controller) => controller.abort())
    await Promise.all(registrations)

    const claimA = await postJson(baseUrl, '/claim', {
      clientId: 'client-a',
      preferredInstance: 'page-1'
    })
    const claimB = await postJson(baseUrl, '/claim', {
      clientId: 'client-b',
      preferredInstance: 'page-2'
    })
    const claimC = await postJson(baseUrl, '/claim', { clientId: 'client-c' })
    assert.equal(claimA.body.instance, 'page-1')
    assert.equal(claimB.body.instance, 'page-2')
    assert.equal(claimC.body.errorCode, 'INSTANCE_BUSY')
  } finally {
    await broker.stop()
  }
})

test('刷新重连只认领原窗口，其他书本窗口不会成为回退目标', async () => {
  const { broker, baseUrl } = await createBroker()
  const controllers = []
  const registrations = []
  const register = (instance, windowId) => {
    const controller = new AbortController()
    controllers.push(controller)
    const query =
      '?instance=' + encodeURIComponent(instance) + '&windowId=' + encodeURIComponent(windowId)
    registrations.push(
      fetch(baseUrl + '/poll' + query, { signal: controller.signal }).catch(() => null)
    )
  }
  try {
    register('page-other', 'window-other')
    register('page-target-old', 'window-target')
    await waitForInstance(baseUrl, 'page-other')
    await waitForInstance(baseUrl, 'page-target-old')

    const initial = await postJson(baseUrl, '/claim', {
      clientId: 'client-window-pinned',
      preferredInstance: 'page-target-old'
    })
    assert.equal(initial.body.instance, 'page-target-old')
    assert.equal(initial.body.windowId, 'window-target')

    await postJson(baseUrl, '/unregister', { instance: 'page-target-old' })
    const whileRefreshing = await postJson(baseUrl, '/claim', {
      clientId: 'client-window-pinned',
      preferredWindowId: 'window-target'
    })
    assert.equal(whileRefreshing.body.errorCode, 'WINDOW_NOT_FOUND')
    assert.notEqual(whileRefreshing.body.instance, 'page-other')

    register('page-target-new', 'window-target')
    await waitForInstance(baseUrl, 'page-target-new')
    const reconnected = await postJson(baseUrl, '/claim', {
      clientId: 'client-window-pinned',
      preferredWindowId: 'window-target'
    })
    assert.equal(reconnected.body.instance, 'page-target-new')
    assert.equal(reconnected.body.windowId, 'window-target')

    register('page-target-duplicate', 'window-target')
    await waitForInstance(baseUrl, 'page-target-duplicate')
    const ambiguous = await postJson(baseUrl, '/claim', {
      clientId: 'client-window-pinned',
      preferredWindowId: 'window-target'
    })
    assert.equal(ambiguous.body.errorCode, 'WINDOW_AMBIGUOUS')
  } finally {
    controllers.forEach((controller) => controller.abort())
    await Promise.all(registrations)
    await broker.stop()
  }
})

test('刷新重连可排除仍存活的旧实例并认领同窗口新实例', async () => {
  const { broker, baseUrl } = await createBroker()
  const controllers = []
  const registrations = []
  const register = (instance, windowId) => {
    const controller = new AbortController()
    controllers.push(controller)
    const query =
      '?instance=' + encodeURIComponent(instance) + '&windowId=' + encodeURIComponent(windowId)
    registrations.push(
      fetch(baseUrl + '/poll' + query, { signal: controller.signal }).catch(() => null)
    )
  }
  try {
    register('page-refresh-old-live', 'window-refresh-overlap')
    register('page-refresh-new', 'window-refresh-overlap')
    await waitForInstance(baseUrl, 'page-refresh-old-live')
    await waitForInstance(baseUrl, 'page-refresh-new')

    const ambiguous = await postJson(baseUrl, '/claim', {
      clientId: 'client-refresh-overlap',
      preferredWindowId: 'window-refresh-overlap'
    })
    assert.equal(ambiguous.body.errorCode, 'WINDOW_AMBIGUOUS')

    const reconnected = await postJson(baseUrl, '/claim', {
      clientId: 'client-refresh-overlap',
      preferredWindowId: 'window-refresh-overlap',
      excludedInstance: 'page-refresh-old-live'
    })
    assert.equal(reconnected.body.instance, 'page-refresh-new')
    assert.equal(reconnected.body.windowId, 'window-refresh-overlap')
  } finally {
    controllers.forEach((controller) => controller.abort())
    await Promise.all(registrations)
    await broker.stop()
  }
})
