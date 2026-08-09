const ID_SCHEMA = { type: ['string', 'number'] }

const SCOPE_SCHEMA = {
  type: 'string',
  enum: ['current', 'book'],
  description: '读取/写入范围。默认 current，仅处理当前（或 slideId 指定的）目录；只有显式 book 才扫描整书'
}

const DETAIL_SCHEMA = {
  type: 'string',
  enum: ['summary', 'standard', 'deep'],
  description: '返回细节。默认 summary；deep 可能读取正文、嵌套文本和关联资源，必须显式指定'
}

const QUESTION_STYLE_REFERENCE_SCHEMA = {
  type: 'object',
  properties: {
    templateId: { ...ID_SCHEMA, description: '参考样章模板 id' },
    blockTemplateIds: {
      type: 'array',
      items: ID_SCHEMA,
      maxItems: 20,
      uniqueItems: true,
      description: '参考区块模板 id；只复用成熟结构与样式，不直接覆盖题目内容'
    },
    reuse: {
      type: 'boolean',
      description: '是否优先复用参考模板的结构和样式，默认 true'
    }
  },
  minProperties: 1,
  additionalProperties: false
}

const QUESTION_GUIDS_SCHEMA = {
  type: 'array',
  items: { type: 'string', minLength: 1 },
  minItems: 1,
  maxItems: 50,
  description: '题库题目 GUID；先通过题目搜索/详情工具取得，不使用数值 id'
}

const RENDER_QUESTION_GUIDS_SCHEMA = {
  ...QUESTION_GUIDS_SCHEMA,
  maxItems: 30,
  description: '本次要排版的题目 GUID，单次最多 30；更多题目应按区块分批渲染'
}

const BOOK_CONTENT_TARGET_KINDS = ['element', 'tableCell', 'mindNode']

