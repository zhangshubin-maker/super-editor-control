// Super Editor Control MCP 服务端（stdio + JSON-RPC + 本机浏览器 RPC 中继，零依赖）。
// 浏览器页面轮询 127.0.0.1:8765，MCP 工具自动连接最近开启“AI 控制”的页面。
// 运行：node index.js（可在环境变量 SUPER_EDITOR_MOCK=1 时 mock 测试）。
import { createInterface } from 'node:readline'
import * as driver from './driver.js'
import { BOOK_AUTHORING_TOOLS, prepareBookAuthoringCall } from './bookAuthoring.js'
import {
  normalizeSemanticSnapshotBridgeError,
  persistSemanticSnapshot
} from './semanticSnapshotFile.js'

const SERVER_INFO = { name: 'super-editor-control-mcp', version: '0.9.0' }

const ID_SCHEMA = { type: ['string', 'number'] }
const ID_LIST_SCHEMA = {
  type: 'array',
  items: { type: ['string', 'number'] }
}
const QUESTION_FILTER_PROPERTIES = {
  period: { ...ID_SCHEMA, description: '学段 id' },
  subjectId: { ...ID_SCHEMA, description: '学科 id' },
  gradeId: { ...ID_SCHEMA, description: '年级 id' },
  volume: { ...ID_SCHEMA, description: '册次/学期 id' },
  difficulty: { ...ID_SCHEMA, description: '难度 id，通常为 1-5' },
  features: { ...ID_LIST_SCHEMA, description: '题目特征 id 列表' },
  guidList: {
    type: 'array',
    items: { type: 'string' },
    description: '限定题目 GUID 列表'
  },
  haveResolution: { type: ['boolean', 'number'], description: '是否有解析' },
  haveReview: { type: ['boolean', 'number'], description: '是否有点评' },
  haveSolution: { type: ['boolean', 'number'], description: '是否有解答' },
  haveSolutionVideo: { type: ['boolean', 'number'], description: '是否有解题视频' },
  subModelIds: { ...ID_LIST_SCHEMA, description: '题型 id 列表' },
  searchAreaTypes: { ...ID_LIST_SCHEMA, description: '检索区域类型列表' },
  sourceInfos: {
    type: 'array',
    items: { type: ['object', 'string', 'number'] },
    description: '来源筛选列表'
  },
  businessTypes: { ...ID_LIST_SCHEMA, description: '业务类型列表' },
  haveTag: { type: ['boolean', 'number'], description: '是否有知识点/标签' },
  tagNodeIds: { ...ID_LIST_SCHEMA, description: '知识点/标签节点 id 列表' }
}

const TEXT_WAIT_SCHEMA = {
  type: 'number',
  minimum: 0,
  maximum: 10000,
  description: '渲染和尺寸重测等待上限（毫秒），默认 2000'
}
const TEXT_INDEX_SCHEMA = {
  type: 'integer',
  minimum: 0,
  description: 'UTF-16 / Quill 字符索引；内嵌对象长度按 1 计算'
}
const TEXT_TARGET_KINDS = ['element', 'tableCell', 'mindNode']
const TEXT_TARGET_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: TEXT_TARGET_KINDS,
      description: '富文本目标类型：普通文本元素、表格单元格或思维导图节点'
    },
    elementId: { ...ID_SCHEMA, description: 'kind=element 时的文本元素 id' },
    tableId: { ...ID_SCHEMA, description: 'kind=tableCell 时的表格元素 id' },
    cellId: { ...ID_SCHEMA, description: '稳定单元格 id；可替代 row + col' },
    row: { type: 'integer', minimum: 0, description: '0-based 行下标，需与 col 同时提供' },
    col: { type: 'integer', minimum: 0, description: '0-based 列下标，需与 row 同时提供' },
    mindId: { ...ID_SCHEMA, description: 'kind=mindNode 时的思维导图元素 id' },
    nodeId: { ...ID_SCHEMA, description: 'kind=mindNode 时的节点 data.id' }
  },
  required: ['kind'],
  description:
    '按 kind 提供字段：element 需要 elementId；tableCell 需要 tableId + cellId 或 row+col；mindNode 需要 mindId+nodeId。运行时会严格校验。',
  additionalProperties: false
}
const TEXT_TARGET_PROPERTIES = {
  elementId: {
    type: 'string',
    minLength: 1,
    description: '兼容旧调用：普通文本元素 id；与 target 二选一'
  },
  target: {
    ...TEXT_TARGET_SCHEMA,
    description: '统一富文本目标；与 legacy elementId 二选一'
  }
}
// 不在 Codex-facing schema 顶层使用 oneOf/allOf。Codex 的工具声明转换器会因此把
// 整个参数退化为 Record<string, unknown>；exact-one 关系由 validateTextTargetSelector 校验。
const TEXT_TARGET_SELECTOR_SCHEMA = {}
const TEXT_FORMAT_PROPERTIES = {
  fontName: { type: 'string' },
  fontChinese: { type: 'string' },
  fontEnglish: { type: 'string' },
  fontNumber: { type: 'string' },
  fontSize: { type: 'number', minimum: 1, maximum: 200 },
  color: { type: ['string', 'null'] },
  background: { type: ['string', 'null'] },
  bold: { type: ['boolean', 'number', 'null'] },
  fontWeight: { type: ['number', 'string', 'null'] },
  italic: { type: ['boolean', 'null'] },
  script: { type: ['string', 'boolean', 'null'], enum: ['super', 'sub', 'normal', false, null] },
  underline: { type: ['boolean', 'string', 'object', 'null'] },
  strike: { type: ['boolean', 'string', 'object', 'null'] },
  wave: { type: ['boolean', 'object', 'null'] },
  emphasis: { type: ['boolean', 'object', 'null'] },
  deleteBox: { type: ['boolean', 'object', 'null'] },
  align: { type: ['string', 'null'], enum: ['left', 'center', 'right', 'justify', null] },
  justifyLast: { type: ['string', 'null'], enum: ['left', 'center', 'right', null] },
  lineHeight: { type: ['number', 'string', 'null'] },
  letterSpacing: { type: ['number', 'string', 'null'] },
  wordSpace: { type: ['number', 'string', 'null'] },
  paragraphBefore: { type: ['number', 'string', 'null'] },
  paragraphAfter: { type: ['number', 'string', 'null'] },
  paragraphSpacing: { type: ['number', 'string', 'null'] },
  indent: { type: ['number', 'string', 'null'] },
  textIndent: { type: ['number', 'string', 'null'] },
  list: { type: ['object', 'string', 'boolean', 'null'] }
}
const TEXT_DEFAULT_STYLE_PROPERTIES = {
  fontName: TEXT_FORMAT_PROPERTIES.fontName,
  fontChinese: TEXT_FORMAT_PROPERTIES.fontChinese,
  fontEnglish: TEXT_FORMAT_PROPERTIES.fontEnglish,
  fontNumber: TEXT_FORMAT_PROPERTIES.fontNumber,
  fontSize: TEXT_FORMAT_PROPERTIES.fontSize,
  color: TEXT_FORMAT_PROPERTIES.color,
  bold: TEXT_FORMAT_PROPERTIES.bold,
  fontWeight: TEXT_FORMAT_PROPERTIES.fontWeight,
  italic: TEXT_FORMAT_PROPERTIES.italic,
  lineHeight: TEXT_FORMAT_PROPERTIES.lineHeight,
  wordSpace: TEXT_FORMAT_PROPERTIES.wordSpace,
  letterSpacing: TEXT_FORMAT_PROPERTIES.letterSpacing,
  justifyLast: TEXT_FORMAT_PROPERTIES.justifyLast
}
const TEXT_LAYOUT_PROPERTIES = {
  extendType: { type: 'string', enum: ['both', 'horizontal', 'vertical', 'none'] },
  maxWidth: { type: ['number', 'string', 'null'] },
  maxHeight: { type: ['number', 'string', 'null'] },
  overflowType: {
    type: ['array', 'null'],
    items: { type: 'string', enum: ['auto', 'overWithBreak', 'overSizeScroll'] },
    uniqueItems: true
  },
  paddingTop: { type: 'number', minimum: 0 },
  paddingBottom: { type: 'number', minimum: 0 },
  paddingLeft: { type: 'number', minimum: 0 },
  paddingRight: { type: 'number', minimum: 0 },
  textAlign: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
  verticalAlign: { type: 'string', enum: ['top', 'middle', 'bottom'] },
  vertical: { type: 'boolean' },
  vAlignBottom: { type: 'boolean' },
  alignJustifyLast: { type: ['string', 'null'], enum: ['left', 'center', 'right', null] },
  adaptive: { type: ['boolean', 'string', 'number', 'null'] },
  lineHeight: { type: ['number', 'string', 'null'] },
  wordSpace: { type: ['number', 'string', 'null'] },
  background: { type: ['object', 'null'], description: '与现有 background 深合并，不整体覆盖' },
  fill: {
    type: ['object', 'null'],
    properties: {
      enabled: { type: 'boolean' },
      color: { type: ['string', 'null'] }
    },
    minProperties: 1,
    additionalProperties: false,
    description: '文本框填充配置；null 会禁用并清空，清除颜色传 { color: null }，禁用传 { enabled: false }'
  },
  outline: { type: ['object', 'null'], description: '与现有 outline 深合并' },
  shadow: { type: ['object', 'null'], description: '与现有 shadow 深合并' },
  borderRadius: { type: ['number', 'string', 'object', 'null'] },
  pinyinStyle: { type: ['object', 'null'] },
  listIndentOffset: { type: ['number', 'null'] },
  listOrderedIndents: { type: ['array', 'null'], items: { type: 'object' } },
  listBulletIndents: { type: ['array', 'null'], items: { type: 'object' } }
}

