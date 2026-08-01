// 驱动器：管理 CDP 连接，并把 window.__superEditor 桥接 API 封装为可调用函数。
// 设置环境变量 SUPER_EDITOR_MOCK=1 可进入 mock 模式（不连接浏览器，便于测试 MCP 服务本身）。
import { CdpConnection, evaluate } from './cdp.js'

const DEFAULT_CDP_HTTP = process.env.SUPER_EDITOR_CDP_URL || 'http://127.0.0.1:9222'
const MOCK = process.env.SUPER_EDITOR_MOCK === '1'

let active = null // { cdp, page: { url }, httpUrl, mock }

export function isMock() {
  return MOCK
}

export function isConnected() {
  return !!active
}

export function pageInfo() {
  if (!active) return { connected: false, mock: MOCK }
  return { connected: true, mock: MOCK, pageUrl: active.page.url }
}

async function fetchJson(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) {
    throw new Error(
      'CDP HTTP ' + res.status + ' ' + res.statusText + '（' + url + '）。请确认浏览器已用 --remote-debugging-port 启动。'
    )
  }
  return res.json()
}

async function listPages(httpUrl) {
  return fetchJson(httpUrl + '/json/list')
}

function pickPage(pages, urlPattern) {
  const targets = (pages || []).filter((p) => p.type === 'page' && p.webSocketDebuggerUrl)
  if (!targets.length) {
    const urls = (pages || []).map((p) => p.url).join(' | ') || '无'
    throw new Error('CDP 端点上没有可用的页面标签。已打开的标签：' + urls)
  }
  if (!urlPattern) return targets[0]
  const hit = targets.find((p) => p.url.includes(urlPattern)) || targets.find((p) => p.url.startsWith(urlPattern))
  if (!hit) {
    throw new Error('没有 URL 包含 "' + urlPattern + '" 的页面。已打开的页面：' + targets.map((p) => p.url).join(' | '))
  }
  return hit
}

export async function connect(httpUrl, urlPattern) {
  const base = httpUrl || DEFAULT_CDP_HTTP
  if (MOCK) {
    active = { cdp: null, page: { url: 'mock://super-editor' }, httpUrl: base, mock: true }
    return { pageUrl: 'mock://super-editor', title: 'MOCK' }
  }
  const page = pickPage(await listPages(base), urlPattern)
  const cdp = new CdpConnection(page.webSocketDebuggerUrl)
  await cdp.connect()
  await closeActive()
  active = { cdp, page: { url: page.url }, httpUrl: base }
  return { pageUrl: page.url, title: page.title }
}

export async function openTab(httpUrl, url) {
  if (!url) throw new Error('缺少 url 参数')
  const base = httpUrl || DEFAULT_CDP_HTTP
  if (MOCK) {
    active = { cdp: null, page: { url }, httpUrl: base, mock: true }
    return { pageUrl: url, mock: true }
  }
  const info = await fetchJson(base + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })
  const cdp = new CdpConnection(info.webSocketDebuggerUrl)
  await cdp.connect()
  await closeActive()
  active = { cdp, page: { url: info.url }, httpUrl: base }
  return { pageUrl: info.url }
}

export async function closeActive() {
  if (active && active.cdp) {
    try {
      active.cdp.close()
    } catch {
      // ignore
    }
  }
  active = null
}

function buildBridgeExpression(method, args) {
  const argExpr = (args || []).map((a) => JSON.stringify(a)).join(', ')
  return (
    '(async () => {\n' +
    "  const b = window.__superEditor\n" +
    "  if (!b) return { ok: false, code: 'BRIDGE_MISSING', message: 'window.__superEditor 不存在：请确认以 ai_control=1 打开编辑器页面且桥接层已实现' }\n" +
    "  if (typeof b." + method + " !== 'function') return { ok: false, code: 'NO_METHOD', message: '桥接方法 " + method + " 不存在' }\n" +
    '  try {\n' +
    '    const data = await b.' + method + '(' + argExpr + ')\n' +
    '    return { ok: true, data: data === undefined ? null : data }\n' +
    '  } catch (err) {\n' +
    "    return { ok: false, code: 'BRIDGE_ERROR', message: String((err && err.message) || err) }\n" +
    '  }\n' +
    '})()'
  )
}

export async function bridgeCall(method, args = []) {
  if (MOCK) return mockResult(method, args)
  if (!active) throw new Error('尚未连接页面：请先调用 editor_connect 或 editor_open')
  const out = await evaluate(active.cdp, buildBridgeExpression(method, args))
  if (!out || typeof out !== 'object') {
    throw new Error('桥接调用 ' + method + ' 返回异常: ' + JSON.stringify(out))
  }
  if (!out.ok) throw new Error('[' + out.code + '] ' + out.message)
  return out.data
}

export async function evalPage(expression) {
  if (!expression) throw new Error('缺少 expression 参数')
  if (MOCK) return { mock: true, expression }
  if (!active) throw new Error('尚未连接页面：请先调用 editor_connect 或 editor_open')
  return evaluate(active.cdp, expression)
}

export async function captureScreenshot({ fullPage = false } = {}) {
  if (MOCK) return TINY_PNG_DATA_URL
  if (!active) throw new Error('尚未连接页面：请先调用 editor_connect 或 editor_open')
  try {
    const data = await bridgeCall('screenshot')
    if (typeof data === 'string' && data.startsWith('data:image')) return data
  } catch {
    // 桥接没有 screenshot 时回退为整页截图
  }
  const result = await active.cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: !!fullPage
  })
  return 'data:image/png;base64,' + result.data
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
    default:
      return { mocked: true, method, args }
  }
}