export const BOOK_AUTHORING_TOOLS = [
  {
    name: 'editor_get_book_manifest',
    description:
      '读取课件结构清单。默认 scope=current、detail=summary，只返回当前目录的轻量摘要；整书理解必须显式 scope=book，正文/样式/关联资源等深读必须显式 detail=deep。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_SCHEMA,
        detail: DETAIL_SCHEMA,
        slideId: { ...ID_SCHEMA, description: 'scope=current 时可指定目录；省略为当前目录' },
        include: {
          type: 'object',
          properties: {
            hierarchy: { type: 'boolean', description: '是否返回完整层级目录树' },
            blocks: { type: 'boolean', description: '是否返回区块摘要' },
            textPreview: { type: 'boolean', description: '是否返回短文本预览' },
            content: { type: 'boolean', description: '是否返回较完整内容；可能显著增大响应' }
          },
          minProperties: 1,
          additionalProperties: false,
          description: '精确展开项；省略时由 detail 决定，避免简单请求读取无关数据'
        },
        pageNo: {
          type: 'integer',
          minimum: 0,
          description: 'scope=book 时的目录分页页码，从 0 开始，默认 0'
        },
        pageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'scope=book 时单次最多读取目录数，默认 40，上限 200'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_search_book_content',
    description:
      '搜索课件富文本内容。默认只搜索当前目录；只有显式 scope=book 才跨目录搜索，并可用 pageNo/pageSize 分页目录。可限定普通文本、表格单元格和思维导图节点，避免简单查询触发无关读取。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: '关键词或正则表达式' },
        scope: SCOPE_SCHEMA,
        slideId: { ...ID_SCHEMA, description: 'scope=current 时可指定目录；省略为当前目录' },
        pageNo: {
          type: 'integer',
          minimum: 0,
          description: 'scope=book 时的目录分页页码，从 0 开始'
        },
        pageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'scope=book 时单次搜索的目录数，上限 200'
        },
        targetKinds: {
          type: 'array',
          items: { type: 'string', enum: BOOK_CONTENT_TARGET_KINDS },
          minItems: 1,
          uniqueItems: true,
          description: '限定搜索内容类型；省略时使用桥接的轻量默认类型'
        },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
        wholeWord: { type: 'boolean', description: '是否按完整词匹配，默认 false' },
        useRegex: { type: 'boolean', description: '是否把 query 当正则，默认 false' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: '单次最多返回命中数，默认 100'
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_save_verified',
    description:
      '保存并回读校验。默认 scope=current 且 verify=true，只保存/核对当前目录；scope=book 仍只保存当前 dirty 页，再分页完成整书摘要校验，不会逐页切换并重写全书。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_SCHEMA,
        verify: { type: 'boolean', description: '是否保存后回读校验，默认 true' },
        expectedSlideId: {
          ...ID_SCHEMA,
          description: '并发保护：实际当前目录不一致时拒绝保存'
        },
        expectedContentHash: {
          type: 'string',
          minLength: 1,
          description: '并发保护：保存前当前页内容 hash 不一致时拒绝保存；不能使用文本 target hash 或审计 sourceHash'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_book_versions',
    description:
      '列出持久化版本。默认分页查询当前目录；scope=book 时 pageNo/pageSize 分页目录，versionPageNo/versionPageSize 再限制每个目录的版本，绝不默认一次扫描全书。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_SCHEMA,
        slideId: { ...ID_SCHEMA, description: '限定目录；scope=current 时省略为当前目录' },
        pageNo: { type: 'integer', minimum: 0, description: '页码，从 0 开始，默认 0' },
        pageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'current 时为版本页大小；book 时为目录页大小；默认 20'
        },
        versionPageNo: {
          type: 'integer',
          minimum: 0,
          description: 'scope=book 时每个目录的版本页码，从 0 开始，默认 0'
        },
        versionPageSize: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'scope=book 时每个目录最多返回的版本数，默认 20'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_book_version',
    description:
      '读取一个持久化版本。默认读取当前目录版本；整书版本必须显式 scope=book。',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { ...ID_SCHEMA, description: '版本记录 id' },
        scope: SCOPE_SCHEMA,
        slideId: { ...ID_SCHEMA, description: '版本所属目录 id；scope=current 时可省略' }
      },
      required: ['versionId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_restore_book_version',
    description:
      '恢复持久化版本。恢复前校验版本确实属于目标目录；整书恢复必须显式 scope=book 和 slideId。建议先 validateOnly=true，并用 expectedCurrentVersionId 防止并发覆盖。',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { ...ID_SCHEMA, description: '要恢复的版本记录 id' },
        scope: SCOPE_SCHEMA,
        slideId: {
          ...ID_SCHEMA,
          description: '要恢复的目录 id；scope=book 时必须显式提供'
        },
        validateOnly: { type: 'boolean', description: '只校验和预览影响范围，不实际恢复' },
        expectedCurrentVersionId: {
          ...ID_SCHEMA,
          description: '并发保护：当前版本不一致时拒绝恢复'
        }
      },
      required: ['versionId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_plan_question_lesson',
    description:
      '根据显式题目 GUID 规划课件编排，只读不写画布，也不会扫描整书。summary 只读题目详情，deep 才预检题目组件/数据。可记录样章/区块模板参考，实际复用应先把模板应用为目标区块。',
    inputSchema: {
      type: 'object',
      properties: {
        guids: QUESTION_GUIDS_SCHEMA,
        scope: SCOPE_SCHEMA,
        detail: {
          type: 'string',
          enum: ['summary', 'deep'],
          description: '默认 summary；deep 才读取完整题干、解析及更多课件上下文'
        },
        slideId: { ...ID_SCHEMA, description: 'scope=current 时可指定目标目录' },
        objective: { type: 'string', description: '本节教学目标或编排要求' },
        layout: {
          type: 'string',
          enum: ['auto', 'practice', 'explain', 'assessment'],
          description: '编排形态，默认 auto'
        },
        styleReference: QUESTION_STYLE_REFERENCE_SCHEMA
      },
      required: ['guids'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_render_questions_to_block',
    description:
      '把题库题目按计划排版到目标区块。默认 append 且只处理明确题目/计划；要复用模板风格，应先应用区块模板再把它作为 blockId。写入前可 validateOnly=true 预检，replace 会替换目标区块内容。',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'editor_plan_question_lesson 返回的计划对象' },
        guids: RENDER_QUESTION_GUIDS_SCHEMA,
        blockId: { type: 'string', minLength: 1, description: '目标区块 uuid；实际写入时建议明确提供' },
        slideId: { ...ID_SCHEMA, description: '目标目录；省略为当前目录' },
        afterBlockId: {
          type: 'string',
          minLength: 1,
          description: '新建题目区块时插到该区块之后；与 newBlockName 配合使用'
        },
        newBlockName: {
          type: 'string',
          minLength: 1,
          description: '没有明确 blockId 时创建的新题目区块名称'
        },
        questionGap: {
          type: 'number',
          minimum: 0,
          description: '题目组件之间的垂直间距'
        },
        startTop: {
          type: 'number',
          minimum: 0,
          description: '第一道题在区块中的起始 Y 坐标'
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description: 'append 追加（默认）；replace 替换目标区块现有内容'
        },
        styleReference: QUESTION_STYLE_REFERENCE_SCHEMA,
        validateOnly: { type: 'boolean', description: '只校验题目、目标和计划，不写画布' },
        expectedSlideId: {
          ...ID_SCHEMA,
          description: '并发保护：当前目录不一致时拒绝写入'
        }
      },
      anyOf: [{ required: ['plan'] }, { required: ['guids'] }],
      additionalProperties: false
    }
  },
  {
    name: 'editor_audit_content',
    description:
      '审计课件结构、文本、资源和布局。默认 scope=current，只检查当前目录；整书审计必须显式 scope=book，并通过 cursor/limit 分页，避免简单问题触发全书扫描。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: SCOPE_SCHEMA,
        slideId: { ...ID_SCHEMA, description: 'scope=current 时可指定目录；省略为当前目录' },
        slideIds: {
          type: 'array',
          items: ID_SCHEMA,
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          description: 'scope=book 时限定要审计的目录 id'
        },
        checks: {
          type: 'array',
          items: { type: 'string', enum: ['structure', 'text', 'resources', 'layout'] },
          minItems: 1,
          uniqueItems: true,
          description: '检查项；省略时使用轻量默认检查'
        },
        cursor: {
          type: 'integer',
          minimum: 0,
          description: 'scope=book 时继续下一批目录的非负整数偏移；使用上次返回的 nextCursor'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'scope=book 时单次最多审计目录数，默认 40'
        },
        includeSuggestions: {
          type: 'boolean',
          description: '是否返回修复建议，默认 false；本工具始终只读，不会自动修改'
        }
      },
      additionalProperties: false
    }
  }
]

