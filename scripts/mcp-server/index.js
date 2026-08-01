// Super Editor Control MCP 服务端（stdio + JSON-RPC，零依赖）。
// 通过 CDP 连接浏览器页面，把 window.__superEditor 桥接 API 包装成 editor_* 工具。
// 运行：node index.js（可在环境变量 SUPER_EDITOR_MOCK=1 时 mock 测试）。
import { createInterface } from 'node:readline'
import * as driver from './driver.js'

const SERVER_INFO = { name: 'super-editor-control-mcp', version: '0.1.0' }

const TOOLS = [
  {
    name: 'editor_status',
    description: '返回 MCP 与页面的连接状态、页面 URL、桥接是否就绪、是否 mock 模式。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_connect',
    description: '连接到一个已打开编辑器页面的浏览器（CDP）。httpUrl 默认 http://127.0.0.1:9222；pageUrl 是页面 URL 的包含片段，省略时连接第一个页面。',
    inputSchema: {
      type: 'object',
      properties: {
        httpUrl: { type: 'string', description: 'CDP HTTP 地址，如 http://127.0.0.1:9222' },
        pageUrl: { type: 'string', description: '要匹配的页面 URL 片段' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_open',
    description: '在已启动 remote debugging 的浏览器中新开标签页并连接。url 为目标地址（如 /content-editor?book_id=xxx&ai_control=1）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 URL' },
        httpUrl: { type: 'string', description: 'CDP HTTP 地址，默认 http://127.0.0.1:9222' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_state',
    description: '获取当前课件整体状态：书本信息、页面(slide)列表、当前页、选中元素、脏标记。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_list_slides',
    description: '列出当前课件的页面列表。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_get_slide',
    description: '获取某一页的完整结构：区块列表与元素树。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' } },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_select_slide',
    description: '切换到指定页面。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' } },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_block',
    description: '新增区块。afterBlockId 省略时追加到末尾。',
    inputSchema: {
      type: 'object',
      properties: {
        afterBlockId: { type: 'string', description: '插入到哪个区块之后' },
        size: { type: 'object', description: '区块尺寸，如 { width: 794, height: 300 }' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_update_block',
    description: '更新区块属性（如 name、size.height）。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string' },
        patch: { type: 'object', description: '要合并的区块属性' }
      },
      required: ['blockId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_block',
    description: '删除区块及其下所有元素。',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string' } },
      required: ['blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_element',
    description: '在指定区块内新增元素。type 参考元素类型体系：text/image/shape/line/chart/table/video/audio/mind/pdfpage/latex/bracket/connectLine/input/outline/tab/textarea 等。payload 为元素数据。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '所属区块 uuid' },
        type: { type: 'string' },
        payload: { type: 'object', description: '元素数据（坐标、尺寸、文本、样式等）' }
      },
      required: ['blockId', 'type', 'payload'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_update_element',
    description: '修改元素属性（patch 合并进元素数据）。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        patch: { type: 'object' }
      },
      required: ['elementId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_element',
    description: '删除指定元素。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string' } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_group_elements',
    description: '将多个元素打组。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_ungroup',
    description: '拆分组（groupId 为 type=group 元素的 id）。',
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'string' } },
      required: ['groupId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_order_element',
    description: '调整元素层级。position 取值：front 置顶 / forward 上移一层 / backward 下移一层 / back 置底。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        position: { type: 'string', enum: ['front', 'forward', 'backward', 'back'] }
      },
      required: ['elementId', 'position'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_undo',
    description: '撤销上一步操作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_redo',
    description: '重做上一步操作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_save',
    description: '保存当前课件（走编辑器既有保存流程）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_screenshot',
    description: '截取当前画布区域（优先桥接截图，失败时回退整页截图），返回 data URL。',
    inputSchema: {
      type: 'object',
      properties: { fullPage: { type: 'boolean', description: '是否整页截图' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_eval',
    description: '低层逃生通道：在页面执行任意 JS 表达式并返回结果。仅当桥接 API 覆盖不了时使用。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false
    }
  }
]

class McpError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function callTool(name, args) {
  let data
  switch (name) {
    case 'editor_status': {
      data = { ...driver.pageInfo() }
      if (driver.isConnected()) {
        try {
          await driver.bridgeCall('ping')
          data.bridgeReady = true
        } catch (err) {
          data.bridgeReady = false
          data.bridgeError = err.message
        }
      }
      break
    }
    case 'editor_connect':
      data = await driver.connect(args.httpUrl, args.pageUrl)
      break
    case 'editor_open':
      data = await driver.openTab(args.httpUrl, args.url)
      break
    case 'editor_get_state':
      data = await driver.bridgeCall('getState')
      break
    case 'editor_list_slides':
      data = await driver.bridgeCall('listSlides')
      break
    case 'editor_get_slide':
      data = await driver.bridgeCall('getSlide', [args.slideId])
      break
    case 'editor_select_slide':
      data = await driver.bridgeCall('selectSlide', [args.slideId])
      break
    case 'editor_add_block':
      data = await driver.bridgeCall('addBlock', [args])
      break
    case 'editor_update_block':
      data = await driver.bridgeCall('updateBlock', [args])
      break
    case 'editor_delete_block':
      data = await driver.bridgeCall('deleteBlock', [args])
      break
    case 'editor_add_element':
      data = await driver.bridgeCall('addElement', [args])
      break
    case 'editor_update_element':
      data = await driver.bridgeCall('updateElement', [args])
      break
    case 'editor_delete_element':
      data = await driver.bridgeCall('deleteElement', [args])
      break
    case 'editor_group_elements':
      data = await driver.bridgeCall('groupElements', [args])
      break
    case 'editor_ungroup':
      data = await driver.bridgeCall('ungroup', [args])
      break
    case 'editor_order_element':
      data = await driver.bridgeCall('orderElement', [args])
      break
    case 'editor_undo':
      data = await driver.bridgeCall('undo')
      break
    case 'editor_redo':
      data = await driver.bridgeCall('redo')
      break
    case 'editor_save':
      data = await driver.bridgeCall('save')
      break
    case 'editor_screenshot':
      data = await driver.captureScreenshot({ fullPage: !!args.fullPage })
      break
    case 'editor_eval':
      data = await driver.evalPage(args.expression)
      break
    default:
      throw new McpError(-32601, 'Unknown tool: ' + name)
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

async function handleRequest(req) {
  switch (req.method) {
    case 'initialize': {
      const requested = req.params && req.params.protocolVersion
      const version = requested && typeof requested === 'string' ? requested : '2025-06-18'
      return {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(req.params && req.params.name, (req.params && req.params.arguments) || {})
    default:
      throw new McpError(-32601, 'Method not found: ' + req.method)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    // EPIPE 等：客户端已断开
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    return
  }
  if (!req.id) return // 通知类消息（notifications/initialized 等）
  handleRequest(req).then(
    (result) => send({ jsonrpc: '2.0', id: req.id, result }),
    (err) => {
      if (err instanceof McpError) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message } })
      } else {
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: '[error] ' + err.message }], isError: true }
        })
      }
    }
  )
})

process.on('SIGINT', () => {
  driver.closeActive()
  process.exit(0)
})
process.on('SIGTERM', () => {
  driver.closeActive()
  process.exit(0)
})