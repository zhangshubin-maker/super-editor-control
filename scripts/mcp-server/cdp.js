// 最小 CDP (Chrome DevTools Protocol) 客户端：零依赖，基于 Node 22 内置 WebSocket / fetch。

export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.ws = null
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
  }

  async connect(timeoutMs = 10000) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 版本没有全局 WebSocket，请使用 Node.js >= 22')
    }
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
      this.ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('CDP WebSocket 连接失败: ' + this.wsUrl))
        },
        { once: true }
      )
    })
    this.ws.addEventListener('message', (event) => this._onMessage(event))
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
    return this
  }

  _onMessage(event) {
    let msg
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    if (msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error('CDP 错误 ' + msg.error.code + ': ' + msg.error.message))
      else entry.resolve(msg.result)
    }
  }

  send(method, params = {}) {
    if (this.closed || !this.ws) return Promise.reject(new Error('CDP 未连接'))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.closed = true
    try {
      if (this.ws) this.ws.close()
    } catch {
      // ignore
    }
  }
}

// 在页面上下文执行表达式，返回按值序列化的结果（awaitPromise + returnByValue）。
export async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception
    const text = detail && detail.description ? detail.description : res.exceptionDetails.text
    throw new Error('页面执行异常: ' + String(text || 'unknown'))
  }
  return res.result && res.result.value
}