const TOOL_TO_BRIDGE_METHOD = {
  editor_get_book_manifest: 'getBookManifest',
  editor_search_book_content: 'searchBookContent',
  editor_save_verified: 'saveVerified',
  editor_list_book_versions: 'listBookVersions',
  editor_get_book_version: 'getBookVersion',
  editor_restore_book_version: 'restoreBookVersion',
  editor_plan_question_lesson: 'planQuestionLesson',
  editor_render_questions_to_block: 'renderQuestionsToBlock',
  editor_audit_content: 'auditContent'
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function requireObject(args, toolName) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`${toolName} 参数必须是对象`)
  }
}

function requireId(value, field) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') {
    throw new Error(`${field} 必须是非空字符串或数字`)
  }
}

function normalizeScope(args) {
  const scope = args.scope || 'current'
  if (!['current', 'book'].includes(scope)) throw new Error('scope 取值: current / book')
  return scope
}

function normalizeDetail(args, allowed = ['summary', 'standard', 'deep']) {
  const detail = args.detail || 'summary'
  if (!allowed.includes(detail)) throw new Error(`detail 取值: ${allowed.join(' / ')}`)
  return detail
}

function validateRegex(args) {
  if (!args.useRegex) return
  try {
    new RegExp(args.query, args.caseSensitive ? '' : 'i')
  } catch (error) {
    throw new Error(`query 不是有效正则: ${error.message}`)
  }
}

function normalizeGuids(guids, maximum = 50) {
  if (!Array.isArray(guids) || !guids.length) throw new Error('guids 必须是非空数组')
  if (guids.length > maximum) throw new Error(`guids 最多 ${maximum} 项`)
  return guids.map((guid, index) => {
    if (typeof guid !== 'string' || !guid.trim()) throw new Error(`guids[${index}] 必须是非空字符串`)
    return guid.trim()
  })
}

function normalizeStyleReference(styleReference) {
  if (styleReference === undefined) return undefined
  if (!styleReference || typeof styleReference !== 'object' || Array.isArray(styleReference)) {
    throw new Error('styleReference 必须是对象')
  }
  const normalized = { ...styleReference }
  if (hasOwn(normalized, 'templateId')) requireId(normalized.templateId, 'styleReference.templateId')
  if (hasOwn(normalized, 'blockTemplateIds')) {
    if (!Array.isArray(normalized.blockTemplateIds) || !normalized.blockTemplateIds.length) {
      throw new Error('styleReference.blockTemplateIds 必须是非空数组')
    }
    if (normalized.blockTemplateIds.length > 20) {
      throw new Error('styleReference.blockTemplateIds 最多 20 项')
    }
    normalized.blockTemplateIds.forEach((id, index) =>
      requireId(id, `styleReference.blockTemplateIds[${index}]`)
    )
  }
  if (hasOwn(normalized, 'reuse') && typeof normalized.reuse !== 'boolean') {
    throw new Error('styleReference.reuse 必须是布尔值')
  }
  return normalized
}