const TOOLS = [
  {
    name: 'editor_status',
    description: '返回插件本地 RPC 中继、浏览器页面自动连接状态、固定路由的页面实例 ID 和桥接是否就绪。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_connect',
    description: '自动连接最近在浏览器中开启“AI 控制”的编辑器页面。通常无需手动调用，其他工具首次使用时也会自动连接。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_user_info',
    description: '获取当前登录用户信息。默认优先使用编辑器已加载的用户状态，缺失时自动请求账号接口；refresh=true 强制刷新。',
    inputSchema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '是否强制重新请求用户信息' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_search_books',
    description: '搜索当前用户可访问的书本，默认查询 AI 教辅（type=6）。支持名称、教辅交互类型、学科、年级、学期和分页筛选，返回可用于克隆创建或跳转的书本 id。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '书本名称关键词' },
        bookType: { type: 'number', description: '书本类型，默认 6（AI 教辅）' },
        smartBookType: { type: ['string', 'number'], description: '1/PDF交互型、2/软件交互型、3/超媒交互型、4/界面交互型' },
        subjectId: { type: ['string', 'number'], description: '学科 id；默认 -1' },
        gradeId: { type: ['string', 'number'], description: '年级 id；默认 -1' },
        period: { type: ['string', 'number'], description: '学段 id；默认 -1' },
        volume: { type: ['string', 'number'], description: '学期；默认 -1' },
        ifHasPdf: { type: 'number', enum: [-1, 0, 1], description: '是否有 PDF' },
        ifHasPath: { type: 'number', enum: [-1, 0, 1], description: '是否有学习路径' },
        pageNo: { type: 'number', description: '页码，从 0 开始，默认 0' },
        pageSize: { type: 'number', description: '每页数量，默认 20' },
        filters: { type: 'object', description: '透传给 getbooklist 的其他高级筛选字段' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_book',
    description: '读取一本书的完整属性、学科、关联教材、分类和版本信息；创建前用于核对源书。',
    inputSchema: {
      type: 'object',
      properties: { bookId: { type: ['string', 'number'], description: '书本 id' } },
      required: ['bookId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_create_book',
    description: '基于现有源书创建新书。默认 copyMode=light，只继承书本外部属性，不复制目录和内容；仅在明确需要完整副本时使用 full。可覆盖名称、后台名称、教辅交互类型和封面。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceBookId: { type: ['string', 'number'], description: '必填：作为克隆基线的源书 id' },
        copyMode: { type: 'string', enum: ['light', 'full'], description: '复制模式：light 仅复制书本属性（默认）；full 同时复制目录和内容' },
        name: { type: 'string', description: '新书名称；light 模式省略时默认为“源书名_copy”' },
        backgroundName: { type: 'string', description: '新书后台名称；省略时继承复制结果' },
        smartBookType: { type: ['string', 'number'], description: '1/PDF交互型、2/软件交互型、3/超媒交互型、4/界面交互型' },
        coverImagePath: { type: 'string', description: '本地封面图片路径；工具会先上传，再写入封面文件 id/URL' },
        coverImgId: { type: ['string', 'number'], description: '已有封面文件 id' },
        coverImgUrl: { type: 'string', description: '已有封面 URL，通常与 coverImgId 一起传' },
        coverType: { type: 'number', enum: [0, 1], description: '封面样式：0 竖版，1 横版' },
        includeToken: { type: 'boolean', description: '返回的编辑器 URL 是否包含登录 token，默认 false' }
      },
      required: ['sourceBookId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_jump_to_book',
    description: '生成或执行书本编辑器跳转。target=url 仅返回 URL；current 优先在原页面和原 RPC 实例内原子热切书，并等待目标 bookId、contextEpoch 和内容状态收敛：普通书必须有当前目录且 contentReady=true，emptyBook 或 currentSlidePlaceholder=true 是显式可就绪例外；旧 Bridge 或热切失败时兼容无这些字段的完整刷新，排除发出导航的旧 instanceId，并只接回同一 windowId 的新实例；new 尝试打开新标签页。book_id、business_id、Scope、token 和 ai_control=1 必须且只能放在 #/content-editor 后的路由查询参数中，不得拼在 hash 前的外层查询串。',
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { type: ['string', 'number'], description: '目标书本 id' },
        target: { type: 'string', enum: ['url', 'current', 'new'], description: '默认 url；current 优先原实例热切书，必要时完整刷新兜底' },
        includeToken: { type: 'boolean', description: 'URL 是否包含登录 token，默认 false' },
        saveBeforeSwitch: { type: 'boolean', description: 'target=current 且当前页 dirty 时，是否先保存并回读验证；默认 false，dirty 时拒绝切换' }
      },
      required: ['bookId'],
      additionalProperties: false
    }
  },
  ...BOOK_AUTHORING_TOOLS,
  {
    name: 'editor_search_templates',
    description: '搜索本书或模板中心的模板。scope=book（默认）搜索本书当前可用模板；scope=center 搜索模板中心且必须用 interactionType 指定超媒/界面交互型。kind=chapter 搜索样章模板，kind=block 搜索区块模板。返回模板 id、名称、适配类型、封面和分类信息。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['book', 'center'],
          description: '搜索范围，默认 book；center 不附带当前 book_id'
        },
        kind: { type: 'string', enum: ['chapter', 'block'], description: '模板种类，默认 chapter' },
        interactionType: {
          type: 'string',
          enum: ['hypermedia', 'interface'],
          description: '模板适配类型；scope=center 时必填。hypermedia 映射 suit_type=1，interface 映射 suit_type=2'
        },
        query: { type: 'string', description: '模板名称关键词' },
        pageNo: { type: 'integer', minimum: 0, description: '页码，从 0 开始，默认 0' },
        pageSize: { type: 'integer', minimum: 1, maximum: 100, description: '每页数量，默认 50' },
        classifyId: { type: ['string', 'number'], description: '模板分类 id' },
        parentId: { type: ['string', 'number'], description: '父模板 id；搜索样章下属区块时使用' },
        timeSort: { type: 'number', description: '时间排序，默认 2' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_template',
    description: '根据模板 id 读取本书或模板中心的样章/区块详情及完整模板内容，供应用前理解其结构与素材。parseContent 默认 true，会尽量把 content JSON 解析为对象。',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: ['string', 'number'], description: '模板 id' },
        parseContent: { type: 'boolean', description: '是否解析 content JSON，默认 true' }
      },
      required: ['templateId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_apply_template',
    description: '应用 editor_search_templates/editor_get_template 返回的模板 id：kind=chapter 时按样章模板新增并选中目录（立即写库）；kind=block 时把区块模板插入当前页工作副本，完成后用 editor_save_verified(scope=current) 保存并回读。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['chapter', 'block'] },
        templateId: { type: ['string', 'number'], description: '模板 id' },
        name: { type: 'string', description: '新目录或新区块名称' },
        parentId: { type: ['string', 'number'], description: '新增目录的父目录 id；0/省略为根目录' },
        index: { type: 'integer', minimum: 0, description: '区块插入下标；省略时追加' },
        afterBlockId: { type: 'string', description: '插到该区块之后；优先于 index' },
        saveBeforeSwitch: {
          type: 'boolean',
          description: 'kind=chapter 且当前页 dirty 时，先保存并回读再新增和切换'
        },
        discardChanges: {
          type: 'boolean',
          description: 'kind=chapter 且当前页 dirty 时，明确丢弃当前页改动再新增和切换'
        }
      },
      required: ['kind', 'templateId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_search_components',
    description: '搜索组件库。scope=system/mine/all，classifyType=1 为排版组件、2 为数据组件。结果包含封面、版本与是否有可应用内容。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '组件名称关键词' },
        scope: { type: 'string', enum: ['all', 'system', 'mine'], description: '组件范围，默认 all' },
        classifyType: { type: 'number', enum: [1, 2], description: '1=排版组件，2=数据组件' },
        classifyId: { type: ['string', 'number'], description: '组件分类 id' },
        limit: { type: 'number', description: '最多返回数量，默认 50' },
        includeContent: { type: 'boolean', description: '是否包含可能很大的组件 content，默认 false' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_apply_component',
    description: '把组件库中的组件应用到指定区块，自动生成新元素 id、居中或放到指定坐标，并记录组件使用历史。',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: { type: ['string', 'number'], description: '组件 id' },
        blockId: { type: 'string', description: '目标区块 uuid' },
        scope: { type: 'string', enum: ['all', 'system', 'mine'], description: '组件范围，默认 all' },
        left: { type: 'number', description: '组件包围盒左上角 X；省略时在区块内居中' },
        top: { type: 'number', description: '组件包围盒左上角 Y；省略时在区块内居中' }
      },
      required: ['componentId', 'blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_search_images',
    description: '搜索图片/素材库。scope=book 仅本书素材，global 为总素材库，all 合并两者；返回素材 URL、格式、尺寸和分组，可直接用于设计。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '图片素材名称关键词' },
        scope: { type: 'string', enum: ['book', 'global', 'all'], description: '图片库范围，默认 book' },
        groupId: { type: ['string', 'number'], description: '素材分组 id' },
        bookId: { type: ['string', 'number'], description: '书本 id，默认当前书本' },
        limit: { type: 'number', description: '最多返回数量，默认 50' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_apply_image',
    description: '使用图片库素材：传 blockId 可新增图片元素；传 elementId 可替换已有图片。imageId 来自 editor_search_images，也可直接传 url。',
    inputSchema: {
      type: 'object',
      properties: {
        imageId: { type: ['string', 'number'], description: '图片素材 id（与 url 二选一）' },
        url: { type: 'string', description: '已有素材 URL（与 imageId 二选一）' },
        scope: { type: 'string', enum: ['book', 'global', 'all'], description: '查找 imageId 的范围，默认 all' },
        blockId: { type: 'string', description: '新增图片时的目标区块 uuid' },
        elementId: { type: 'string', description: '替换已有图片时的元素 id' },
        left: { type: 'number' },
        top: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        name: { type: 'string' },
        fixedRatio: { type: 'boolean', description: '是否保持宽高比，默认 true' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_upload_file',
    description: '上传本地或 base64 文件到课件媒体库，支持图片、音频、视频、PDF 和 PPT/PPTX。filePath 由 MCP 进程读取并转成 dataURL，再通过编辑器登录态即时上传。当前 base64 RPC 通道限制本地文件不超过 70MB；较大音视频请先压缩或使用已有远程素材 URL。返回 { url, fileId, fileName, mimeType? }。',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '本地文件路径（与 data 二选一）' },
        data: { type: 'string', description: 'base64 或 dataURL 文件数据（与 filePath 二选一）' },
        fileName: { type: 'string', description: '上传文件名；传 filePath 时默认取路径中的文件名' },
        mimeType: { type: 'string', description: '文件 MIME；传 filePath 时默认按扩展名识别' },
        kind: {
          type: 'string',
          enum: ['image', 'audio', 'video', 'document', 'other'],
          description: '文件用途提示；默认按 MIME 判断'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_digital_module_types',
    description: '列出 AI 当前可配置的数字模块类型、名称、语义配置 schema、默认值和资源依赖。创建模块前优先调用，避免直接拼接后端 add_model_req_en。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: ['string', 'number'], description: '可选：只查询指定数字模块类型或别名' },
        supportedOnly: { type: 'boolean', description: '是否仅返回已支持自动配置的类型，默认 true' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_digital_module',
    description: '查询一个元素当前关联的数字模块。只需 elementId；桥接会自动找到元素所在区块的数据库 id（不是区块 uuid）作为 hypermedia_content_id。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: '目标元素 id' },
        includeRaw: { type: 'boolean', description: '是否附带原始 catalog/model content 响应，默认 false' }
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_digital_modules',
    description: '批量查询当前目录元素关联的数字模块，可按元素 id 和模块类型筛选。默认仅返回存在模块的元素；includeEmpty=true 时也返回未关联项。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选元素 id 列表；省略时检查当前目录可见的全部元素'
        },
        type: { type: ['string', 'number'], description: '数字模块类型或别名筛选' },
        includeEmpty: { type: 'boolean', description: '是否包含未关联数字模块的元素，默认 false' },
        includeRaw: { type: 'boolean', description: '是否附带原始后端响应，默认 false' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_create_digital_module',
    description: '为元素新增数字模块并立即写入后端，不需要随后 editor_save_verified。只传 elementId，桥接会解析所属区块的数据库 id；已有模块时默认拒绝，replaceExisting=true 才显式一次提交替换（不会先删除旧模块）。mediaPath 可便捷上传本地音视频/文件，上传结果会写入 config.uploadedFile 后交给类型适配器。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: '目标元素 id' },
        type: { type: ['string', 'number'], description: '数字模块类型编号或 list types 返回的别名' },
        name: { type: 'string', description: '有意义的模块名称；省略时按元素名和模块类型自动生成' },
        config: { type: 'object', description: '该类型的语义配置；结构以 editor_list_digital_module_types 为准' },
        replaceExisting: { type: 'boolean', description: '目标已有模块时是否先替换，默认 false' },
        validateOnly: { type: 'boolean', description: '只解析、校验并返回将提交的模块数据，不创建模块；不能与 mediaPath 同传，可在 config 中使用已有 URL/metadata' },
        mediaPath: { type: 'string', description: '可选本地媒体/文件路径；当前上限 70MB' },
        mediaFileName: { type: 'string', description: 'mediaPath 上传时使用的文件名' },
        mediaMimeType: { type: 'string', description: 'mediaPath 上传时使用的 MIME' }
      },
      required: ['elementId', 'type'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_update_digital_module',
    description: '修改元素当前数字模块并立即写入后端。桥接会读取并保留 relation id、model_id 和内容行 id；type 省略时沿用原类型，改变类型必须显式 replaceType=true。mediaPath 会先上传并写入 config.uploadedFile。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: '目标元素 id' },
        type: { type: ['string', 'number'], description: '新模块类型；省略时沿用原类型' },
        name: { type: 'string', description: '新的模块名称；省略时保留原名称' },
        config: { type: 'object', description: '要更新的语义配置；结构以 editor_list_digital_module_types 为准' },
        replaceType: { type: 'boolean', description: '是否允许改变数字模块类型，默认 false' },
        validateOnly: { type: 'boolean', description: '只解析、校验并返回将提交的模块数据，不更新模块；不能与 mediaPath 同传，可在 config 中使用已有 URL/metadata' },
        mediaPath: { type: 'string', description: '可选本地媒体/文件路径；当前上限 70MB' },
        mediaFileName: { type: 'string', description: 'mediaPath 上传时使用的文件名' },
        mediaMimeType: { type: 'string', description: 'mediaPath 上传时使用的 MIME' }
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_digital_module',
    description: '删除元素当前关联的数字模块并立即写入后端。桥接会先查询真实 relation id/model_id/type，再调用删除接口；不公开 hypermedia_content_id。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: '目标元素 id' },
        ignoreMissing: { type: 'boolean', description: '没有关联模块时是否按成功返回，默认 true' }
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_copy_digital_module',
    description: '把已有数字模块复制关联到一个尚未绑定模块的元素并立即写入后端。传 sourceElementId 自动读取 model_id，或直接传 modelId；复制与编辑器“复制/粘贴数字模块”一致，共享同一个 model_id，不是独立深克隆。目标已有模块时始终安全拒绝；如确需替换，必须先单独 delete 再 copy，这两个立即写库动作不是原子事务。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceElementId: { type: 'string', description: '源元素 id（与 modelId 二选一）' },
        modelId: { type: ['string', 'number'], description: '已有数字模块 model_id（与 sourceElementId 二选一）' },
        targetElementId: { type: 'string', description: '尚未绑定数字模块的目标元素 id' }
      },
      required: ['targetElementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_question_paths',
    description: '读取一本书可用于题目检索的学习路径/教材目录节点。默认返回递归展开后的节点，pathId 可直接传给 editor_search_questions 的 learningPath/book 范围。',
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { ...ID_SCHEMA, description: '书本 id；省略时使用当前书本' },
        flatten: { type: 'boolean', description: '是否返回扁平列表，默认 true；false 返回树结构' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_question_search_options',
    description: '读取题目检索可用的学段、学科、年级、册次、难度、题型和高级筛选字典，避免猜测后端筛选 id。',
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { ...ID_SCHEMA, description: '书本 id；省略时使用当前书本' },
        refresh: { type: 'boolean', description: '是否跳过页面缓存并重新请求，默认 false' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_search_questions',
    description: '搜索题目。支持当前目录、当前书已添加资源、本书学习路径和总题库；返回题目 GUID、题干摘要、题型、答案/解析可用性及分页/部分结果诊断。book 是 learningPath 的兼容别名；高级筛选由 global 范围执行，其他范围会明确返回 ignoredFilters。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['currentCatalog', 'currentBookResources', 'learningPath', 'book', 'global'],
          description: '查询范围，默认 currentCatalog'
        },
        query: { type: 'string', description: '题干关键词或题目 GUID' },
        bookId: { type: ['string', 'number'], description: '书本 id；省略时使用当前书本' },
        catalogId: { type: ['string', 'number'], description: '编辑器目录 id；currentCatalog 默认当前目录' },
        pathId: { type: ['string', 'number'], description: '学习路径节点 id；先用 editor_list_question_paths 获取' },
        quesScope: { type: 'number', enum: [1, 2], description: '学习路径题目范围：1 常规题目，2 定制题目' },
        pageNo: { type: 'number', minimum: 0, description: '页码，从 0 开始，默认 0' },
        pageSize: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: '每页数量，范围 1-100，默认 20'
        },
        ...QUESTION_FILTER_PROPERTIES,
        filters: {
          type: 'object',
          description: '兼容旧调用的高级筛选对象；桥接只接受已声明的白名单字段，且不能覆盖关键词或分页'
        },
        includeRaw: { type: 'boolean', description: '是否附带原始题目数据，默认 false' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_questions',
    description: '按 GUID 批量读取题目及子题详情。数字模块关联题目时应使用返回的 guid/子题 guid，不要使用列表记录的数值 id。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' },
          description: '题目 GUID 列表，最多 50 个'
        },
        includeRaw: { type: 'boolean', description: '是否附带完整原始题目结构，默认 false' },
        includeDiagnostics: {
          type: 'boolean',
          description: '返回 items/requestedGuids/uniqueGuids/foundGuids/missingGuids/duplicateGuids 诊断信封；默认 false 时保持数组返回'
        },
        returnEnvelope: {
          type: 'boolean',
          description: 'includeDiagnostics 的兼容别名；任一为 true 都返回诊断信封'
        }
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_validate_question_selection',
    description: '在创建答题类数字模块前校验题目选择：检查缺失、重复、父子题冲突，以及目标模块类型对题目数量、答案/解答和 AI 讲解资源的要求。只读，不写库。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' },
          description: '待关联的题目/子题 GUID'
        },
        targetModuleType: {
          type: ['string', 'number'],
          description: '目标数字模块类型，如 82 在线答题、83 核对答案、93 逻辑组件、94 AI 讲解'
        },
        config: {
          type: 'object',
          description: '可选模块配置；在线答题可传 questionMode/timeMode/timeLimit/rules 以做组合校验'
        }
      },
      required: ['guids', 'targetModuleType'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_question_solutions',
    description: '按 GUID 批量读取题目答案、解答和解析资源，供核对答案、反馈设计或创建答题类数字模块前检查。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' }
        },
        includeRaw: { type: 'boolean', description: '是否附带接口原始数据，默认 false' }
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_questions_to_catalog',
    description: '把题目添加到指定书本目录并立即写入后端；validateOnly=true 只校验目标和题目，不写库。写入后无需 editor_save。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' },
          description: '要添加的题目 GUID'
        },
        bookId: { ...ID_SCHEMA, description: '书本 id；省略时使用当前书本' },
        catalogId: { ...ID_SCHEMA, description: '目录 id；省略时使用当前目录' },
        validateOnly: { type: 'boolean', description: '仅校验，不写库，默认 false' }
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_remove_catalog_question',
    description: '按目录资源映射的数值 id 删除一道已加入目录的题目并立即写库。resourceMappingId 不是题目 GUID。',
    inputSchema: {
      type: 'object',
      properties: {
        resourceMappingId: {
          type: 'integer',
          minimum: 1,
          description: '目录题目资源映射的正整数 id（搜索 currentCatalog/currentBookResources 的结果中获取）'
        }
      },
      required: ['resourceMappingId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_catalog_question',
    description: '按目录资源映射 id 调整题目在目录中的顺序并立即写库。toIndex 使用从 0 开始的目标下标。',
    inputSchema: {
      type: 'object',
      properties: {
        resourceMappingId: {
          type: 'integer',
          minimum: 1,
          description: '目录题目资源映射的正整数 id，不是题目 GUID'
        },
        toIndex: { type: 'integer', minimum: 0, description: '从 0 开始的目标下标' }
      },
      required: ['resourceMappingId', 'toIndex'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_question_explanations',
    description: '按题目 GUID 读取已保存的 AI 讲解记录。返回的讲解记录 id 可用于数字模块 94 的 explain_ids，不能用题目 GUID 代替。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' }
        },
        includeRaw: { type: 'boolean', description: '是否附带接口原始数据，默认 false' }
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_start_question_explanation_generation',
    description: '为一批题目启动 AI 讲解生成并立即返回任务信息；不会在 MCP 内长轮询。随后用 editor_get_question_explanation_status 查询。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' }
        },
        bookId: { ...ID_SCHEMA, description: '书本 id；省略时使用当前书本' }
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_question_explanation_status',
    description: '查询题目 AI 讲解生成状态；includeResults=true 时对已完成题目一并读取讲解结果。单次查询，不在工具内等待或轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: { type: 'string' }
        },
        bookId: { ...ID_SCHEMA, description: '书本 id；省略时使用当前书本' },
        includeResults: { type: 'boolean', description: '已完成时是否附带讲解记录，默认 false' }
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_save_question_explanation',
    description: '新增或更新一道题的 AI 讲解并立即写库；更新时传现有讲解记录 id。content 使用 HTML、Markdown 或纯文本字符串。',
    inputSchema: {
      type: 'object',
      properties: {
        questionGuid: { type: 'string', description: '题目 GUID' },
        content: { type: 'string', minLength: 1, description: 'HTML、Markdown 或纯文本讲解内容' },
        id: {
          type: 'integer',
          minimum: 1,
          description: '已有讲解记录的正整数 id；省略时新增'
        }
      },
      required: ['questionGuid', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_question_explanation',
    description: '按讲解记录 id 删除已保存的 AI 讲解并立即写库。explanationId 不是题目 GUID。',
    inputSchema: {
      type: 'object',
      properties: {
        explanationId: {
          type: 'integer',
          minimum: 1,
          description: 'AI 讲解记录的正整数 id，不是题目 GUID'
        }
      },
      required: ['explanationId'],
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
    description:
      '安全切换到指定页面。当前页有未保存改动时，必须显式选择 saveBeforeSwitch 保存或 discardChanges 丢弃；仅传 slideId 时保持兼容。',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: { type: 'string' },
        saveBeforeSwitch: {
          type: 'boolean',
          description: '当前页有未保存改动时，先保存并回读再切换'
        },
        discardChanges: {
          type: 'boolean',
          description: '当前页有未保存改动时，明确丢弃后再切换'
        }
      },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_slide',
    description:
      '新增并选中目录。templateId 省略时由 Bridge 复用或创建空白样章；当前页 dirty 时必须显式 saveBeforeSwitch 或 discardChanges。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: '目录名称，默认“未命名”' },
        parentId: { type: ['string', 'number'], description: '父目录 id；省略为根目录' },
        templateId: { type: ['string', 'number'], description: '可选样章模板 id' },
        templateType: { type: 'number', description: '模板类型；样章通常为 3' },
        saveBeforeSwitch: {
          type: 'boolean',
          description: '当前页 dirty 时，先保存并回读再新增和切换'
        },
        discardChanges: {
          type: 'boolean',
          description: '当前页 dirty 时，明确丢弃当前页改动再新增和切换'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_slide',
    description:
      '删除目录并立即写库。删除当前 dirty 目录时必须显式 saveBeforeSwitch 或 discardChanges；删除前应先读取或导出备份。',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: { type: 'string', minLength: 1 },
        saveBeforeSwitch: {
          type: 'boolean',
          description: '删除当前 dirty 目录前先保存并回读'
        },
        discardChanges: {
          type: 'boolean',
          description: '明确丢弃当前 dirty 目录的未保存改动并继续删除'
        }
      },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_slide',
    description: '把目录移动到同级的 0-based 目标下标并立即写库。',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: { type: 'string', minLength: 1 },
        toIndex: { type: 'integer', minimum: 0 }
      },
      required: ['slideId', 'toIndex'],
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
    name: 'editor_clone_block',
    description: '克隆（复制）一个区块到指定位置：保留全部元素与样式，生成新的 blockId。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '源区块 uuid' },
        afterBlockId: { type: 'string', description: '插入到哪个区块之后，省略则追加到末尾' },
        name: { type: 'string', description: '新区块名称，省略则沿用原名' }
      },
      required: ['blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_block',
    description: '把当前页区块移动到 0-based 目标下标。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', minLength: 1 },
        toIndex: { type: 'integer', minimum: 0 }
      },
      required: ['blockId', 'toIndex'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_replace_block',
    description: '用完整区块模板对象替换当前页目标区块，保持原位置和原 blockId。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', minLength: 1 },
        templateData: {
          type: 'object',
          minProperties: 1,
          additionalProperties: true,
          description: '完整区块模板对象；通常来自 editor_export_slide 或模板详情'
        }
      },
      required: ['blockId', 'templateData'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_copy_block_to_slide',
    description:
      '把当前页区块复制到目标目录。跨页且当前页 dirty 时应使用 saveBeforeSwitch；discardChanges 不会用于复制 dirty 源，避免复制语义不明确。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', minLength: 1 },
        targetSlideId: { type: 'string', minLength: 1 },
        index: { type: 'integer', minimum: 0, description: '目标页插入下标；省略时追加' },
        saveBeforeSwitch: {
          type: 'boolean',
          description: '当前页 dirty 时，先保存并回读再复制和切换'
        },
        discardChanges: {
          type: 'boolean',
          description: 'dirty 源会被拒绝并要求保存，防止复制未保存内容后再丢弃'
        }
      },
      required: ['blockId', 'targetSlideId'],
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
        patch: { type: 'object', minProperties: 1, description: '要合并的区块属性' }
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
    description: '在指定 owner 区块内新增元素。payload.left/top/x/y 均为 block-local 坐标；省略位置时按目标区块自身尺寸居中，不使用整页高度。Bridge 会重建元素树 ID，并在首个写入前校验真实包围盒，越界时零写入拒绝。type 参考 text/image/shape/line/chart/table/video/audio/mind/pdfpage/latex/bracket/connectLine/input/outline/tab/textarea 等。',
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
    description: '修改元素通用属性（patch 合并）。几何字段 left/top/x/y/width/height/rotate 始终按 owner block-local 语义生成候选包围盒并预检，越界零写入；明确的移动、缩放、旋转优先使用对应 typed 工具。文本 content/hyperlinkParamList/字数统计字段会拒绝并要求使用 editor_text_* 专用工具。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        patch: { type: 'object', minProperties: 1 }
      },
      required: ['elementId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_element',
    description: '把单个元素整体移动，使其几何包围盒左上角到达 owner 区块内的 block-local (x, y)。它不是整页 pageY 或视口坐标；Bridge 会先校验完整包围盒，越出 owner 区块时零写入拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', minLength: 1 },
        x: { type: 'number', description: '区块内横坐标' },
        y: { type: 'number', description: '区块内纵坐标' }
      },
      required: ['elementId', 'x', 'y'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_elements',
    description: '把同一 owner 区块内的元素选择集整体移动，使选择集包围盒左上角到达 block-local (x, y)，并保持元素相对位置；越出 owner 区块时零写入拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        x: { type: 'number', description: '选择集包围盒的 block-local 左坐标' },
        y: { type: 'number', description: '选择集包围盒的 block-local 上坐标' }
      },
      required: ['elementIds', 'x', 'y'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_resize_element',
    description: '把非组元素精确调整为指定正宽高，并按缩放后（含现有旋转）的真实包围盒检查 owner 区块；越界时零写入拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', minLength: 1 },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 }
      },
      required: ['elementId', 'width', 'height'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rotate_element',
    description: '设置非组元素旋转角度（度），并按旋转后的真实包围盒检查 owner 区块；越界时零写入拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', minLength: 1 },
        angle: { type: 'number' }
      },
      required: ['elementId', 'angle'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_set_element_spacing',
    description: '将同一 owner 区块内至少两个元素按水平或垂直方向排列，并设置 block-local 相邻间距；跨区块会拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          minItems: 2,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        direction: { type: 'string', enum: ['horizontal', 'vertical'] },
        spacing: { type: 'number' }
      },
      required: ['elementIds', 'direction', 'spacing'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_center_element_in_block',
    description: '将单个元素在所属区块内水平、垂直或双向居中。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', minLength: 1 },
        axis: {
          type: 'string',
          enum: ['horizontal', 'vertical', 'both'],
          default: 'both'
        }
      },
      required: ['elementId'],
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
    description: '撤销操作（ai_control 模式已禁用，返回 { disabled: true, reason }；回退请用 editor_checkpoint / editor_rollback 整页快照）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_redo',
    description: '重做操作（ai_control 模式已禁用，返回 { disabled: true, reason }；回退请用 editor_checkpoint / editor_rollback 整页快照）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_checkpoint',
    description: '创建整页深拷贝快照（ai_control 专用，替代撤销/重做）：任务开始或关键大节点前调用，勿频繁。返回 { checkpointId, slideId, label, time, blockCount, elementCount }。',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: '快照说明，如 "重构前基线"' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_rollback',
    description: '用快照恢复整页画布（仅限同一页面；任务取消/失败时使用）。返回恢复后的快照信息。',
    inputSchema: {
      type: 'object',
      properties: { checkpointId: { type: 'string', description: 'checkpoint 返回的快照 id' } },
      required: ['checkpointId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_checkpoints',
    description: '列出当前会话的全部快照元信息（checkpointId/slideId/label/time/blockCount/elementCount）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_clear_checkpoints',
    description: '任务成功后清理全部快照，释放内存。返回 { cleared }。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_save',
    description: '旧版保存入口，只执行编辑器既有保存流程；新调用优先使用 editor_save_verified(scope=current) 保存并回读校验。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_screenshot',
    description: '截图画布并返回 PNG 图片（模型可直接看到效果，用于排版/视觉核对）。默认截当前视口；fullPage=true 截全部区块拼接为整页；blockId 指定单个区块（uuid）。注意：canvas 类区块（四线三格、手写格）和跨域图片可能渲染为空，请结合 editor_get_canvas_tree 数值核对。',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'true 时拼接全部区块为整页截图' },
        blockId: { type: 'string', description: '只截指定区块（template uuid）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_canvas_tree',
    description: '获取当前页完整结构树：区块列表+元素树+统计（blockCount/elementCount/typeCounts），AI 理解画布首选。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_get_canvas_info',
    description: '读取当前目录的页面尺寸、缩放、视口偏移和元素统计，用于布局计算与视图诊断。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_scroll_to_block',
    description: '把编辑器视口滚动到指定区块。',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string', minLength: 1 } },
      required: ['blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_scroll_to_element',
    description: '把编辑器视口滚动到指定元素。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string', minLength: 1 } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_set_zoom',
    description: '设置编辑器画布缩放比例，范围 0.1 到 3。',
    inputSchema: {
      type: 'object',
      properties: { scale: { type: 'number', minimum: 0.1, maximum: 3 } },
      required: ['scale'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_fit_canvas',
    description: '自动缩放并居中画布，使当前画布适配可见视口。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_get_element',
    description: '获取单个元素的完整数据（含所属 blockId、组层级）。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string' } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_blocks',
    description: '列出当前页全部区块（blockId/index/name/size/elementCount）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_search_elements',
    description: '按名称/内容/类型关键字搜索元素。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键字（匹配名称/内容/类型/id）' },
        type: { type: 'string', description: '元素类型过滤' },
        blockId: { type: 'string', description: '区块 uuid 过滤' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_align_elements',
    description: '对齐或等间距排列元素。target 表示对齐参照（selection/block/page），coordinateSpace 表示计算坐标（block/page）：同块 selection 默认 block；跨块 selection 必须显式 page；target=block/page 会强制对应坐标。hdengju/vdengju 仅支持 selection，但坐标可为 block/page。Bridge 用区块 topMap 转换 page 坐标，最终始终写回各 owner 的 block-local left/top，并在任一元素越出 owner 前零写入拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        align: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'horizontal', 'vertical', 'center', 'hdengju', 'vdengju'] },
        target: {
          type: 'string',
          enum: ['selection', 'block', 'page'],
          description: '对齐参照，默认 selection'
        },
        coordinateSpace: {
          type: 'string',
          enum: ['block', 'page'],
          description: '计算坐标；同块 selection 默认 block，跨块 selection 必须显式 page'
        }
      },
      required: ['elementIds', 'align'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_elements_bounds',
    description: '读取元素集合的包围盒和中心点。coordinateSpace=block 只接受同一 owner 区块并返回 block-local 坐标；page 可跨区块并通过 topMap 返回整页坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        coordinateSpace: {
          type: 'string',
          enum: ['block', 'page'],
          default: 'block'
        }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_duplicate_elements',
    description: '批量复制元素；offsetX/offsetY 是各元素 owner 区块内的 block-local 偏移，默认 +20/+20。Bridge 会重建全部 ID、统一预检所有副本边界，并在批量写入异常时补偿删除已写入副本。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        offsetX: { type: 'number' },
        offsetY: { type: 'number' }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_elements_by_offset',
    description: '按相对偏移批量移动元素；可跨 owner 区块，但每个元素都在自己的 block-local 坐标中应用 dx/dy，并在任一元素越界时拒绝整次更新。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        dx: { type: 'number' },
        dy: { type: 'number' }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rename_slide',
    description: '重命名页面（目录），即时写库。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' }, name: { type: 'string' } },
      required: ['slideId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_duplicate_slide',
    description: '复制整页（目录+内容），即时写库，返回新 slideId。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' } },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rename_block',
    description: '重命名区块。',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string' }, name: { type: 'string' } },
      required: ['blockId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_export_slide',
    description: '导出整页 JSON（区块完整数据），用于备份/跨页复用。slideId 省略为当前页。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string', description: '省略=当前页' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_import_blocks',
    description: '向指定页导入区块数据（自动切换到目标页并插入；uuid/元素 id 自动重生成）。',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: { type: 'string' },
        blocks: {
          type: 'array',
          minItems: 1,
          items: { type: 'object', additionalProperties: true },
          description: '区块模板对象数组（exportSlide 产物或自定义结构）'
        },
        index: { type: 'integer', minimum: 0, description: '插入位置，省略追加末尾' },
        saveBeforeSwitch: {
          type: 'boolean',
          description: '目标不是当前页且当前页 dirty 时，先保存并回读再切换'
        },
        discardChanges: {
          type: 'boolean',
          description: '目标不是当前页且当前页 dirty 时，明确丢弃当前页改动再切换'
        }
      },
      required: ['slideId', 'blocks'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_info',
    description: '读取表格结构：行列数、行列宽高、合并单元格、边框样式，以及展开后的规范网格 grid[r][c]（含每格 id/rowspan/colspan/是否合并起点/是否被覆盖/纯文本内容/原始 HTML）。表格操控前先读它。',
    inputSchema: {
      type: 'object',
      properties: { tableId: { type: 'string', description: '表格元素 id' } },
      required: ['tableId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_set_cell',
    description: '修改表格单元格：content 替换内容（HTML 字符串），background 设置背景色（传空串清除）；row/col 为 0 基坐标（grid 中的位置），被合并覆盖的格子不可写，请写合并起点格。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        row: { type: 'number', description: '0 基行号' },
        col: { type: 'number', description: '0 基列号' },
        content: { type: 'string', description: '单元格内容（HTML 或纯文本）' },
        background: { type: 'string', description: '背景色，如 #FFF6E1 或 rgb(...)；传空串/null 清除' }
      },
      required: ['tableId', 'row', 'col'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_update',
    description: '整表属性/数据更新：patch 直接合并进表格元素（tableData/widths/heights/borderColor/borderWidth/borderRadius/rowColor/colColor 等顶层字段）。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        patch: { type: 'object', description: '要合并的表格元素字段' }
      },
      required: ['tableId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_structure',
    description: '表格结构操作：action 取值 insertRow / deleteRow / insertColumn / deleteColumn / mergeCells / splitCell，index/count/startRow/startCol/endRow/endCol 均为 0 基坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        action: { type: 'string', enum: ['insertRow', 'deleteRow', 'insertColumn', 'deleteColumn', 'mergeCells', 'splitCell'] },
        index: { type: 'number', description: 'insertRow/deleteRow/insertColumn/deleteColumn 的位置（0 基）' },
        count: { type: 'number', description: 'deleteRow/deleteColumn 删除数量，默认 1' },
        startRow: { type: 'number', description: 'mergeCells 起始行（0 基）' },
        startCol: { type: 'number', description: 'mergeCells 起始列（0 基）' },
        endRow: { type: 'number', description: 'mergeCells 结束行（0 基）' },
        endCol: { type: 'number', description: 'mergeCells 结束列（0 基）' },
        row: { type: 'number', description: 'splitCell 的合并起点行（0 基）' },
        col: { type: 'number', description: 'splitCell 的合并起点列（0 基）' }
      },
      required: ['tableId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_fit_heights',
    description: '表格行高自适应（仅 AI 控制）：按单元格实际内容高度重算每行最小高度并写回 heights，等效于逐行拖拽收缩。用于字号/内容缩小后收紧表格；处理合并单元格。waitMs 为内容变更后等待渲染的毫秒数（默认 2000），minHeight 为行高下限（默认 30）。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: '表格元素 id' },
        waitMs: { type: 'number', description: '内容变更后等待渲染的毫秒数，默认 2000，上限 5000' },
        minHeight: { type: 'number', description: '行高下限，默认 30' }
      },
      required: ['tableId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_info',
    description: '读取思维导图结构：返回规范节点树（每节点 id/纯文本/HTML/层级/路径/常用样式摘要）+ 节点总数/最大深度 + 整体模板/主题。思维导图操控前先读它。',
    inputSchema: {
      type: 'object',
      properties: { mindId: { type: 'string', description: '思维导图元素 id' } },
      required: ['mindId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_set_node',
    description: '修改思维导图节点：text 替换节点文本（纯文本自动转 HTML，已含标签原样保留）；patch 合并样式/附加数据（color/fontsize/bold/italic/fontFamily/background/note/image/hyperlink/priority/progress/expandState 等，传 null 删除该字段）。',
    inputSchema: {
      type: 'object',
      properties: {
        mindId: { type: 'string' },
        nodeId: { type: 'string', description: '目标节点 id（来自 editor_mind_info 的树）' },
        text: { type: 'string', description: '节点文本（HTML 或纯文本）' },
        patch: {
          type: 'object',
          description: '样式/附加数据字段（bold=true/false、italic=true/false、color、fontsize、background、note、image、hyperlink 等）'
        }
      },
      required: ['mindId', 'nodeId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_structure',
    description: '思维导图节点结构操作：action=addChild 给 nodeId 添加子节点（默认末尾，index 可指定位置）；action=addSibling 在 nodeId 后插入同级节点；action=delete 删除节点（中心主题不可删）。text 缺省为"分支主题"。',
    inputSchema: {
      type: 'object',
      properties: {
        mindId: { type: 'string' },
        action: { type: 'string', enum: ['addChild', 'addSibling', 'delete'] },
        nodeId: { type: 'string', description: '目标节点 id；addChild 省略时挂到中心主题下' },
        text: { type: 'string', description: '新节点文本' },
        index: { type: 'number', description: '插入位置（0 基，默认末尾）' }
      },
      required: ['mindId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_update',
    description: '思维导图整体更新：content 整图替换（{ root, template?, theme? } 对象或 JSON 字符串，自动补齐节点 id）；template 切换布局（default/right/left/right_angle/default_angle/left_angle/orthogonal）；theme 切换主题（mind-default/retro/youth/minimalist/black）。',
    inputSchema: {
      type: 'object',
      properties: {
        mindId: { type: 'string' },
        content: {
          type: ['object', 'string'],
          description: '整图数据 { root: { data: { id, text, type }, children: [] }, template?, theme? }'
        },
        template: { type: 'string', description: '布局模板名' },
        theme: { type: 'string', description: '主题名' }
      },
      required: ['mindId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_info',
    description: '读取普通文本元素、表格单元格或思维导图节点的富文本摘要。传统一 target，或用 legacy elementId 读取普通文本元素；嵌套目标不提供独立文本框布局。',
    inputSchema: {
      type: 'object',
      properties: { ...TEXT_TARGET_PROPERTIES },
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_export_semantic_snapshot',
    description:
      '只读冻结当前连接书本中当前或指定普通目录的完整可编辑语义快照：原始区块/元素、稳定元素定位索引、大纲、normalized+raw 数字模块、字体与可选富文本结构。结果按内容寻址写入系统临时目录并返回绝对 snapshotPath、文件 SHA-256、Bridge 内容稳定 hash、完整度与工作副本/持久态信息；不切页、不跨书、不写业务库。需要 Bridge v1.10.0+ 的 getSemanticSnapshot，旧 Bridge 不会用摘要数据伪装降级。',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: {
          type: ['string', 'number'],
          description: '当前书本内的正整数普通目录 id；省略为当前目录'
        },
        richText: {
          type: 'string',
          enum: ['none', 'summary', 'deep'],
          description:
            '富文本读取深度，默认 deep；summary 保留文本身份、正文、默认样式、布局和 hash，none 不展开富文本结构'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_set_content',
    description: '整段替换文本内容。纯文本自动包 <p>，换行自动拆段；expectedContentHash 防并发覆盖，dryRun 只预览。实际写入且 fitSize=true 时按 background.extendType 重算宽高并联动同组元素。局部修改优先用 editor_text_edit。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        content: { type: 'string', description: '新内容（HTML 或纯文本）' },
        expectedContentHash: {
          type: 'string',
          minLength: 1,
          description: '最近一次 editor_text_document 返回的 contentHash，用于防止整段覆盖并发修改'
        },
        dryRun: { type: 'boolean', description: '只返回规范化内容和新 hash，不修改元素' },
        fitSize: { type: 'boolean', description: '是否触发自适应重算，默认 true' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['content'],
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_adaptive',
    description: '切换文本自适应模式：extendType 取值 both（宽高都随内容）/ horizontal（仅宽）/ vertical（仅高）/ none（不自动）。切换后默认触发重算并返回新尺寸与联动位移。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        extendType: { type: 'string', enum: ['both', 'horizontal', 'vertical', 'none'] },
        fitSize: { type: 'boolean', description: '切换后是否触发重算，默认 true' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['elementId', 'extendType'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_fit',
    description: '强制重测文本元素尺寸（重新按当前内容与 extendType 计算宽高并联动同组元素）。内容未变但尺寸异常、或外部改了字体/样式后想重新适应时使用；不修改正文，不接受 expectedContentHash 或 dryRun。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_document',
    description: '结构化读取普通文本元素、表格单元格或思维导图节点。plainText/displayText 会展开拼音 word；indexText、paragraphs/runs/embeds 和 displayIndexMap 保留稳定 Quill 索引。传统一 target，或用 legacy elementId 读取普通文本元素。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        includeHtml: { type: 'boolean', description: '是否附带规范化 HTML，默认 true' },
        includeRuns: { type: 'boolean', description: '是否附带字符样式 runs，默认 true' },
        includeParagraphs: { type: 'boolean', description: '是否附带段落结构，默认 true' },
        includeEmbeds: { type: 'boolean', description: '是否附带公式、图片、拼音等内嵌对象，默认 true' }
      },
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_set_style',
    description: '设置富文本目标的默认字体与基础样式。支持普通文本元素、表格单元格和思维导图节点；只影响默认样式，已有内联 run 应使用 editor_text_format。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        style: {
          type: 'object',
          properties: TEXT_DEFAULT_STYLE_PROPERTIES,
          minProperties: 1,
          additionalProperties: false
        },
        expectedContentHash: {
          type: 'string',
          minLength: 1,
          description: '最近一次 editor_text_document 返回的 contentHash，用于防止并发覆盖'
        },
        fitSize: { type: 'boolean', description: '样式变化后是否重测尺寸，默认 true' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['style'],
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_edit',
    description: '保留未修改区域格式地插入、替换、删除或查找替换文本。insert/replace/delete 使用 UTF-16 index（replace/delete 还需 length）；仅 findReplace 使用 match+occurrence，省略 text/html 时删除匹配。expectedContentHash 同时保护正文和超链接元数据，dryRun 只预览。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        action: { type: 'string', enum: ['insert', 'replace', 'delete', 'findReplace'] },
        index: TEXT_INDEX_SCHEMA,
        length: { type: 'integer', minimum: 0 },
        text: { type: 'string', description: '插入或替换的纯文本' },
        html: { type: 'string', description: '插入或替换的富文本 HTML；与 text 二选一' },
        match: { type: 'string', minLength: 1, description: '按纯文本匹配定位' },
        occurrence: { type: 'integer', minimum: 1, description: '第几个匹配，默认 1' },
        caseSensitive: { type: 'boolean' },
        replaceAll: { type: 'boolean', description: 'findReplace 是否替换全部命中' },
        expectedContentHash: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean' },
        fitSize: { type: 'boolean', description: '写入后是否重测文本框，默认 true' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['action'],
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_set_link',
    description: '原子地给文本范围设置超链接，并同步 hyperlinkParamList。复用已有 hyperlinkId 时元数据可省略；新链接必须提供 hyperlink 元数据，但 hyperlink_id 可省略并由 Bridge 生成，后续以返回的 hyperlinkId 为准。Bridge 不会猜测跳转参数。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        index: TEXT_INDEX_SCHEMA,
        length: { type: 'integer', minimum: 1 },
        hyperlinkId: { type: 'string', minLength: 1 },
        hyperlink: {
          type: 'object',
          minProperties: 1,
          properties: {
            hyperlink_id: { type: ['string', 'number'] },
            input_type: { type: 'number', enum: [1, 2] },
            link_mode: { type: 'number', enum: [1, 2] },
            jump_type: { type: 'number', enum: [1, 2] },
            link_address: { type: 'string' },
            agent_id: { type: ['string', 'number'] },
            agent_params: {
              type: 'array',
              items: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] }
            }
          },
          required: ['input_type', 'link_mode', 'jump_type'],
          description: 'HyperlinkTooltip 的真实元数据。URL 使用 jump_type=1 + link_address；智能体使用 jump_type=2 + 真实 agent_id/agent_params。优先复用 document.hyperlinks[].metadata。',
          additionalProperties: true
        },
        expectedContentHash: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean' },
        fitSize: { type: 'boolean' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['index', 'length'],
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_remove_link',
    description: '原子地按 hyperlinkId 或 UTF-16 index+length 移除文本超链接，并清理不再被正文引用的 hyperlinkParamList 元数据。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        index: TEXT_INDEX_SCHEMA,
        length: { type: 'integer', minimum: 1 },
        hyperlinkId: { type: 'string', minLength: 1 },
        expectedContentHash: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean' },
        fitSize: { type: 'boolean' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_edit_embed',
    description: '按 UTF-16 索引原子插入、更新或删除公式、拼音和内嵌图片。自定义 blot 未注册时 Bridge 会阻止写入，避免富文本结构丢失。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        action: { type: 'string', enum: ['insert', 'update', 'delete'] },
        index: TEXT_INDEX_SCHEMA,
        embedType: {
          type: 'string',
          enum: ['formulaMath', 'pinyinBox', 'image']
        },
        value: {
          type: ['string', 'object'],
          properties: {
            latex: { type: 'string' },
            pinyin: { type: 'string' },
            word: { type: 'string' },
            url: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            originalWidth: { type: 'number' },
            originalHeight: { type: 'number' },
            rotate: { type: 'number' },
            opacity: { type: 'number' },
            flip: { type: ['number', 'boolean'] },
            outlineWidth: { type: 'number' },
            outlineColor: { type: 'string' },
            outlineStyle: { type: 'string' },
            verticalAlign: { type: 'string' },
            offsetX: { type: 'number' },
            offsetY: { type: 'number' }
          },
          additionalProperties: true,
          description: 'insert: formulaMath 为 LaTeX/{latex}，pinyinBox 为 {pinyin,word}（word 单汉字），image 为完整 ImageBot 值；update 可传部分对象并与当前 embed value 合并'
        },
        expectedContentHash: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean' },
        fitSize: { type: 'boolean' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['action', 'index'],
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_format',
    description: '按默认样式、全文、字符范围、文字匹配或 0-based 段落下标应用富文本格式。覆盖常用字符样式、段落对齐/间距/缩进和列表；支持 expectedContentHash 并发保护和 dryRun 预览，不依赖当前光标或选区。',
    inputSchema: {
      type: 'object',
      properties: {
        ...TEXT_TARGET_PROPERTIES,
        scope: { type: 'string', enum: ['default', 'all', 'range', 'match', 'paragraph'] },
        index: TEXT_INDEX_SCHEMA,
        length: { type: 'integer', minimum: 0 },
        match: { type: 'string', minLength: 1 },
        occurrence: { type: 'integer', minimum: 1 },
        caseSensitive: { type: 'boolean' },
        paragraphIndexes: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: { type: 'integer', minimum: 0 },
          description: '0-based 段落下标；必须来自 editor_text_document.paragraphs[].index'
        },
        formats: {
          type: 'object',
          properties: TEXT_FORMAT_PROPERTIES,
          minProperties: 1,
          additionalProperties: false
        },
        expectedContentHash: {
          type: 'string',
          minLength: 1,
          description: '最近一次 editor_text_document 返回的 contentHash，用于防止并发覆盖'
        },
        dryRun: { type: 'boolean' },
        fitSize: { type: 'boolean', description: '格式改变后是否重测文本框，默认 true' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['scope', 'formats'],
      ...TEXT_TARGET_SELECTOR_SCHEMA,
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_set_layout',
    description: '类型安全地设置文本框布局与外观，嵌套 background/outline/shadow 会基于旧值深合并；可设置自适应、最大宽高、padding、横竖排、对齐和溢出策略。该工具不修改正文，不接受 expectedContentHash 或 dryRun。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', minLength: 1 },
        layout: {
          type: 'object',
          properties: TEXT_LAYOUT_PROPERTIES,
          minProperties: 1,
          additionalProperties: false
        },
        fitSize: { type: 'boolean', description: '修改后是否重测尺寸，默认 true' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['elementId', 'layout'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_inspect_layout',
    description: '检查文本框内容、约束和渲染稳定状态，报告潜在溢出、裁切、字号异常、尺寸上限命中及 needResetSize 等诊断信息。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string', minLength: 1 } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_fit_to_box',
    description: '保持文本框宽高不变，在给定字号范围内逐步缩小字号直到内容尽量放入；支持 expectedContentHash，但不支持 dryRun。检测到混合或不可解析字号时默认零写入返回 mixed-font-sizes，只有用户明确同意后才传 allowUniformizeMixedSizes=true 统一字号。与 editor_text_fit 的“让框适应内容”语义不同。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', minLength: 1 },
        minFontSize: { type: 'number', minimum: 1, maximum: 200 },
        maxFontSize: { type: 'number', minimum: 1, maximum: 200 },
        step: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
        expectedContentHash: {
          type: 'string',
          minLength: 1,
          description: '最近一次 editor_text_document 返回的联合 contentHash，用于防止字号写入覆盖并发内容修改'
        },
        allowUniformizeMixedSizes: {
          type: 'boolean',
          description: '仅在用户明确同意把混合字号统一为单一字号时传 true；默认 false 并零写入'
        },
        waitMs: TEXT_WAIT_SCHEMA
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_search',
    description: '在当前已加载目录中搜索可见文本（含拼音 word），默认同时搜索普通文本元素、表格单元格和思维导图节点；返回统一 target、可写入的 Quill index/length、上下文和 contentHash。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        blockId: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        wholeWord: { type: 'boolean' },
        useRegex: { type: 'boolean' },
        targetKinds: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: TEXT_TARGET_KINDS },
          default: TEXT_TARGET_KINDS,
          description: '要搜索的目标类型；默认 element、tableCell、mindNode 三类'
        },
        limit: { type: 'integer', minimum: 1, maximum: 500 }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_copy_style',
    description: '把参考富文本目标的默认、字符或段落样式复制到多个目标。支持 legacy sourceElementId/targetElementIds 和统一 sourceTarget/targetTargets；layout/all 包含独立文本框布局，只支持普通文本元素。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceElementId: { type: 'string', minLength: 1 },
        sourceTarget: TEXT_TARGET_SCHEMA,
        targetElementIds: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 }
        },
        targetTargets: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: TEXT_TARGET_SCHEMA,
          description: '统一富文本目标列表；与 legacy targetElementIds 二选一'
        },
        scope: {
          type: 'string',
          enum: ['default', 'character', 'paragraph', 'layout', 'all']
        },
        fitSize: { type: 'boolean' },
        waitMs: TEXT_WAIT_SCHEMA
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_fonts',
    description: '列出当前书本/编辑器可使用的文本字体及语言适用范围，避免写入不可用字体。',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['all', 'chinese', 'english', 'number'] }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_batch',
    description: '高级批量桥接调用：按顺序串行执行 steps（[{ method, args }]）。它不是事务，前序成功步骤不会因后序失败自动回滚；写操作前按需单独 checkpoint。禁止把 screenshot 放进 batch，截图必须单独调用 editor_screenshot，避免大 base64 混入文本结果。stopOnError 默认 true。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '按顺序执行的步骤列表',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', description: 'window.__superEditor 方法名（如 addElement / updateElements / scrollToBlock / checkpoint / save）' },
              args: {
                type: 'array',
                items: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
                description: '传给该方法的 JSON 参数数组（可包含对象、数组或标量；无参数传 []）'
              }
            },
            required: ['method'],
            additionalProperties: false
          }
        },
        stopOnError: { type: 'boolean', description: '遇到失败是否立即停止并返回，默认 true' }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rpc_call',
    description: '高级通用桥接调用：仅在没有 typed editor_* 工具时透传 window.__superEditor 方法。它绕过 MCP 的参数语义与持久化引导，调用前必须确认桥接签名及该方法是否立即写库。高频布局、视图、页面和区块操作请优先使用专用工具。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'window.__superEditor 上的方法名' },
        args: {
          type: 'array',
          items: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
          description: '传给该方法的 JSON 参数数组（可包含对象、数组或标量；无参数传 []）'
        }
      },
      required: ['method'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_info',
    description: '读取大纲：返回当前页（或指定 slideId 目录）的大纲树 { slideId, outline, selectedOutlineId }。大纲是图层面板左侧「大纲」树的目录级数据，节点含 id/outline_name/parent_id/sort/content_uuids/children。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string', description: '目标目录 id，省略=当前页；传任意目录可直接读取（不切换页面）' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_refresh',
    description: '重新从服务端拉取当前页大纲并刷新编辑器大纲树，返回最新大纲树。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_outline_add',
    description: '新增大纲节点：parentId 省略=根节点，sort 省略=追加到同级末尾，name 省略=“未命名”。返回新节点 { id, outline_name, parent_id, sort, content_uuids }。',
    inputSchema: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: '父节点 id，0/省略=根节点' },
        sort: { type: 'number', description: '同级排序号（从 1 开始），省略=追加末尾' },
        name: { type: 'string', description: '大纲名称，省略=“未命名”' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_rename',
    description: '重命名大纲节点。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        name: { type: 'string', description: '新名称' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_delete',
    description: '删除大纲节点（含其子节点）。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_move',
    description: '移动/排序大纲节点：parentId 为目标父节点（0/省略=根节点），sort 为目标同级排序号（从 1 开始）。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        parentId: { type: 'string', description: '目标父节点 id，0/省略=根节点' },
        sort: { type: 'number', description: '目标位置同级排序号（从 1 开始）' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId', 'sort'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_link_blocks',
    description: '设置大纲节点与区块的关联（整体替换）：blockIds 为当前页区块模板 uuid 列表（editor_list_blocks 获取），传 [] 清空关联。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        blockIds: { type: 'array', items: { type: 'string' }, description: '区块 uuid 列表' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId', 'blockIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_select',
    description: '选中大纲节点（编辑器大纲树高亮），outlineId 传 null 清空选中。',
    inputSchema: {
      type: 'object',
      properties: { outlineId: { type: ['string', 'null'], description: '大纲节点 id 或 null' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_list',
    description: '查询某大纲节点下的锚点列表（type: 1=位置锚点，2=检索锚点）。',
    inputSchema: {
      type: 'object',
      properties: { outlineId: { type: 'string', description: '大纲节点 id' } },
      required: ['outlineId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_add',
    description: '新增大纲锚点：type 1=位置锚点（一般由编辑器 UI 按关联区块自动维护）、2=检索锚点（默认）；positionX/positionY/width/height 单位与画布一致。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        name: { type: 'string', description: '锚点名称，默认“锚点”' },
        type: { type: 'number', description: '1=位置锚点，2=检索锚点（默认 2）' },
        positionX: { type: 'number', description: 'X 坐标，默认 0' },
        positionY: { type: 'number', description: 'Y 坐标，默认 0' },
        width: { type: 'number', description: '宽，默认 0' },
        height: { type: 'number', description: '高，默认 0' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_update',
    description: '修改大纲锚点：anchor 传完整锚点对象（必须含 id，可带 name/type/position_x/position_y/width/height 等），走编辑器 saveanchor 接口。',
    inputSchema: {
      type: 'object',
      properties: { anchor: { type: 'object', description: '完整锚点对象，必须含 id' } },
      required: ['anchor'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_delete',
    description: '删除大纲锚点。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        anchorId: { type: 'string', description: '锚点 id' }
      },
      required: ['outlineId', 'anchorId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_upload_image',
    description: '上传本地图片到课件媒体库（走编辑器 uploadfile 通道）：imagePath 传本地 PNG/JPG/WebP/GIF 文件路径，或 data 直接传 base64/dataURL。返回 { url, fileId, fileName }，url 可用于新增/替换图片元素、设置背景图等。',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: '本地图片文件路径（与 data 二选一）' },
        data: { type: 'string', description: 'base64 或 dataURL 图片数据（与 imagePath 二选一）' },
        fileName: { type: 'string', description: '上传文件名，默认 ai-image.png' },
        mimeType: { type: 'string', description: '图片 MIME，默认按扩展名/数据自动识别' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_image_element',
    description: '上传图片并在指定区块新增图片元素：传 url 直接用已有地址；传 imagePath/data 会自动上传后再放入课件。返回 { url, elementId }，随后可用 move/resize/rotate 排版。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '目标区块 uuid（editor_list_blocks 获取）' },
        url: { type: 'string', description: '已有图片地址（与 imagePath/data 二选一）' },
        imagePath: { type: 'string', description: '本地图片文件路径（与 url/data 二选一）' },
        data: { type: 'string', description: 'base64 或 dataURL 图片数据' },
        fileName: { type: 'string', description: '上传文件名' },
        mimeType: { type: 'string', description: '图片 MIME' },
        left: { type: 'number', description: 'X 坐标（画布单位）' },
        top: { type: 'number', description: 'Y 坐标' },
        width: { type: 'number', description: '宽' },
        height: { type: 'number', description: '高' },
        name: { type: 'string', description: '元素名' },
        fixedRatio: { type: 'boolean', description: '保持宽高比，默认 true' }
      },
      required: ['blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_set_image_src',
    description: '上传图片并替换已有 image/video 元素的 src：传 url 直接用已有地址；传 imagePath/data 会自动上传。返回 { url, elementId }。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'image/video 元素 id' },
        url: { type: 'string', description: '已有图片地址（与 imagePath/data 二选一）' },
        imagePath: { type: 'string', description: '本地图片文件路径' },
        data: { type: 'string', description: 'base64 或 dataURL 图片数据' },
        fileName: { type: 'string', description: '上传文件名' },
        mimeType: { type: 'string', description: '图片 MIME' }
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
]

const WORKING_COPY_TOOL_NAMES = new Set([
  'editor_render_questions_to_block',
  'editor_apply_component',
  'editor_apply_image',
  'editor_add_block',
  'editor_clone_block',
  'editor_move_block',
  'editor_replace_block',
  'editor_copy_block_to_slide',
  'editor_update_block',
  'editor_delete_block',
  'editor_rename_block',
  'editor_import_blocks',
  'editor_add_element',
  'editor_update_element',
  'editor_move_element',
  'editor_move_elements',
  'editor_resize_element',
  'editor_rotate_element',
  'editor_set_element_spacing',
  'editor_center_element_in_block',
  'editor_delete_element',
  'editor_group_elements',
  'editor_ungroup',
  'editor_order_element',
  'editor_align_elements',
  'editor_duplicate_elements',
  'editor_move_elements_by_offset',
  'editor_rollback',
  'editor_table_set_cell',
  'editor_table_update',
  'editor_table_structure',
  'editor_table_fit_heights',
  'editor_mind_set_node',
  'editor_mind_structure',
  'editor_mind_update',
  'editor_text_set_content',
  'editor_text_set_style',
  'editor_text_edit',
  'editor_text_set_link',
  'editor_text_remove_link',
  'editor_text_edit_embed',
  'editor_text_format',
  'editor_text_adaptive',
  'editor_text_set_layout',
  'editor_text_fit',
  'editor_text_fit_to_box',
  'editor_text_copy_style'
])

const IMMEDIATE_WRITE_TOOL_NAMES = new Set([
  'editor_create_book',
  'editor_save_verified',
  'editor_restore_book_version',
  'editor_add_slide',
  'editor_delete_slide',
  'editor_move_slide',
  'editor_rename_slide',
  'editor_duplicate_slide',
  'editor_save',
  'editor_create_digital_module',
  'editor_update_digital_module',
  'editor_delete_digital_module',
  'editor_copy_digital_module',
  'editor_add_questions_to_catalog',
  'editor_remove_catalog_question',
  'editor_move_catalog_question',
  'editor_start_question_explanation_generation',
  'editor_save_question_explanation',
  'editor_delete_question_explanation',
  'editor_outline_add',
  'editor_outline_rename',
  'editor_outline_delete',
  'editor_outline_move',
  'editor_outline_link_blocks',
  'editor_outline_anchor_add',
  'editor_outline_anchor_update',
  'editor_outline_anchor_delete',
  'editor_upload_file',
  'editor_upload_image'
])

const SPECIAL_TOOL_DESCRIPTION_TAGS = {
  editor_status: '[连接状态|不写库]',
  editor_connect: '[连接状态|不写库]',
  editor_jump_to_book: '[导航|改变编辑器上下文|不写库]',
  editor_export_semantic_snapshot: '[只读导出本机临时 JSON|不写业务库]',
  editor_checkpoint: '[会话内快照|不写库]',
  editor_list_checkpoints: '[会话内快照|不写库]',
  editor_clear_checkpoints: '[会话内快照|不写库]',
  editor_scroll_to_block: '[仅视图状态|不写库]',
  editor_scroll_to_element: '[仅视图状态|不写库]',
  editor_set_zoom: '[仅视图状态|不写库]',
  editor_fit_canvas: '[仅视图状态|不写库]',
  editor_outline_select: '[仅视图状态|不写库]',
  editor_apply_template: '[按 kind：chapter 立即写库；block 工作副本写入]',
  editor_select_slide:
    '[按参数：切页只读；saveBeforeSwitch 立即写库；discardChanges 丢弃工作副本]',
  editor_add_image_element: '[立即上传媒体+工作副本写入|元素需 saveVerified]',
  editor_set_image_src: '[立即上传媒体+工作副本写入|元素需 saveVerified]',
  editor_batch: '[高级混合调用|非事务|持久化语义取决于步骤]',
  editor_rpc_call: '[高级混合调用|持久化语义取决于方法]'
}

for (const tool of TOOLS) {
  const tag =
    SPECIAL_TOOL_DESCRIPTION_TAGS[tool.name] ||
    (IMMEDIATE_WRITE_TOOL_NAMES.has(tool.name)
      ? '[立即写库|checkpoint不可恢复]'
      : WORKING_COPY_TOOL_NAMES.has(tool.name)
        ? '[工作副本写入|需 saveVerified|可 checkpoint]'
        : '[只读]')
  tool.description = `${tag} ${tool.description}`
}

class McpError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function prepareDigitalModuleArgs(args = {}) {
  const prepared = { ...args }
  if (prepared.validateOnly && prepared.mediaPath) {
    throw new Error(
      'validateOnly 不能与 mediaPath 同时使用：请先调用 editor_upload_file，' +
        '或在 config 中传已有 URL/metadata 后再校验'
    )
  }
  if (prepared.mediaPath) {
    const uploadedFile = await driver.uploadFile({
      filePath: prepared.mediaPath,
      fileName: prepared.mediaFileName,
      mimeType: prepared.mediaMimeType
    })
    prepared.config = {
      ...(prepared.config && typeof prepared.config === 'object' ? prepared.config : {}),
      uploadedFile
    }
  }
  delete prepared.mediaPath
  delete prepared.mediaFileName
  delete prepared.mediaMimeType
  return prepared
}

const QUESTION_GUID_TOOLS = new Set([
  'editor_get_questions',
  'editor_validate_question_selection',
  'editor_get_question_solutions',
  'editor_add_questions_to_catalog',
  'editor_get_question_explanations',
  'editor_start_question_explanation_generation',
  'editor_get_question_explanation_status'
])

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`)
  }
}

function validateQuestionToolArgs(name, args = {}) {
  if (QUESTION_GUID_TOOLS.has(name)) {
    if (!Array.isArray(args.guids) || !args.guids.length) {
      throw new Error('guids 必须是非空数组')
    }
    if (args.guids.length > 50) throw new Error('单次最多处理 50 个题目 GUID')
    const meaningfulGuids = args.guids
      .map((guid) => String(guid === undefined || guid === null ? '' : guid).trim())
      .filter(Boolean)
    if (!meaningfulGuids.length) throw new Error('guids 必须至少包含一个非空题目 GUID')
  }
  if (['editor_remove_catalog_question', 'editor_move_catalog_question'].includes(name)) {
    requirePositiveInteger(args.resourceMappingId, 'resourceMappingId')
  }
  if (name === 'editor_move_catalog_question') {
    if (!Number.isInteger(args.toIndex) || args.toIndex < 0) {
      throw new Error('toIndex 必须是大于等于 0 的整数')
    }
  }
  if (name === 'editor_save_question_explanation') {
    if (typeof args.questionGuid !== 'string' || !args.questionGuid.trim()) {
      throw new Error('questionGuid 不能为空')
    }
    if (typeof args.content !== 'string' || !args.content.trim()) {
      throw new Error('content 不能为空')
    }
    if (args.id !== undefined && args.id !== null) requirePositiveInteger(args.id, 'id')
  }
  if (name === 'editor_delete_question_explanation') {
    requirePositiveInteger(args.explanationId, 'explanationId')
  }
}

const TEXT_CONTENT_TARGET_TOOLS = new Set([
  'editor_text_info',
  'editor_text_set_content',
  'editor_text_document',
  'editor_text_set_style',
  'editor_text_edit',
  'editor_text_set_link',
  'editor_text_remove_link',
  'editor_text_edit_embed',
  'editor_text_format'
])

const TEXT_LAYOUT_ELEMENT_TOOLS = new Set([
  'editor_text_adaptive',
  'editor_text_fit',
  'editor_text_set_layout',
  'editor_text_inspect_layout',
  'editor_text_fit_to_box'
])

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key)
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`)
}

function requireTextTargetId(value, name) {
  const validNumber = typeof value === 'number' && Number.isFinite(value)
  const validString = typeof value === 'string' && !!value.trim()
  if (!validNumber && !validString) throw new Error(`${name} 不能为空`)
}

function validateTextTarget(target, name = 'target') {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw new Error(`${name} 必须是对象`)
  }
  if (!TEXT_TARGET_KINDS.includes(target.kind)) {
    throw new Error(`${name}.kind 取值: ${TEXT_TARGET_KINDS.join(' / ')}`)
  }
  const allowedKeys = {
    element: ['kind', 'elementId'],
    tableCell: ['kind', 'tableId', 'cellId', 'row', 'col'],
    mindNode: ['kind', 'mindId', 'nodeId']
  }
  const unknownKeys = Object.keys(target).filter((key) => !allowedKeys[target.kind].includes(key))
  if (unknownKeys.length) {
    throw new Error(`${name} 包含不支持的字段: ${unknownKeys.join(', ')}`)
  }
  if (target.kind === 'element') {
    requireTextTargetId(target.elementId, `${name}.elementId`)
    return
  }
  if (target.kind === 'mindNode') {
    requireTextTargetId(target.mindId, `${name}.mindId`)
    requireTextTargetId(target.nodeId, `${name}.nodeId`)
    return
  }
  requireTextTargetId(target.tableId, `${name}.tableId`)
  const hasCellId = hasOwn(target, 'cellId') && target.cellId !== null && target.cellId !== ''
  const hasRow = hasOwn(target, 'row')
  const hasCol = hasOwn(target, 'col')
  if (hasCellId) requireTextTargetId(target.cellId, `${name}.cellId`)
  if (hasRow !== hasCol) throw new Error(`${name} 的 row 和 col 必须同时提供`)
  if (hasRow && (!Number.isInteger(target.row) || target.row < 0)) {
    throw new Error(`${name}.row 必须是非负整数`)
  }
  if (hasCol && (!Number.isInteger(target.col) || target.col < 0)) {
    throw new Error(`${name}.col 必须是非负整数`)
  }
  if (!hasCellId && !hasRow) {
    throw new Error(`${name} 需要 cellId，或同时提供 row + col`)
  }
}

function validateTextTargetSelector(args, toolName) {
  const hasElementId = hasOwn(args, 'elementId')
  const hasTarget = hasOwn(args, 'target')
  if (hasElementId === hasTarget) {
    throw new Error(`${toolName} 必须且只能提供 legacy elementId 或统一 target 之一`)
  }
  if (hasElementId) requireNonEmptyString(args.elementId, 'elementId')
  else validateTextTarget(args.target)
}

function validateTextToolArgs(name, args = {}) {
  if (TEXT_CONTENT_TARGET_TOOLS.has(name)) validateTextTargetSelector(args, name)
  if (TEXT_LAYOUT_ELEMENT_TOOLS.has(name)) {
    if (hasOwn(args, 'target')) {
      const error = new Error(
        `${name} 只支持普通文本元素的 legacy elementId，不支持 tableCell 或 mindNode target`
      )
      error.code = 'TEXT_LAYOUT_TARGET_UNSUPPORTED'
      throw error
    }
    requireNonEmptyString(args.elementId, 'elementId')
  }
  if (hasOwn(args, 'expectedContentHash')) {
    requireNonEmptyString(args.expectedContentHash, 'expectedContentHash')
  }
  if (hasOwn(args, 'waitMs')) {
    if (typeof args.waitMs !== 'number' || args.waitMs < 0 || args.waitMs > 10000) {
      throw new Error('waitMs 必须是 0 到 10000 之间的数字')
    }
  }
  if (['editor_text_set_layout', 'editor_text_fit'].includes(name)) {
    for (const field of ['expectedContentHash', 'dryRun']) {
      if (hasOwn(args, field)) {
        throw new Error(`${name} 不修改文本内容，不支持 ${field}`)
      }
    }
  }
  if (name === 'editor_text_set_content' && typeof args.content !== 'string') {
    throw new Error('content 必须是字符串')
  }
  if (name === 'editor_text_adaptive') {
    const extendTypes = ['both', 'horizontal', 'vertical', 'none']
    if (!extendTypes.includes(args.extendType)) {
      throw new Error(`extendType 取值: ${extendTypes.join(' / ')}`)
    }
  }
  if (name === 'editor_text_edit') {
    const actions = ['insert', 'replace', 'delete', 'findReplace']
    if (!actions.includes(args.action)) throw new Error(`action 取值: ${actions.join(' / ')}`)
    const hasIndex = Number.isInteger(args.index) && args.index >= 0
    const hasLength = Number.isInteger(args.length) && args.length >= 0
    const hasMatch = typeof args.match === 'string' && args.match.length > 0
    const hasText = hasOwn(args, 'text')
    const hasHtml = hasOwn(args, 'html')
    const hasReplacement = hasText || hasHtml
    if (hasText && typeof args.text !== 'string') throw new Error('text 必须是字符串')
    if (hasHtml && typeof args.html !== 'string') throw new Error('html 必须是字符串')
    if (hasText && hasHtml) throw new Error('text 与 html 只能提供一个')
    if (args.action !== 'findReplace' && hasOwn(args, 'match')) {
      throw new Error('只有 findReplace 可以提供 match')
    }
    if (
      args.action !== 'findReplace' &&
      (hasOwn(args, 'occurrence') || hasOwn(args, 'replaceAll') || hasOwn(args, 'caseSensitive'))
    ) {
      throw new Error('occurrence / replaceAll / caseSensitive 仅适用于 findReplace')
    }
    if (args.action === 'findReplace' && (hasOwn(args, 'index') || hasOwn(args, 'length'))) {
      throw new Error('findReplace 使用 match 定位，不应提供 index 或 length')
    }
    if (args.action === 'insert') {
      if (!hasIndex) throw new Error('insert 必须提供非负整数 index')
      if (!hasReplacement) throw new Error('insert 必须提供 text 或 html')
    }
    if (args.action === 'replace') {
      if (!hasIndex || !hasLength) throw new Error('replace 必须提供非负整数 index 和 length')
      if (!hasReplacement) throw new Error('replace 必须提供 text 或 html')
    }
    if (args.action === 'delete') {
      if (!hasIndex || !hasLength) throw new Error('delete 必须提供非负整数 index 和 length')
      if (hasReplacement) throw new Error('delete 不应提供 text 或 html')
    }
    if (args.action === 'findReplace' && !hasMatch) {
      throw new Error('findReplace 必须提供非空 match；省略 text/html 时删除匹配')
    }
    if (hasOwn(args, 'length') && (!Number.isInteger(args.length) || args.length < 0)) {
      throw new Error('length 必须是非负整数')
    }
    if (hasOwn(args, 'occurrence') && (!Number.isInteger(args.occurrence) || args.occurrence < 1)) {
      throw new Error('occurrence 必须是正整数')
    }
  }
  if (name === 'editor_text_set_link') {
    if (!Number.isInteger(args.index) || args.index < 0) {
      throw new Error('index 必须是非负整数')
    }
    if (!Number.isInteger(args.length) || args.length <= 0) {
      throw new Error('length 必须是正整数')
    }
    const hasHyperlinkId = typeof args.hyperlinkId === 'string' && !!args.hyperlinkId.trim()
    const hasHyperlink =
      !!args.hyperlink &&
      typeof args.hyperlink === 'object' &&
      !Array.isArray(args.hyperlink) &&
      Object.keys(args.hyperlink).length > 0
    if (hasOwn(args, 'hyperlinkId') && !hasHyperlinkId) {
      throw new Error('hyperlinkId 不能为空')
    }
    if (hasOwn(args, 'hyperlink') && !hasHyperlink) {
      throw new Error('hyperlink 必须是非空对象')
    }
    if (hasHyperlink) {
      const metadata = args.hyperlink
      for (const key of ['input_type', 'link_mode', 'jump_type']) {
        if (![1, 2].includes(metadata[key])) {
          throw new Error(`hyperlink.${key} 取值只能是 1 或 2`)
        }
      }
      if (metadata.jump_type === 1) {
        requireNonEmptyString(metadata.link_address, 'hyperlink.link_address')
      }
      if (metadata.jump_type === 2) {
        const validAgentId =
          (typeof metadata.agent_id === 'number' && metadata.agent_id > 0) ||
          (typeof metadata.agent_id === 'string' &&
            !!metadata.agent_id.trim() &&
            metadata.agent_id.trim() !== '0')
        if (!validAgentId) throw new Error('智能体链接必须提供真实 hyperlink.agent_id')
        if (!Array.isArray(metadata.agent_params)) {
          throw new Error('智能体链接必须提供 hyperlink.agent_params 数组')
        }
      }
    }
    if (!hasHyperlinkId && !hasHyperlink) {
      throw new Error('必须提供 hyperlinkId；新链接没有既有 id 时必须提供 hyperlink 元数据')
    }
  }
  if (name === 'editor_text_remove_link') {
    const hasHyperlinkId = typeof args.hyperlinkId === 'string' && !!args.hyperlinkId.trim()
    const hasIndex = Number.isInteger(args.index) && args.index >= 0
    const hasLength = Number.isInteger(args.length) && args.length > 0
    if (hasOwn(args, 'hyperlinkId') && !hasHyperlinkId) {
      throw new Error('hyperlinkId 不能为空')
    }
    if (hasOwn(args, 'index') && !hasIndex) throw new Error('index 必须是非负整数')
    if (hasOwn(args, 'length') && !hasLength) throw new Error('length 必须是正整数')
    if (hasIndex !== hasLength) throw new Error('按范围移除超链接时必须同时提供 index 和 length')
    if (!hasHyperlinkId && !hasIndex) {
      throw new Error('必须提供 hyperlinkId 或完整的 index + length')
    }
  }
  if (name === 'editor_text_edit_embed') {
    const actions = ['insert', 'update', 'delete']
    const embedTypes = ['formulaMath', 'pinyinBox', 'image']
    if (!actions.includes(args.action)) throw new Error(`action 取值: ${actions.join(' / ')}`)
    if (!Number.isInteger(args.index) || args.index < 0) {
      throw new Error('index 必须是非负整数')
    }
    if (hasOwn(args, 'embedType') && !embedTypes.includes(args.embedType)) {
      throw new Error(`embedType 取值: ${embedTypes.join(' / ')}`)
    }
    if (args.action === 'insert' && !embedTypes.includes(args.embedType)) {
      throw new Error('insert 必须提供 embedType')
    }
    if (['insert', 'update'].includes(args.action) && !hasOwn(args, 'value')) {
      throw new Error(`${args.action} 必须提供 value`)
    }
    if (args.action === 'delete' && hasOwn(args, 'value')) {
      throw new Error('delete 不应提供 value')
    }
    if (hasOwn(args, 'value')) {
      const validContainer =
        typeof args.value === 'string' ||
        (!!args.value && typeof args.value === 'object' && !Array.isArray(args.value))
      if (!validContainer) throw new Error('value 必须是字符串或对象')
      if (
        typeof args.value === 'object' &&
        !Array.isArray(args.value) &&
        !Object.keys(args.value).length
      ) {
        throw new Error('value 对象不能为空')
      }
    }
    if (args.embedType === 'formulaMath' && hasOwn(args, 'value')) {
      const latex = typeof args.value === 'string' ? args.value : args.value && args.value.latex
      if (typeof latex !== 'string' || !latex.trim()) {
        throw new Error('formulaMath value 必须是非空 LaTeX 字符串或 { latex }')
      }
    }
    if (args.embedType === 'pinyinBox' && hasOwn(args, 'value')) {
      if (
        !args.value ||
        typeof args.value !== 'object' ||
        Array.isArray(args.value)
      ) {
        throw new Error('pinyinBox value 必须是对象')
      }
      if (args.action === 'insert') {
        if (
          typeof args.value.pinyin !== 'string' ||
          !args.value.pinyin.trim() ||
          typeof args.value.word !== 'string' ||
          !/^\p{Script=Han}$/u.test(args.value.word.trim())
        ) {
          throw new Error('插入 pinyinBox 必须提供非空 pinyin 和单个中文字符 word')
        }
      } else {
        if (
          hasOwn(args.value, 'pinyin') &&
          (typeof args.value.pinyin !== 'string' || !args.value.pinyin.trim())
        ) {
          throw new Error('pinyinBox.pinyin 必须是非空字符串')
        }
        if (
          hasOwn(args.value, 'word') &&
          (typeof args.value.word !== 'string' ||
            !/^\p{Script=Han}$/u.test(args.value.word.trim()))
        ) {
          throw new Error('pinyinBox.word 必须是单个中文字符')
        }
      }
    }
    if (args.embedType === 'image' && hasOwn(args, 'value')) {
      const url = typeof args.value === 'string' ? args.value : args.value && args.value.url
      if (args.value && typeof args.value === 'object' && !Array.isArray(args.value)) {
        const imageFields = new Set([
          'url',
          'width',
          'height',
          'originalWidth',
          'originalHeight',
          'rotate',
          'opacity',
          'flip',
          'outlineWidth',
          'outlineColor',
          'outlineStyle',
          'verticalAlign',
          'offsetX',
          'offsetY'
        ])
        const unknownImageFields = Object.keys(args.value).filter((key) => !imageFields.has(key))
        if (unknownImageFields.length) {
          throw new Error(`不支持的 image value 字段: ${unknownImageFields.join(', ')}`)
        }
        for (const key of [
          'width',
          'height',
          'originalWidth',
          'originalHeight',
          'rotate',
          'opacity',
          'outlineWidth',
          'offsetX',
          'offsetY'
        ]) {
          if (hasOwn(args.value, key) && !Number.isFinite(args.value[key])) {
            throw new Error(`image.${key} 必须是有限数字`)
          }
        }
        if (
          hasOwn(args.value, 'flip') &&
          typeof args.value.flip !== 'number' &&
          typeof args.value.flip !== 'boolean'
        ) {
          throw new Error('image.flip 必须是数字或布尔值')
        }
        for (const key of ['outlineColor', 'outlineStyle', 'verticalAlign']) {
          if (hasOwn(args.value, key) && typeof args.value[key] !== 'string') {
            throw new Error(`image.${key} 必须是字符串`)
          }
        }
      }
      if (args.action === 'insert' && (typeof url !== 'string' || !url.trim())) {
        throw new Error('插入 image 的 value 必须是非空 URL 字符串或包含 url 的对象')
      }
      if (
        args.action === 'update' &&
        hasOwn(args.value, 'url') &&
        (typeof args.value.url !== 'string' || !args.value.url.trim())
      ) {
        throw new Error('image.url 必须是非空字符串')
      }
    }
  }
  if (name === 'editor_text_format') {
    const scopes = ['default', 'all', 'range', 'match', 'paragraph']
    if (!scopes.includes(args.scope)) throw new Error(`scope 取值: ${scopes.join(' / ')}`)
    if (!args.formats || typeof args.formats !== 'object' || !Object.keys(args.formats).length) {
      throw new Error('formats 必须是非空对象')
    }
    const unknownFormats = Object.keys(args.formats).filter(
      (key) => !Object.prototype.hasOwnProperty.call(TEXT_FORMAT_PROPERTIES, key)
    )
    if (unknownFormats.length) throw new Error(`不支持的 formats 字段: ${unknownFormats.join(', ')}`)
    if (args.scope === 'range') {
      if (!Number.isInteger(args.index) || args.index < 0) throw new Error('range 必须提供非负整数 index')
      if (!Number.isInteger(args.length) || args.length < 0) throw new Error('range 必须提供非负整数 length')
    }
    if (args.scope === 'match') requireNonEmptyString(args.match, 'match')
    if (args.scope === 'paragraph') {
      if (!Array.isArray(args.paragraphIndexes) || !args.paragraphIndexes.length) {
        throw new Error('paragraph 必须提供非空 paragraphIndexes')
      }
    }
  }
  if (name === 'editor_text_set_style') {
    if (!args.style || typeof args.style !== 'object' || !Object.keys(args.style).length) {
      throw new Error('style 必须是非空对象')
    }
    const unknownStyle = Object.keys(args.style).filter(
      (key) => !Object.prototype.hasOwnProperty.call(TEXT_DEFAULT_STYLE_PROPERTIES, key)
    )
    if (unknownStyle.length) throw new Error(`不支持的 style 字段: ${unknownStyle.join(', ')}`)
  }
  if (name === 'editor_text_set_layout') {
    if (
      !args.layout ||
      typeof args.layout !== 'object' ||
      Array.isArray(args.layout) ||
      !Object.keys(args.layout).length
    ) {
      throw new Error('layout 必须是非空对象')
    }
    const unknownLayout = Object.keys(args.layout).filter(
      (key) => !Object.prototype.hasOwnProperty.call(TEXT_LAYOUT_PROPERTIES, key)
    )
    if (unknownLayout.length) throw new Error(`不支持的 layout 字段: ${unknownLayout.join(', ')}`)
    if (hasOwn(args.layout, 'fill')) {
      const fill = args.layout.fill
      if (fill === null) {
        // Bridge 将 null 规范化为 isFill=false + fill=null，属于显式清空。
      } else if (
        !fill ||
        typeof fill !== 'object' ||
        Array.isArray(fill) ||
        !Object.keys(fill).length
      ) {
        throw new Error('layout.fill 必须是包含 enabled 或 color 的非空对象')
      } else {
        const unknownFill = Object.keys(fill).filter((key) => !['enabled', 'color'].includes(key))
        if (unknownFill.length) {
          throw new Error(`不支持的 layout.fill 字段: ${unknownFill.join(', ')}`)
        }
        if (hasOwn(fill, 'enabled') && typeof fill.enabled !== 'boolean') {
          throw new Error('layout.fill.enabled 必须是布尔值')
        }
        if (
          hasOwn(fill, 'color') &&
          fill.color !== null &&
          typeof fill.color !== 'string'
        ) {
          throw new Error('layout.fill.color 必须是字符串或 null')
        }
      }
    }
    if (hasOwn(args.layout, 'overflowType')) {
      const overflowType = args.layout.overflowType
      const supportedOverflowTypes = ['auto', 'overWithBreak', 'overSizeScroll']
      if (
        overflowType !== null &&
        (!Array.isArray(overflowType) ||
          overflowType.some((value) => !supportedOverflowTypes.includes(value)) ||
          new Set(overflowType).size !== overflowType.length)
      ) {
        throw new Error(
          `layout.overflowType 必须是无重复的数组: ${supportedOverflowTypes.join(' / ')}，或 null`
        )
      }
    }
  }
  if (name === 'editor_text_fit_to_box') {
    if (hasOwn(args, 'dryRun')) {
      throw new Error('editor_text_fit_to_box 不支持 dryRun；混合字号默认会零写入返回诊断')
    }
    if (
      hasOwn(args, 'allowUniformizeMixedSizes') &&
      typeof args.allowUniformizeMixedSizes !== 'boolean'
    ) {
      throw new Error('allowUniformizeMixedSizes 必须是布尔值')
    }
    if (
      hasOwn(args, 'minFontSize') &&
      hasOwn(args, 'maxFontSize') &&
      args.minFontSize > args.maxFontSize
    ) {
      throw new Error('minFontSize 不能大于 maxFontSize')
    }
    if (hasOwn(args, 'step') && (typeof args.step !== 'number' || args.step <= 0)) {
      throw new Error('step 必须是正数')
    }
  }
  if (name === 'editor_text_search') {
    requireNonEmptyString(args.query, 'query')
    if (hasOwn(args, 'targetKinds')) {
      if (!Array.isArray(args.targetKinds) || !args.targetKinds.length) {
        throw new Error('targetKinds 必须是非空数组')
      }
      const invalidKind = args.targetKinds.find((kind) => !TEXT_TARGET_KINDS.includes(kind))
      if (invalidKind) throw new Error(`targetKinds 取值: ${TEXT_TARGET_KINDS.join(' / ')}`)
      if (new Set(args.targetKinds).size !== args.targetKinds.length) {
        throw new Error('targetKinds 不能包含重复值')
      }
    }
    if (args.useRegex) {
      try {
        new RegExp(args.query, args.caseSensitive ? 'g' : 'gi')
      } catch (error) {
        throw new Error(`query 不是有效正则: ${error.message}`)
      }
    }
  }
  if (name === 'editor_text_copy_style') {
    const hasSourceElementId = hasOwn(args, 'sourceElementId')
    const hasSourceTarget = hasOwn(args, 'sourceTarget')
    if (hasSourceElementId === hasSourceTarget) {
      throw new Error('必须且只能提供 sourceElementId 或 sourceTarget 之一')
    }
    if (hasSourceElementId) requireNonEmptyString(args.sourceElementId, 'sourceElementId')
    else validateTextTarget(args.sourceTarget, 'sourceTarget')
    const hasTargetElementIds = hasOwn(args, 'targetElementIds')
    const hasTargetTargets = hasOwn(args, 'targetTargets')
    if (hasTargetElementIds === hasTargetTargets) {
      throw new Error('必须且只能提供 targetElementIds 或 targetTargets 之一')
    }
    if (hasTargetElementIds) {
      if (!Array.isArray(args.targetElementIds) || !args.targetElementIds.length) {
        throw new Error('targetElementIds 必须是非空数组')
      }
      args.targetElementIds.forEach((id) => requireNonEmptyString(id, 'targetElementIds[]'))
    } else {
      if (!Array.isArray(args.targetTargets) || !args.targetTargets.length) {
        throw new Error('targetTargets 必须是非空数组')
      }
      args.targetTargets.forEach((target, index) =>
        validateTextTarget(target, `targetTargets[${index}]`)
      )
    }
    if (
      hasOwn(args, 'scope') &&
      !['default', 'character', 'paragraph', 'layout', 'all'].includes(args.scope)
    ) {
      throw new Error('scope 取值: default / character / paragraph / layout / all')
    }
    const scope = args.scope || 'default'
    const nestedSource = hasSourceTarget && args.sourceTarget.kind !== 'element'
    const nestedTarget =
      hasTargetTargets && args.targetTargets.some((target) => target.kind !== 'element')
    if ((scope === 'layout' || scope === 'all') && (nestedSource || nestedTarget)) {
      const error = new Error(
        'editor_text_copy_style 的 layout/all 只支持普通文本元素；嵌套目标请使用 default / character / paragraph'
      )
      error.code = 'TEXT_LAYOUT_TARGET_UNSUPPORTED'
      throw error
    }
  }
  if (
    name === 'editor_text_fonts' &&
    hasOwn(args, 'language') &&
    !['all', 'chinese', 'english', 'number'].includes(args.language)
  ) {
    throw new Error('language 取值: all / chinese / english / number')
  }
}

function requireFiniteNumber(value, name, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} 必须是有限数字`)
  }
  if (options.minimum !== undefined && value < options.minimum) {
    throw new Error(`${name} 必须大于等于 ${options.minimum}`)
  }
  if (options.exclusiveMinimum !== undefined && value <= options.exclusiveMinimum) {
    throw new Error(`${name} 必须大于 ${options.exclusiveMinimum}`)
  }
  if (options.maximum !== undefined && value > options.maximum) {
    throw new Error(`${name} 必须小于等于 ${options.maximum}`)
  }
}

function requirePlainObject(value, name, { nonEmpty = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`)
  }
  if (nonEmpty && Object.keys(value).length === 0) throw new Error(`${name} 不能为空对象`)
}

function validateSwitchSafetyOptions(args, toolName) {
  for (const field of ['saveBeforeSwitch', 'discardChanges']) {
    if (hasOwn(args, field) && typeof args[field] !== 'boolean') {
      throw new Error(`${toolName}.${field} 必须是布尔值`)
    }
  }
  if (args.saveBeforeSwitch === true && args.discardChanges === true) {
    throw new Error(`${toolName}: saveBeforeSwitch 与 discardChanges 不能同时为 true`)
  }
}

function validateExactOne(args, fields, toolName) {
  const present = fields.filter((field) => {
    if (!hasOwn(args, field)) return false
    const value = args[field]
    if (typeof value === 'string') return !!value.trim()
    return value !== undefined && value !== null
  })
  if (present.length !== 1) {
    throw new Error(`${toolName} 必须且只能提供 ${fields.join(' / ')} 之一`)
  }
}

function validateCoreToolArgs(name, args = {}) {
  if (name === 'editor_export_semantic_snapshot') {
    if (hasOwn(args, 'slideId')) {
      requireTextTargetId(args.slideId, 'slideId')
      if (!/^[1-9]\d*$/.test(String(args.slideId).trim())) {
        throw new Error('slideId 必须是正整数 id')
      }
    }
    if (hasOwn(args, 'richText') && !['none', 'summary', 'deep'].includes(args.richText)) {
      throw new Error('richText 取值: none / summary / deep')
    }
  }
  const requiredStringFields = {
    editor_select_slide: ['slideId'],
    editor_delete_slide: ['slideId'],
    editor_move_slide: ['slideId'],
    editor_move_block: ['blockId'],
    editor_replace_block: ['blockId'],
    editor_copy_block_to_slide: ['blockId', 'targetSlideId'],
    editor_update_block: ['blockId'],
    editor_update_element: ['elementId'],
    editor_move_element: ['elementId'],
    editor_resize_element: ['elementId'],
    editor_rotate_element: ['elementId'],
    editor_center_element_in_block: ['elementId'],
    editor_scroll_to_block: ['blockId'],
    editor_scroll_to_element: ['elementId'],
    editor_import_blocks: ['slideId']
  }
  for (const field of requiredStringFields[name] || []) {
    requireNonEmptyString(args[field], field)
  }

  if (name === 'editor_search_templates') {
    const scope = args.scope || 'book'
    if (!['book', 'center'].includes(scope)) {
      throw new Error('editor_search_templates.scope 取值: book / center')
    }
    if (hasOwn(args, 'kind') && !['chapter', 'block'].includes(args.kind)) {
      throw new Error('editor_search_templates.kind 取值: chapter / block')
    }
    if (
      hasOwn(args, 'interactionType') &&
      !['hypermedia', 'interface'].includes(args.interactionType)
    ) {
      throw new Error(
        'editor_search_templates.interactionType 取值: hypermedia / interface'
      )
    }
    if (scope === 'center' && !hasOwn(args, 'interactionType')) {
      throw new Error(
        'editor_search_templates: scope=center 时必须指定 interactionType'
      )
    }
    if (hasOwn(args, 'pageNo') && (!Number.isInteger(args.pageNo) || args.pageNo < 0)) {
      throw new Error('editor_search_templates.pageNo 必须是非负整数')
    }
    if (
      hasOwn(args, 'pageSize') &&
      (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 100)
    ) {
      throw new Error('editor_search_templates.pageSize 必须是 1..100 的整数')
    }
  }

  if (
    [
      'editor_select_slide',
      'editor_add_slide',
      'editor_delete_slide',
      'editor_import_blocks',
      'editor_copy_block_to_slide',
      'editor_apply_template'
    ].includes(name)
  ) {
    validateSwitchSafetyOptions(args, name)
  }

  if (name === 'editor_apply_template') {
    if (!['chapter', 'block'].includes(args.kind)) {
      throw new Error('editor_apply_template.kind 取值: chapter / block')
    }
    requireTextTargetId(args.templateId, 'templateId')
    if (
      args.kind === 'block' &&
      (hasOwn(args, 'saveBeforeSwitch') || hasOwn(args, 'discardChanges'))
    ) {
      throw new Error('editor_apply_template: saveBeforeSwitch / discardChanges 仅适用于 chapter')
    }
    if (hasOwn(args, 'index') && (!Number.isInteger(args.index) || args.index < 0)) {
      throw new Error('editor_apply_template.index 必须是非负整数')
    }
  }

  if (name === 'editor_add_slide') {
    if (hasOwn(args, 'name')) requireNonEmptyString(args.name, 'name')
    if (hasOwn(args, 'templateId')) requireTextTargetId(args.templateId, 'templateId')
    if (hasOwn(args, 'templateType')) requireFiniteNumber(args.templateType, 'templateType')
  }

  if (name === 'editor_apply_image') {
    validateExactOne(args, ['imageId', 'url'], name)
    validateExactOne(args, ['blockId', 'elementId'], name)
    if (hasOwn(args, 'url')) requireNonEmptyString(args.url, 'url')
  }
  if (name === 'editor_upload_file') {
    validateExactOne(args, ['filePath', 'data'], name)
    const field = hasOwn(args, 'filePath') ? 'filePath' : 'data'
    requireNonEmptyString(args[field], field)
  }
  if (['editor_add_image_element', 'editor_set_image_src'].includes(name)) {
    validateExactOne(args, ['url', 'imagePath', 'data'], name)
    const field = ['url', 'imagePath', 'data'].find(
      (candidate) => hasOwn(args, candidate) && String(args[candidate] || '').trim()
    )
    requireNonEmptyString(args[field], field)
  }
  if (name === 'editor_copy_digital_module') {
    validateExactOne(args, ['sourceElementId', 'modelId'], name)
    requireNonEmptyString(args.targetElementId, 'targetElementId')
    if (hasOwn(args, 'sourceElementId')) {
      requireNonEmptyString(args.sourceElementId, 'sourceElementId')
    }
    if (hasOwn(args, 'replaceExisting')) {
      throw new Error(
        'editor_copy_digital_module 不支持 replaceExisting；目标已有模块时请显式 delete 后再 copy'
      )
    }
  }

  if (['editor_update_block', 'editor_update_element'].includes(name)) {
    requirePlainObject(args.patch, 'patch', { nonEmpty: true })
  }
  if (name === 'editor_replace_block') {
    requirePlainObject(args.templateData, 'templateData', { nonEmpty: true })
  }

  if (['editor_move_slide', 'editor_move_block'].includes(name)) {
    if (!Number.isInteger(args.toIndex) || args.toIndex < 0) {
      throw new Error(`${name}.toIndex 必须是非负整数`)
    }
  }
  if (name === 'editor_import_blocks') {
    if (!Array.isArray(args.blocks) || !args.blocks.length) {
      throw new Error('editor_import_blocks.blocks 必须是非空对象数组')
    }
    args.blocks.forEach((block, index) => requirePlainObject(block, `blocks[${index}]`))
    if (hasOwn(args, 'index') && (!Number.isInteger(args.index) || args.index < 0)) {
      throw new Error('editor_import_blocks.index 必须是非负整数')
    }
  }
  if (
    name === 'editor_copy_block_to_slide' &&
    hasOwn(args, 'index') &&
    (!Number.isInteger(args.index) || args.index < 0)
  ) {
    throw new Error('editor_copy_block_to_slide.index 必须是非负整数')
  }

  if (name === 'editor_move_element') {
    requireFiniteNumber(args.x, 'x')
    requireFiniteNumber(args.y, 'y')
  }
  if (name === 'editor_move_elements') {
    if (!Array.isArray(args.elementIds) || !args.elementIds.length) {
      throw new Error('editor_move_elements.elementIds 必须是非空数组')
    }
    const ids = args.elementIds.map((id) => String(id || '').trim())
    if (ids.some((id) => !id)) throw new Error('elementIds 不能包含空 id')
    if (new Set(ids).size !== ids.length) throw new Error('elementIds 不能重复')
    requireFiniteNumber(args.x, 'x')
    requireFiniteNumber(args.y, 'y')
  }
  if (name === 'editor_resize_element') {
    requireFiniteNumber(args.width, 'width', { exclusiveMinimum: 0 })
    requireFiniteNumber(args.height, 'height', { exclusiveMinimum: 0 })
  }
  if (name === 'editor_rotate_element') requireFiniteNumber(args.angle, 'angle')
  if (name === 'editor_set_element_spacing') {
    if (!Array.isArray(args.elementIds) || args.elementIds.length < 2) {
      throw new Error('editor_set_element_spacing.elementIds 至少需要两个元素 id')
    }
    const ids = args.elementIds.map((id) => String(id || '').trim())
    if (ids.some((id) => !id)) throw new Error('elementIds 不能包含空 id')
    if (new Set(ids).size !== ids.length) throw new Error('elementIds 不能重复')
    if (!['horizontal', 'vertical'].includes(args.direction)) {
      throw new Error('direction 取值: horizontal / vertical')
    }
    requireFiniteNumber(args.spacing, 'spacing')
  }
  if (name === 'editor_move_elements_by_offset') {
    if (!Array.isArray(args.elementIds) || !args.elementIds.length) {
      throw new Error('editor_move_elements_by_offset.elementIds 必须是非空数组')
    }
    const ids = args.elementIds.map((id) => String(id || '').trim())
    if (ids.some((id) => !id)) throw new Error('elementIds 不能包含空 id')
    if (new Set(ids).size !== ids.length) throw new Error('elementIds 不能重复')
    if (hasOwn(args, 'dx')) requireFiniteNumber(args.dx, 'dx')
    if (hasOwn(args, 'dy')) requireFiniteNumber(args.dy, 'dy')
  }
  if (name === 'editor_duplicate_elements') {
    if (!Array.isArray(args.elementIds) || !args.elementIds.length) {
      throw new Error('editor_duplicate_elements.elementIds 必须是非空数组')
    }
    const ids = args.elementIds.map((id) => String(id || '').trim())
    if (ids.some((id) => !id)) throw new Error('elementIds 不能包含空 id')
    if (new Set(ids).size !== ids.length) throw new Error('elementIds 不能重复')
    if (hasOwn(args, 'offsetX')) requireFiniteNumber(args.offsetX, 'offsetX')
    if (hasOwn(args, 'offsetY')) requireFiniteNumber(args.offsetY, 'offsetY')
  }
  if (['editor_align_elements', 'editor_get_elements_bounds'].includes(name)) {
    if (!Array.isArray(args.elementIds) || !args.elementIds.length) {
      throw new Error(`${name}.elementIds 必须是非空数组`)
    }
    const ids = args.elementIds.map((id) => String(id || '').trim())
    if (ids.some((id) => !id)) throw new Error('elementIds 不能包含空 id')
    if (new Set(ids).size !== ids.length) throw new Error('elementIds 不能重复')
  }
  if (name === 'editor_align_elements') {
    if (
      ![
        'top',
        'bottom',
        'left',
        'right',
        'horizontal',
        'vertical',
        'center',
        'hdengju',
        'vdengju'
      ].includes(args.align)
    ) {
      throw new Error(
        'align 取值: top / bottom / left / right / horizontal / vertical / center / hdengju / vdengju'
      )
    }
    if (hasOwn(args, 'target') && !['selection', 'block', 'page'].includes(args.target)) {
      throw new Error('target 取值: selection / block / page')
    }
    if (
      hasOwn(args, 'coordinateSpace') &&
      !['block', 'page'].includes(args.coordinateSpace)
    ) {
      throw new Error('coordinateSpace 取值: block / page')
    }
    if (args.target === 'block' && args.coordinateSpace === 'page') {
      throw new Error('target=block 时 coordinateSpace 必须为 block')
    }
    if (args.target === 'page' && args.coordinateSpace === 'block') {
      throw new Error('target=page 时 coordinateSpace 必须为 page')
    }
  }
  if (
    name === 'editor_get_elements_bounds' &&
    hasOwn(args, 'coordinateSpace') &&
    !['block', 'page'].includes(args.coordinateSpace)
  ) {
    throw new Error('coordinateSpace 取值: block / page')
  }
  if (
    name === 'editor_center_element_in_block' &&
    hasOwn(args, 'axis') &&
    !['horizontal', 'vertical', 'both'].includes(args.axis)
  ) {
    throw new Error('axis 取值: horizontal / vertical / both')
  }
  if (name === 'editor_set_zoom') {
    requireFiniteNumber(args.scale, 'scale', { minimum: 0.1, maximum: 3 })
  }

  if (name === 'editor_batch') {
    if (!Array.isArray(args.steps) || !args.steps.length) {
      throw new Error('editor_batch.steps 必须是非空数组')
    }
    if (hasOwn(args, 'stopOnError') && typeof args.stopOnError !== 'boolean') {
      throw new Error('editor_batch.stopOnError 必须是布尔值')
    }
    args.steps.forEach((step, index) => {
      requirePlainObject(step, `steps[${index}]`)
      requireNonEmptyString(step.method, `steps[${index}].method`)
      if (hasOwn(step, 'args') && !Array.isArray(step.args)) {
        throw new Error(`steps[${index}].args 必须是 JSON 参数数组`)
      }
      const method = step.method.trim()
      if (['screenshot', 'captureScreenshot', 'editor_screenshot'].includes(method)) {
        throw new Error('editor_batch 禁止截图步骤；请把 editor_screenshot 作为单独工具调用')
      }
      if (method === 'batch') throw new Error('editor_batch 不允许嵌套 batch')
    })
  }
  if (name === 'editor_rpc_call') {
    requireNonEmptyString(args.method, 'method')
    if (hasOwn(args, 'args') && !Array.isArray(args.args)) {
      throw new Error('editor_rpc_call.args 必须是 JSON 参数数组')
    }
    if (['screenshot', 'captureScreenshot', 'editor_screenshot'].includes(args.method.trim())) {
      throw new Error('editor_rpc_call 不返回截图 base64；请使用 editor_screenshot')
    }
  }
}

async function saveCurrentEditorStateVerified(state, operation) {
  const currentSlideId = state && state.currentSlideId
  if (currentSlideId === undefined || currentSlideId === null || currentSlideId === '') {
    throw new Error(`${operation}: 无法确定 dirty 当前页，已拒绝切页前保存`)
  }
  return driver.bridgeCall('saveVerified', [
    { scope: 'current', verify: true, expectedSlideId: currentSlideId }
  ])
}

async function preflightVerifiedSwitch(args, options = {}) {
  if (args.saveBeforeSwitch !== true) return { checked: false, saved: false }
  const state = await driver.bridgeCall('getState')
  const leavesCurrent =
    options.alwaysLeavesCurrent === true ||
    (typeof options.leavesCurrent === 'function' && options.leavesCurrent(state))
  if (!leavesCurrent || !state.dirty) {
    return { checked: true, saved: false, state }
  }
  await saveCurrentEditorStateVerified(state, options.operation || '安全切页')
  return { checked: true, saved: true, state }
}

async function prepareCrossPageBlockCopy(args) {
  const state = await driver.bridgeCall('getState')
  if (String(state.currentSlideId) === String(args.targetSlideId) || !state.dirty) return
  if (args.discardChanges === true) {
    throw new Error(
      '跨页复制不能一边复制 dirty 源内容一边丢弃；请先 editor_save_verified，或回滚/清理改动后再复制'
    )
  }
  if (args.saveBeforeSwitch !== true) {
    throw new Error(
      '当前页有未保存改动；跨页复制前请传 saveBeforeSwitch: true，以保存并回读源区块'
    )
  }
  await saveCurrentEditorStateVerified(state, '跨页复制区块')
}

function getTextTargetSelector(args = {}) {
  return hasOwn(args, 'target') ? { target: args.target } : { elementId: args.elementId }
}

async function readSemanticSnapshot(args = {}) {
  try {
    return await driver.bridgeCall('getSemanticSnapshot', [
      {
        ...(args.slideId == null ? {} : { slideId: args.slideId }),
        richText: args.richText || 'deep'
      }
    ])
  } catch (error) {
    throw normalizeSemanticSnapshotBridgeError(error)
  }
}

async function callTool(name, args) {
  validateQuestionToolArgs(name, args)
  validateTextToolArgs(name, args)
  validateCoreToolArgs(name, args)
  let data
  switch (name) {
    case 'editor_status': {
      data = await driver.getStatus()
      break
    }
    case 'editor_connect':
      data = await driver.connect()
      break
    case 'editor_get_user_info':
      data = await driver.bridgeCall('getUserInfo', [{ refresh: !!args.refresh }])
      break
    case 'editor_search_books':
      data = await driver.bridgeCall('searchBooks', [args])
      break
    case 'editor_get_book':
      data = await driver.bridgeCall('getBookInfo', [{ bookId: args.bookId }])
      break
    case 'editor_create_book': {
      const createArgs = { ...args }
      if (createArgs.coverImagePath) {
        const uploaded = await driver.uploadImage({
          imagePath: createArgs.coverImagePath,
          fileName: createArgs.coverFileName
        })
        createArgs.coverImgId = uploaded.fileId
        createArgs.coverImgUrl = uploaded.url
        delete createArgs.coverImagePath
      }
      data = await driver.bridgeCall('createBookFromSource', [createArgs])
      break
    }
    case 'editor_jump_to_book': {
      if ((args.target || 'url') === 'current') {
        const state = await driver.bridgeCall('getState')
        if (state.dirty && args.saveBeforeSwitch !== true) {
          throw new Error(
            '当前页有未保存改动；切换书本前请传 saveBeforeSwitch: true，以保存并回读当前页'
          )
        }
        if (state.dirty) await saveCurrentEditorStateVerified(state, '切换书本')
      }
      data = await driver.jumpToBook(args)
      break
    }
    case 'editor_get_book_manifest':
    case 'editor_search_book_content':
    case 'editor_save_verified':
    case 'editor_list_book_versions':
    case 'editor_get_book_version':
    case 'editor_restore_book_version':
    case 'editor_plan_question_lesson':
    case 'editor_render_questions_to_block':
    case 'editor_audit_content': {
      if (name === 'editor_render_questions_to_block') {
        await preflightVerifiedSwitch(args, {
          operation: '跨页渲染题目',
          leavesCurrent: (state) =>
            args.slideId !== undefined &&
            args.slideId !== null &&
            String(args.slideId) !== String(state.currentSlideId)
        })
      }
      const call = prepareBookAuthoringCall(name, args)
      data = await driver.bridgeCall(call.method, call.args)
      break
    }
    case 'editor_search_templates':
      data = await driver.bridgeCall('searchTemplates', [args])
      break
    case 'editor_get_template':
      data = await driver.bridgeCall('getTemplateDetail', [args])
      break
    case 'editor_apply_template':
      if (args.kind === 'chapter') {
        await preflightVerifiedSwitch(args, {
          operation: '应用样章模板并新增目录',
          alwaysLeavesCurrent: true
        })
      }
      data = await driver.bridgeCall('applyTemplate', [args])
      break
    case 'editor_search_components':
      data = await driver.bridgeCall('searchComponents', [args])
      break
    case 'editor_apply_component':
      data = await driver.bridgeCall('applyComponent', [args])
      break
    case 'editor_search_images':
      data = await driver.bridgeCall('searchImageLibrary', [args])
      break
    case 'editor_apply_image':
      data = await driver.bridgeCall('applyLibraryImage', [args])
      break
    case 'editor_upload_file':
      data = await driver.uploadFile(args)
      break
    case 'editor_list_digital_module_types':
      data = await driver.bridgeCall('listDigitalModuleTypes', [args])
      break
    case 'editor_get_digital_module':
      data = await driver.bridgeCall('getDigitalModule', [args])
      break
    case 'editor_list_digital_modules':
      data = await driver.bridgeCall('listDigitalModules', [args])
      break
    case 'editor_create_digital_module':
      data = await driver.bridgeCall('createDigitalModule', [await prepareDigitalModuleArgs(args)])
      break
    case 'editor_update_digital_module':
      data = await driver.bridgeCall('updateDigitalModule', [await prepareDigitalModuleArgs(args)])
      break
    case 'editor_delete_digital_module':
      data = await driver.bridgeCall('deleteDigitalModule', [args])
      break
    case 'editor_copy_digital_module':
      data = await driver.bridgeCall('copyDigitalModule', [args])
      break
    case 'editor_list_question_paths':
      data = await driver.bridgeCall('listQuestionPaths', [args])
      break
    case 'editor_get_question_search_options':
      data = await driver.bridgeCall('getQuestionSearchOptions', [args])
      break
    case 'editor_search_questions':
      data = await driver.bridgeCall('searchQuestions', [args])
      break
    case 'editor_get_questions':
      data = await driver.bridgeCall('getQuestions', [args])
      break
    case 'editor_validate_question_selection':
      data = await driver.bridgeCall('validateQuestionSelection', [args])
      break
    case 'editor_get_question_solutions':
      data = await driver.bridgeCall('getQuestionSolutions', [args])
      break
    case 'editor_add_questions_to_catalog':
      data = await driver.bridgeCall('addQuestionsToCatalog', [args])
      break
    case 'editor_remove_catalog_question':
      data = await driver.bridgeCall('removeCatalogQuestion', [args])
      break
    case 'editor_move_catalog_question':
      data = await driver.bridgeCall('moveCatalogQuestion', [args])
      break
    case 'editor_get_question_explanations':
      data = await driver.bridgeCall('getQuestionExplanations', [args])
      break
    case 'editor_start_question_explanation_generation':
      data = await driver.bridgeCall('startQuestionExplanationGeneration', [args])
      break
    case 'editor_get_question_explanation_status':
      data = await driver.bridgeCall('getQuestionExplanationStatus', [args])
      break
    case 'editor_save_question_explanation':
      data = await driver.bridgeCall('saveQuestionExplanation', [args])
      break
    case 'editor_delete_question_explanation':
      data = await driver.bridgeCall('deleteQuestionExplanation', [args])
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
    case 'editor_select_slide': {
      await preflightVerifiedSwitch(args, {
        operation: '切换目录',
        leavesCurrent: (state) => String(args.slideId) !== String(state.currentSlideId)
      })
      const hasSafetyOption =
        hasOwn(args, 'saveBeforeSwitch') || hasOwn(args, 'discardChanges')
      data = await driver.bridgeCall('selectSlide', [hasSafetyOption ? args : args.slideId])
      break
    }
    case 'editor_add_slide': {
      await preflightVerifiedSwitch(args, {
        operation: '新增并切换目录',
        alwaysLeavesCurrent: true
      })
      const payload = {
        name: args.name,
        parentId: args.parentId,
        saveBeforeSwitch: args.saveBeforeSwitch,
        discardChanges: args.discardChanges
      }
      if (hasOwn(args, 'templateId')) {
        payload.template_id = args.templateId
        payload.type = hasOwn(args, 'templateType') ? args.templateType : 3
      }
      data = await driver.bridgeCall('addSlide', [payload])
      break
    }
    case 'editor_delete_slide':
      await preflightVerifiedSwitch(args, {
        operation: '删除当前目录',
        leavesCurrent: (state) => String(args.slideId) === String(state.currentSlideId)
      })
      data = await driver.bridgeCall('deleteSlide', [args])
      break
    case 'editor_move_slide':
      data = await driver.bridgeCall('moveSlide', [args])
      break
    case 'editor_add_block':
      data = await driver.bridgeCall('addBlock', [args])
      break
    case 'editor_update_block':
      data = await driver.bridgeCall('updateBlock', [args])
      break
    case 'editor_clone_block':
      data = await driver.bridgeCall('cloneBlock', [args.blockId, { afterBlockId: args.afterBlockId, name: args.name }])
      break
    case 'editor_move_block':
      data = await driver.bridgeCall('moveBlock', [args])
      break
    case 'editor_replace_block':
      data = await driver.bridgeCall('replaceBlock', [args.blockId, args.templateData])
      break
    case 'editor_copy_block_to_slide':
      await prepareCrossPageBlockCopy(args)
      data = await driver.bridgeCall('copyBlockToSlide', [
        args.blockId,
        args.targetSlideId,
        { index: args.index }
      ])
      break
    case 'editor_delete_block':
      data = await driver.bridgeCall('deleteBlock', [args.blockId])
      break
    case 'editor_add_element':
      data = await driver.bridgeCall('addElement', [args])
      break
    case 'editor_update_element':
      data = await driver.bridgeCall('updateElement', [args])
      break
    case 'editor_move_element':
      data = await driver.bridgeCall('moveElements', [
        { elementIds: [args.elementId], x: args.x, y: args.y }
      ])
      break
    case 'editor_move_elements':
      data = await driver.bridgeCall('moveElements', [args])
      break
    case 'editor_resize_element':
      data = await driver.bridgeCall('resizeElement', [args])
      break
    case 'editor_rotate_element':
      data = await driver.bridgeCall('rotateElement', [args])
      break
    case 'editor_set_element_spacing':
      data = await driver.bridgeCall('setElementSpacing', [args])
      break
    case 'editor_center_element_in_block':
      data = await driver.bridgeCall('centerElementInBlock', [
        { elementId: args.elementId, axis: args.axis || 'both' }
      ])
      break
    case 'editor_delete_element':
      data = await driver.bridgeCall('deleteElement', [args.elementId])
      break
    case 'editor_group_elements':
      data = await driver.bridgeCall('groupElements', [args.elementIds])
      break
    case 'editor_ungroup':
      data = await driver.bridgeCall('ungroup', [args.groupId])
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
    case 'editor_checkpoint':
      data = await driver.bridgeCall('checkpoint', [{ label: args.label }])
      break
    case 'editor_rollback':
      data = await driver.bridgeCall('rollback', [{ checkpointId: args.checkpointId }])
      break
    case 'editor_list_checkpoints':
      data = await driver.bridgeCall('listCheckpoints')
      break
    case 'editor_clear_checkpoints':
      data = await driver.bridgeCall('clearCheckpoints')
      break
    case 'editor_save':
      data = await driver.bridgeCall('save')
      break
    case 'editor_screenshot':
      data = await driver.captureScreenshot({ fullPage: !!args.fullPage, blockId: args.blockId || null })
      break
    case 'editor_get_canvas_tree':
      data = await driver.bridgeCall('getCanvasTree')
      break
    case 'editor_get_canvas_info':
      data = await driver.bridgeCall('getCanvasInfo')
      break
    case 'editor_scroll_to_block':
      data = await driver.bridgeCall('scrollToBlock', [args.blockId])
      break
    case 'editor_scroll_to_element':
      data = await driver.bridgeCall('scrollToElement', [args.elementId])
      break
    case 'editor_set_zoom':
      data = await driver.bridgeCall('setZoom', [args.scale])
      break
    case 'editor_fit_canvas':
      data = await driver.bridgeCall('fitCanvas')
      break
    case 'editor_get_element':
      data = await driver.bridgeCall('getElement', [args.elementId])
      break
    case 'editor_list_blocks':
      data = await driver.bridgeCall('listBlocks')
      break
    case 'editor_search_elements':
      data = await driver.bridgeCall('searchElements', [args])
      break
    case 'editor_align_elements':
      data = await driver.bridgeCall('alignElements', [args])
      break
    case 'editor_get_elements_bounds':
      data = await driver.bridgeCall('getElementsBounds', [
        args.elementIds,
        { coordinateSpace: args.coordinateSpace || 'block' }
      ])
      break
    case 'editor_duplicate_elements':
      data = await driver.bridgeCall('duplicateElements', [args.elementIds, { offsetX: args.offsetX, offsetY: args.offsetY }])
      break
    case 'editor_move_elements_by_offset':
      data = await driver.bridgeCall('moveElementsByOffset', [args])
      break
    case 'editor_rename_slide':
      data = await driver.bridgeCall('renameSlide', [args.slideId, args.name])
      break
    case 'editor_duplicate_slide':
      data = await driver.bridgeCall('duplicateSlide', [args.slideId])
      break
    case 'editor_rename_block':
      data = await driver.bridgeCall('renameBlock', [args.blockId, args.name])
      break
    case 'editor_export_slide':
      data = await driver.bridgeCall('exportSlide', [args.slideId])
      break
    case 'editor_export_semantic_snapshot':
      data = persistSemanticSnapshot(await readSemanticSnapshot(args))
      break
    case 'editor_import_blocks':
      await preflightVerifiedSwitch(args, {
        operation: '跨页导入区块',
        leavesCurrent: (state) => String(args.slideId) !== String(state.currentSlideId)
      })
      data = await driver.bridgeCall('importBlocks', [
        args.slideId,
        args.blocks,
        {
          index: args.index,
          saveBeforeSwitch: args.saveBeforeSwitch,
          discardChanges: args.discardChanges
        }
      ])
      break
    case 'editor_table_info': {
      const [info, grid] = await Promise.all([
        driver.bridgeCall('getTableInfo', [{ tableId: args.tableId }]),
        driver.bridgeCall('getTableGrid', [{ tableId: args.tableId }])
      ])
      data = { ...info, grid: grid.grid, mergedCells: grid.mergedCells, gridRows: grid.rows, gridCols: grid.cols }
      break
    }
    case 'editor_table_set_cell':
      if (args.content !== undefined && args.content !== null) {
        data = await driver.bridgeCall('setTableCellContent', [{ tableId: args.tableId, row: args.row, col: args.col, content: args.content }])
      }
      if (args.background !== undefined) {
        data = await driver.bridgeCall('setTableCellBackground', [{ tableId: args.tableId, row: args.row, col: args.col, background: args.background }])
      }
      if (data === undefined) data = null
      break
    case 'editor_table_update':
      data = await driver.bridgeCall('updateTable', [{ tableId: args.tableId, patch: args.patch }])
      break
    case 'editor_table_structure': {
      const a = args
      const map = {
        insertRow: 'insertTableRow',
        deleteRow: 'deleteTableRow',
        insertColumn: 'insertTableColumn',
        deleteColumn: 'deleteTableColumn',
        mergeCells: 'mergeTableCells',
        splitCell: 'splitTableCell'
      }
      const method = map[a.action]
      if (!method) throw new Error('未知 action: ' + a.action)
      if (method === 'mergeTableCells' || method === 'splitTableCell') {
        data = await driver.bridgeCall(method, [{ tableId: a.tableId, startRow: a.startRow, startCol: a.startCol, endRow: a.endRow, endCol: a.endCol, row: a.row, col: a.col }])
      } else {
        data = await driver.bridgeCall(method, [{ tableId: a.tableId, index: a.index, count: a.count }])
      }
      break
    }
    case 'editor_table_fit_heights':
      data = await driver.bridgeCall('fitTableHeights', [{ tableId: args.tableId, waitMs: args.waitMs, minHeight: args.minHeight }])
      break
    case 'editor_mind_info': {
      const [data0, tree] = await Promise.all([
        driver.bridgeCall('getMindData', [{ mindId: args.mindId }]),
        driver.bridgeCall('getMindTree', [{ mindId: args.mindId }])
      ])
      data = { ...data0, nodeCount: tree.nodeCount, depth: tree.depth, root: tree.root }
      break
    }
    case 'editor_mind_set_node': {
      if (args.text !== undefined && args.text !== null) {
        data = await driver.bridgeCall('setMindNodeText', [{ mindId: args.mindId, nodeId: args.nodeId, text: args.text }])
      }
      if (args.patch && Object.keys(args.patch).length) {
        data = await driver.bridgeCall('updateMindNode', [{ mindId: args.mindId, nodeId: args.nodeId, patch: args.patch }])
      }
      if (data === undefined) data = null
      break
    }
    case 'editor_mind_structure': {
      const a = args
      if (a.action === 'delete') {
        data = await driver.bridgeCall('deleteMindNode', [{ mindId: a.mindId, nodeId: a.nodeId }])
      } else {
        data = await driver.bridgeCall('addMindNode', [
          { mindId: a.mindId, nodeId: a.nodeId, position: a.action === 'addSibling' ? 'sibling' : 'child', text: a.text, index: a.index }
        ])
      }
      break
    }
    case 'editor_mind_update': {
      if (args.content !== undefined && args.content !== null) {
        data = await driver.bridgeCall('setMindData', [{ mindId: args.mindId, content: args.content }])
      }
      if (args.template !== undefined) {
        data = await driver.bridgeCall('setMindTemplate', [{ mindId: args.mindId, template: args.template }])
      }
      if (args.theme !== undefined) {
        data = await driver.bridgeCall('setMindTheme', [{ mindId: args.mindId, theme: args.theme }])
      }
      if (data === undefined) data = null
      break
    }
    case 'editor_text_info':
      data = await driver.bridgeCall('getTextInfo', [getTextTargetSelector(args)])
      break
    case 'editor_text_set_content':
      data = await driver.bridgeCall('setTextContent', [
        {
          ...getTextTargetSelector(args),
          content: args.content,
          expectedContentHash: args.expectedContentHash,
          dryRun: args.dryRun,
          fitSize: args.fitSize,
          waitMs: args.waitMs
        }
      ])
      break
    case 'editor_text_adaptive':
      data = await driver.bridgeCall('setTextAdaptive', [
        {
          elementId: args.elementId,
          extendType: args.extendType,
          fitSize: args.fitSize,
          waitMs: args.waitMs
        }
      ])
      break
    case 'editor_text_fit':
      data = await driver.bridgeCall('fitTextSize', [{ elementId: args.elementId, waitMs: args.waitMs }])
      break
    case 'editor_text_document':
      data = await driver.bridgeCall('getTextDocument', [args])
      break
    case 'editor_text_set_style':
      data = await driver.bridgeCall('formatText', [
        {
          ...getTextTargetSelector(args),
          scope: 'default',
          formats: args.style,
          expectedContentHash: args.expectedContentHash,
          fitSize: args.fitSize,
          waitMs: args.waitMs
        }
      ])
      break
    case 'editor_text_edit':
      data = await driver.bridgeCall('editText', [args])
      break
    case 'editor_text_set_link':
      data = await driver.bridgeCall('setTextLink', [args])
      break
    case 'editor_text_remove_link':
      data = await driver.bridgeCall('removeTextLink', [args])
      break
    case 'editor_text_edit_embed':
      data = await driver.bridgeCall('editTextEmbed', [args])
      break
    case 'editor_text_format':
      data = await driver.bridgeCall('formatText', [args])
      break
    case 'editor_text_set_layout':
      data = await driver.bridgeCall('setTextLayout', [args])
      break
    case 'editor_text_inspect_layout':
      data = await driver.bridgeCall('inspectTextLayout', [args])
      break
    case 'editor_text_fit_to_box':
      data = await driver.bridgeCall('fitTextToBox', [
        {
          elementId: args.elementId,
          minFontSize: args.minFontSize,
          maxFontSize: args.maxFontSize,
          step: args.step,
          expectedContentHash: args.expectedContentHash,
          allowUniformizeMixedSizes: args.allowUniformizeMixedSizes,
          waitMs: args.waitMs
        }
      ])
      break
    case 'editor_text_search':
      data = await driver.bridgeCall('searchTextElements', [
        {
          ...args,
          targetKinds: args.targetKinds || TEXT_TARGET_KINDS
        }
      ])
      break
    case 'editor_text_copy_style':
      data = await driver.bridgeCall('copyTextStyle', [args])
      break
    case 'editor_text_fonts':
      data = await driver.bridgeCall('listTextFonts', [args])
      break
    case 'editor_outline_info':
      data = await driver.bridgeCall('getOutline', [args.slideId ? { slideId: args.slideId } : {}])
      break
    case 'editor_outline_refresh':
      data = await driver.bridgeCall('refreshOutline')
      break
    case 'editor_outline_add':
      data = await driver.bridgeCall('addOutline', [
        { parentId: args.parentId, sort: args.sort, name: args.name, slideId: args.slideId }
      ])
      break
    case 'editor_outline_rename':
      data = await driver.bridgeCall('renameOutline', [
        { outlineId: args.outlineId, name: args.name, slideId: args.slideId }
      ])
      break
    case 'editor_outline_delete':
      data = await driver.bridgeCall('deleteOutline', [
        { outlineId: args.outlineId, slideId: args.slideId }
      ])
      break
    case 'editor_outline_move':
      data = await driver.bridgeCall('moveOutline', [
        { outlineId: args.outlineId, parentId: args.parentId, sort: args.sort, slideId: args.slideId }
      ])
      break
    case 'editor_outline_link_blocks':
      data = await driver.bridgeCall('linkOutlineBlocks', [
        { outlineId: args.outlineId, blockIds: args.blockIds, slideId: args.slideId }
      ])
      break
    case 'editor_outline_select':
      data = await driver.bridgeCall('selectOutline', [args.outlineId])
      break
    case 'editor_outline_anchor_list':
      data = await driver.bridgeCall('getOutlineAnchors', [{ outlineId: args.outlineId }])
      break
    case 'editor_outline_anchor_add':
      data = await driver.bridgeCall('addOutlineAnchor', [
        {
          outlineId: args.outlineId,
          name: args.name,
          type: args.type,
          positionX: args.positionX,
          positionY: args.positionY,
          width: args.width,
          height: args.height,
          slideId: args.slideId
        }
      ])
      break
    case 'editor_outline_anchor_update':
      data = await driver.bridgeCall('updateOutlineAnchor', [args.anchor])
      break
    case 'editor_outline_anchor_delete':
      data = await driver.bridgeCall('deleteOutlineAnchor', [
        { outlineId: args.outlineId, anchorId: args.anchorId }
      ])
      break
    case 'editor_upload_image':
      data = await driver.uploadImage(args)
      break
    case 'editor_add_image_element':
      data = await driver.addImageElement(args)
      break
    case 'editor_set_image_src':
      data = await driver.setImageElementSrc(args)
      break
    case 'editor_batch':
      data = await driver.bridgeCall('batch', [{ steps: args.steps, stopOnError: args.stopOnError }])
      break
    case 'editor_rpc_call':
      data = await driver.bridgeCall(args.method, Array.isArray(args.args) ? args.args : [])
      break

    default:
      throw new McpError(-32601, 'Unknown tool: ' + name)
  }
  // 截图工具返回 MCP image 内容块，模型可直接看到图片（排版/视觉核对）
  if (name === 'editor_screenshot' && typeof data === 'string' && data.startsWith('data:image')) {
    return {
      content: [{ type: 'image', data: data.slice(data.indexOf(',') + 1), mimeType: 'image/png' }]
    }
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

// 同一 MCP 进程内串行执行工具，避免 connect/status/close 与写操作交错释放页面租约。
let toolCallTail = Promise.resolve()
const queuedToolCalls = new Map()

function enqueueToolCall(requestId, name, args) {
  if (queuedToolCalls.has(requestId)) {
    return Promise.reject(new McpError(-32600, 'Duplicate JSON-RPC request id: ' + requestId))
  }

  let rejectCancellation
  const entry = {
    cancelled: false,
    started: false,
    rejectCancellation: null
  }
  const cancellation = new Promise((resolve, reject) => {
    rejectCancellation = reject
  })
  entry.rejectCancellation = rejectCancellation
  queuedToolCalls.set(requestId, entry)

  const execution = toolCallTail.then(() => {
    if (entry.cancelled) {
      throw new McpError(-32800, 'Request cancelled before execution')
    }
    entry.started = true
    return callTool(name, args)
  })
  toolCallTail = execution.catch(() => {})

  return Promise.race([execution, cancellation]).finally(() => {
    if (queuedToolCalls.get(requestId) === entry) queuedToolCalls.delete(requestId)
  })
}

function cancelQueuedToolCall(requestId) {
  const entry = queuedToolCalls.get(requestId)
  if (!entry || entry.started || entry.cancelled) return false
  entry.cancelled = true
  entry.rejectCancellation(new McpError(-32800, 'Request cancelled before execution'))
  return true
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
      return enqueueToolCall(
        req.id,
        req.params && req.params.name,
        (req.params && req.params.arguments) || {}
      )
    default:
      throw new McpError(-32601, 'Method not found: ' + req.method)
  }
}

await driver.initialize()

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
  // JSON-RPC 请求 ID 可以是 0；没有 id 的 cancellation notification 只取消尚未开始的工具。
  if (!Object.prototype.hasOwnProperty.call(req, 'id')) {
    if (
      req.method === 'notifications/cancelled' &&
      req.params &&
      Object.prototype.hasOwnProperty.call(req.params, 'requestId')
    ) {
      cancelQueuedToolCall(req.params.requestId)
    }
    return
  }
  handleRequest(req).then(
    (result) => send({ jsonrpc: '2.0', id: req.id, result }),
    (err) => {
      if (err instanceof McpError) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message } })
      } else {
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  { errorCode: err.code || 'TOOL_ERROR', error: err.message || String(err) },
                  null,
                  2
                )
              }
            ],
            isError: true
          }
        })
      }
    }
  )
})

let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  const forceExitTimer = setTimeout(() => process.exit(1), 5000)
  driver.shutdown().then(
    () => {
      clearTimeout(forceExitTimer)
      process.exitCode = 0
    },
    (error) => {
      clearTimeout(forceExitTimer)
      console.error(error)
      process.exitCode = 1
    }
  )
}

rl.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('disconnect', shutdown)