function normalizeCommonScope(args, options = {}) {
  const normalized = { ...args, scope: normalizeScope(args) }
  if (options.detail !== false) normalized.detail = normalizeDetail(args, options.allowedDetails)
  if (hasOwn(args, 'slideId')) requireId(args.slideId, 'slideId')
  return normalized
}

function normalizePositiveInteger(value, field, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${field} 必须是 1-${maximum} 的整数`)
  }
}

export function prepareBookAuthoringCall(name, args = {}) {
  const method = TOOL_TO_BRIDGE_METHOD[name]
  if (!method) return null
  requireObject(args, name)

  let payload
  switch (name) {
    case 'editor_get_book_manifest':
      payload = normalizeCommonScope(args)
      if (hasOwn(args, 'include')) {
        if (!args.include || typeof args.include !== 'object' || Array.isArray(args.include)) {
          throw new Error('include 必须是对象')
        }
        const includeKeys = ['hierarchy', 'blocks', 'textPreview', 'content']
        const invalidKey = Object.keys(args.include).find((key) => !includeKeys.includes(key))
        if (invalidKey) throw new Error(`include 不支持字段: ${invalidKey}`)
        Object.entries(args.include).forEach(([key, value]) => {
          if (typeof value !== 'boolean') throw new Error(`include.${key} 必须是布尔值`)
        })
      }
      if (hasOwn(args, 'pageNo') && (!Number.isInteger(args.pageNo) || args.pageNo < 0)) {
        throw new Error('pageNo 必须是非负整数')
      }
      if (hasOwn(args, 'pageSize')) normalizePositiveInteger(args.pageSize, 'pageSize', 200)
      if (
        payload.scope === 'current' &&
        (hasOwn(args, 'pageNo') || hasOwn(args, 'pageSize'))
      ) {
        throw new Error('pageNo/pageSize 仅用于 scope=book')
      }
      break
    case 'editor_search_book_content':
      if (typeof args.query !== 'string' || !args.query.trim()) {
        throw new Error('query 必须是非空字符串')
      }
      payload = normalizeCommonScope(
        { ...args, query: args.query.trim() },
        { detail: false }
      )
      if (hasOwn(args, 'limit')) normalizePositiveInteger(args.limit, 'limit', 500)
      if (hasOwn(args, 'pageNo') && (!Number.isInteger(args.pageNo) || args.pageNo < 0)) {
        throw new Error('pageNo 必须是非负整数')
      }
      if (hasOwn(args, 'pageSize')) normalizePositiveInteger(args.pageSize, 'pageSize', 200)
      if (
        payload.scope === 'current' &&
        (hasOwn(args, 'pageNo') || hasOwn(args, 'pageSize'))
      ) {
        throw new Error('pageNo/pageSize 仅用于 scope=book')
      }
      if (hasOwn(args, 'targetKinds')) {
        if (!Array.isArray(args.targetKinds) || !args.targetKinds.length) {
          throw new Error('targetKinds 必须是非空数组')
        }
        const invalid = args.targetKinds.find((kind) => !BOOK_CONTENT_TARGET_KINDS.includes(kind))
        if (invalid) throw new Error(`targetKinds 不支持: ${invalid}`)
      }
      validateRegex(payload)
      break
    case 'editor_save_verified':
      payload = normalizeCommonScope(args, { detail: false })
      payload.verify = args.verify !== false
      if (hasOwn(args, 'expectedSlideId')) requireId(args.expectedSlideId, 'expectedSlideId')
      if (
        hasOwn(args, 'expectedContentHash') &&
        (typeof args.expectedContentHash !== 'string' || !args.expectedContentHash.trim())
      ) {
        throw new Error('expectedContentHash 必须是非空字符串')
      }
      break
    case 'editor_list_book_versions':
      payload = normalizeCommonScope(args, { detail: false, allowBookSlideId: true })
      if (hasOwn(args, 'pageNo') && (!Number.isInteger(args.pageNo) || args.pageNo < 0)) {
        throw new Error('pageNo 必须是非负整数')
      }
      if (hasOwn(args, 'pageSize')) normalizePositiveInteger(args.pageSize, 'pageSize', 100)
      if (
        hasOwn(args, 'versionPageNo') &&
        (!Number.isInteger(args.versionPageNo) || args.versionPageNo < 0)
      ) {
        throw new Error('versionPageNo 必须是非负整数')
      }
      if (hasOwn(args, 'versionPageSize')) {
        normalizePositiveInteger(args.versionPageSize, 'versionPageSize', 100)
      }
      break
    case 'editor_get_book_version':
      requireId(args.versionId, 'versionId')
      payload = normalizeCommonScope(args, { detail: false, allowBookSlideId: true })
      break
    case 'editor_restore_book_version':
      requireId(args.versionId, 'versionId')
      payload = normalizeCommonScope(args, { detail: false, allowBookSlideId: true })
      if (payload.scope === 'book' && !hasOwn(args, 'slideId')) {
        throw new Error('scope=book 恢复目录版本时必须提供 slideId')
      }
      if (hasOwn(args, 'expectedCurrentVersionId')) {
        requireId(args.expectedCurrentVersionId, 'expectedCurrentVersionId')
      }
      break
    case 'editor_plan_question_lesson':
      payload = normalizeCommonScope(args, {
        allowedDetails: ['summary', 'deep']
      })
      payload.guids = normalizeGuids(args.guids)
      payload.layout = args.layout || 'auto'
      if (!['auto', 'practice', 'explain', 'assessment'].includes(payload.layout)) {
        throw new Error('layout 取值: auto / practice / explain / assessment')
      }
      if (hasOwn(args, 'styleReference')) {
        payload.styleReference = normalizeStyleReference(args.styleReference)
      }
      break
    case 'editor_render_questions_to_block':
      if (!hasOwn(args, 'plan') && !hasOwn(args, 'guids')) {
        throw new Error('必须提供 plan 或 guids')
      }
      if (hasOwn(args, 'plan') && (!args.plan || typeof args.plan !== 'object' || Array.isArray(args.plan))) {
        throw new Error('plan 必须是对象')
      }
      payload = { ...args, mode: args.mode || 'append' }
      if (!['append', 'replace'].includes(payload.mode)) {
        throw new Error('mode 取值: append / replace')
      }
      if (hasOwn(args, 'guids')) payload.guids = normalizeGuids(args.guids, 30)
      if (hasOwn(args, 'plan')) {
        const planGuids = Array.isArray(args.plan.orderedGuids)
          ? args.plan.orderedGuids
          : Array.isArray(args.plan.guids)
            ? args.plan.guids
            : null
        if (planGuids && planGuids.length > 30) {
          throw new Error('plan 单次最多渲染 30 道题目；请按区块分批渲染')
        }
      }
      if (hasOwn(args, 'blockId') && (typeof args.blockId !== 'string' || !args.blockId.trim())) {
        throw new Error('blockId 必须是非空字符串')
      }
      for (const field of ['afterBlockId', 'newBlockName']) {
        if (hasOwn(args, field) && (typeof args[field] !== 'string' || !args[field].trim())) {
          throw new Error(`${field} 必须是非空字符串`)
        }
      }
      for (const field of ['questionGap', 'startTop']) {
        if (hasOwn(args, field) && (typeof args[field] !== 'number' || args[field] < 0)) {
          throw new Error(`${field} 必须是非负数字`)
        }
      }
      if (hasOwn(args, 'slideId')) requireId(args.slideId, 'slideId')
      if (hasOwn(args, 'expectedSlideId')) requireId(args.expectedSlideId, 'expectedSlideId')
      if (hasOwn(args, 'styleReference')) {
        payload.styleReference = normalizeStyleReference(args.styleReference)
      }
      break
    case 'editor_audit_content':
      payload = normalizeCommonScope(args, { detail: false })
      if (hasOwn(args, 'slideIds')) {
        if (!Array.isArray(args.slideIds) || !args.slideIds.length || args.slideIds.length > 100) {
          throw new Error('slideIds 必须是 1-100 项的非空数组')
        }
        args.slideIds.forEach((id, index) => requireId(id, `slideIds[${index}]`))
      }
      if (payload.scope === 'current' && (hasOwn(args, 'slideIds') || hasOwn(args, 'cursor'))) {
        throw new Error('slideIds/cursor 仅用于 scope=book')
      }
      if (hasOwn(args, 'cursor') && (!Number.isInteger(args.cursor) || args.cursor < 0)) {
        throw new Error('cursor 必须是非负整数')
      }
      if (hasOwn(args, 'limit')) normalizePositiveInteger(args.limit, 'limit', 100)
      break
    default:
      return null
  }

  return { method, args: [payload] }
}
