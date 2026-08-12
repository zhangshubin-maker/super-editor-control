import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SNAPSHOT_SCHEMA_VERSION = '1.0'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const DEFAULT_SNAPSHOT_ROOT = join(tmpdir(), 'super-editor-control')
const REQUIRED_COMPLETENESS_SECTIONS = [
  'blocks',
  'elementIndex',
  'outline',
  'outlineAnchors',
  'digitalModules',
  'digitalModulesRaw',
  'richText',
  'fonts',
  'contentReady'
]

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const isPlainObject = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const canonicalize = (value, options = {}) => {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item, options)))
  }
  if (!isPlainObject(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    return value
  }
  const result = {}
  for (const key of Object.keys(value).sort()) {
    if (options.omitVolatile && ['capturedAt', 'stableHash'].includes(key)) continue
    const item = value[key]
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
    result[key] = canonicalize(item, options)
  }
  return result
}

const safeFilePart = (value, fallback) => {
  const normalized = String(value == null ? '' : value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

const invalid = (message, code = 'SEMANTIC_SNAPSHOT_INVALID') => {
  const error = new Error(message)
  error.code = code
  throw error
}

const requireObject = (value, field) => {
  if (!isPlainObject(value)) invalid(`semantic snapshot.${field} 必须是对象`)
}

const requireArray = (value, field) => {
  if (!Array.isArray(value)) invalid(`semantic snapshot.${field} 必须是数组`)
}

const requireId = (value, field) => {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') {
    invalid(`semantic snapshot.${field} 必须是非空字符串或数字`)
  }
}

const requireString = (value, field) => {
  if (typeof value !== 'string' || !value.trim()) {
    invalid(`semantic snapshot.${field} 必须是非空字符串`)
  }
}

const requireFiniteGeometry = (geometry, field) => {
  requireObject(geometry, field)
  for (const key of ['left', 'top', 'width', 'height']) {
    if (typeof geometry[key] !== 'number' || !Number.isFinite(geometry[key])) {
      invalid(`semantic snapshot.${field}.${key} 必须是有限数字`)
    }
  }
  if (
    geometry.rotate !== undefined &&
    (typeof geometry.rotate !== 'number' || !Number.isFinite(geometry.rotate))
  ) {
    invalid(`semantic snapshot.${field}.rotate 必须是有限数字`)
  }
}

const validateElementIndex = (items, required) => {
  items.forEach((item, index) => {
    const field = `snapshot.elementIndex[${index}]`
    requireObject(item, field)
    if (!required) return
    requireId(item.elementId, `${field}.elementId`)
    requireString(item.type, `${field}.type`)
    requireId(item.blockId, `${field}.blockId`)
    requireArray(item.path, `${field}.path`)
    requireArray(item.groupPath, `${field}.groupPath`)
    requireFiniteGeometry(item.geometry, `${field}.geometry`)
  })
}

const validateDigitalModules = (digitalModules, sections) => {
  digitalModules.items.forEach((item, index) => {
    const field = `snapshot.digitalModules.items[${index}]`
    requireObject(item, field)
    if (sections.digitalModules) {
      requireId(item.elementId, `${field}.elementId`)
      requireId(item.blockId, `${field}.blockId`)
    }
    if (sections.digitalModules) requireObject(item.normalized, `${field}.normalized`)
    if (sections.digitalModulesRaw) requireObject(item.raw, `${field}.raw`)
  })
}

const validateRichText = (richText, sectionComplete) => {
  richText.items.forEach((item, index) => {
    const field = `snapshot.richText.items[${index}]`
    requireObject(item, field)
    if (!sectionComplete) return
    requireObject(item.target, `${field}.target`)
    if (richText.detail === 'deep') {
      if (typeof item.canonicalHtml !== 'string') {
        invalid(`semantic snapshot.${field}.canonicalHtml 必须是字符串`)
      }
      requireArray(item.runs, `${field}.runs`)
      requireArray(item.paragraphs, `${field}.paragraphs`)
    }
  })
}

const validateCompleteness = (snapshot) => {
  const completeness = snapshot.completeness
  const { sections, warnings } = completeness
  for (const section of REQUIRED_COMPLETENESS_SECTIONS) {
    if (typeof sections[section] !== 'boolean') {
      invalid(`semantic snapshot.snapshot.completeness.sections.${section} 必须是布尔值`)
    }
  }
  warnings.forEach((warning, index) => {
    requireObject(warning, `snapshot.completeness.warnings[${index}]`)
    requireString(warning.code, `snapshot.completeness.warnings[${index}].code`)
    requireString(warning.message, `snapshot.completeness.warnings[${index}].message`)
  })
  if (completeness.complete) {
    const incomplete = REQUIRED_COMPLETENESS_SECTIONS.filter((section) => sections[section] !== true)
    if (incomplete.length) {
      invalid(`semantic snapshot 完整快照仍有未完成分节: ${incomplete.join(', ')}`)
    }
    if (warnings.length) invalid('semantic snapshot 完整快照的 warnings 必须为空')
    if (snapshot.state.contentReady !== true) {
      invalid('semantic snapshot 完整快照必须满足 state.contentReady=true')
    }
  } else {
    if (!REQUIRED_COMPLETENESS_SECTIONS.some((section) => sections[section] === false)) {
      invalid('semantic snapshot 非完整快照至少要有一个 completeness section=false')
    }
    if (!warnings.length) invalid('semantic snapshot 非完整快照必须说明 warnings')
  }
}

export function calculateSemanticSnapshotStableHash(payload) {
  requireObject(payload, 'envelope')
  const authoritativeContent = canonicalize(
    {
      schemaVersion: payload.schemaVersion,
      snapshot: payload.snapshot,
      meta: payload.meta
    },
    { omitVolatile: true }
  )
  return `sha256:${sha256(JSON.stringify(authoritativeContent))}`
}

export function validateSemanticSnapshotEnvelope(payload) {
  requireObject(payload, 'envelope')
  if (payload.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    invalid(
      `semantic snapshot.schemaVersion 必须是 ${SNAPSHOT_SCHEMA_VERSION}，实际为 ${String(payload.schemaVersion)}`
    )
  }
  requireObject(payload.snapshot, 'snapshot')
  const snapshot = payload.snapshot
  requireObject(snapshot.identity, 'snapshot.identity')
  requireId(snapshot.identity.bookId, 'snapshot.identity.bookId')
  requireId(snapshot.identity.catalogId, 'snapshot.identity.catalogId')
  if (typeof snapshot.identity.targetIsCurrent !== 'boolean') {
    invalid('semantic snapshot.snapshot.identity.targetIsCurrent 必须是布尔值')
  }

  requireObject(snapshot.state, 'snapshot.state')
  if (!['working', 'persisted'].includes(snapshot.state.source)) {
    invalid('semantic snapshot.snapshot.state.source 取值必须为 working / persisted')
  }
  if (typeof snapshot.state.dirty !== 'boolean') {
    invalid('semantic snapshot.snapshot.state.dirty 必须是布尔值')
  }
  if (typeof snapshot.state.contentReady !== 'boolean') {
    invalid('semantic snapshot.snapshot.state.contentReady 必须是布尔值')
  }
  requireId(snapshot.state.capturedBookId, 'snapshot.state.capturedBookId')
  if (String(snapshot.state.capturedBookId) !== String(snapshot.identity.bookId)) {
    invalid('semantic snapshot 捕获书本与 identity.bookId 不一致')
  }

  requireObject(snapshot.slide, 'snapshot.slide')
  requireId(snapshot.slide.id, 'snapshot.slide.id')
  if (String(snapshot.slide.id) !== String(snapshot.identity.catalogId)) {
    invalid('semantic snapshot slide.id 与 identity.catalogId 不一致')
  }
  requireArray(snapshot.blocks, 'snapshot.blocks')
  requireArray(snapshot.elementIndex, 'snapshot.elementIndex')
  requireObject(snapshot.outline, 'snapshot.outline')
  requireObject(snapshot.digitalModules, 'snapshot.digitalModules')
  requireArray(snapshot.digitalModules.items, 'snapshot.digitalModules.items')
  if (snapshot.digitalModules.includeRaw !== true) {
    invalid('semantic snapshot.snapshot.digitalModules.includeRaw 必须为 true')
  }
  requireObject(snapshot.richText, 'snapshot.richText')
  if (!['none', 'summary', 'deep'].includes(snapshot.richText.detail)) {
    invalid('semantic snapshot.snapshot.richText.detail 取值必须为 none / summary / deep')
  }
  requireArray(snapshot.richText.items, 'snapshot.richText.items')
  requireObject(snapshot.fonts, 'snapshot.fonts')
  requireArray(snapshot.fonts.items, 'snapshot.fonts.items')
  requireObject(snapshot.completeness, 'snapshot.completeness')
  if (typeof snapshot.completeness.complete !== 'boolean') {
    invalid('semantic snapshot.snapshot.completeness.complete 必须是布尔值')
  }
  requireObject(snapshot.completeness.sections, 'snapshot.completeness.sections')
  requireArray(snapshot.completeness.warnings, 'snapshot.completeness.warnings')
  requireObject(payload.meta, 'meta')

  validateCompleteness(snapshot)
  const sections = snapshot.completeness.sections
  snapshot.blocks.forEach((block, index) => {
    requireObject(block, `snapshot.blocks[${index}]`)
    if (sections.blocks && Number(block.template_type) === 2) {
      requireId(block.uuid, `snapshot.blocks[${index}].uuid`)
      requireObject(
        block.template_data_content,
        `snapshot.blocks[${index}].template_data_content`
      )
      requireArray(
        block.template_data_content.elements,
        `snapshot.blocks[${index}].template_data_content.elements`
      )
    }
  })
  validateElementIndex(snapshot.elementIndex, sections.elementIndex)
  if (sections.outline) {
    const outlineTree = Array.isArray(snapshot.outline.tree)
      ? snapshot.outline.tree
      : snapshot.outline.outline
    requireArray(outlineTree, 'snapshot.outline.tree')
  }
  if (sections.outlineAnchors) {
    requireArray(snapshot.outline.anchors, 'snapshot.outline.anchors')
  }
  validateDigitalModules(snapshot.digitalModules, sections)
  validateRichText(snapshot.richText, sections.richText)
  if (sections.fonts) requireString(snapshot.fonts.source, 'snapshot.fonts.source')

  if (!/^sha256:[a-f0-9]{64}$/.test(payload.stableHash || '')) {
    invalid('semantic snapshot.stableHash 必须是 sha256:<64位小写十六进制>')
  }
  const calculatedStableHash = calculateSemanticSnapshotStableHash(payload)
  if (payload.stableHash !== calculatedStableHash) {
    invalid(
      `semantic snapshot Bridge stableHash 校验失败: expected ${calculatedStableHash}, received ${payload.stableHash}`,
      'SEMANTIC_SNAPSHOT_HASH_MISMATCH'
    )
  }
  return payload
}

export function isFullFidelitySemanticSnapshot(payload) {
  validateSemanticSnapshotEnvelope(payload)
  return payload.snapshot.completeness.complete === true && payload.snapshot.richText.detail === 'deep'
}

const collectBridgeErrorCodes = (error) => {
  const values = [
    error && error.code,
    error && error.errorCode,
    error && error.payload && error.payload.code,
    error && error.payload && error.payload.errorCode,
    error && error.data && error.data.code,
    error && error.data && error.data.errorCode
  ]
  return values.filter((value) => value !== undefined && value !== null).map(String)
}

const collectBridgeErrorText = (error) =>
  [
    error && error.message,
    error && error.error,
    error && error.payload && error.payload.message,
    error && error.payload && error.payload.error,
    error && error.data && error.data.message,
    error && error.data && error.data.error
  ]
    .filter(Boolean)
    .join(' | ')

export function normalizeSemanticSnapshotBridgeError(error) {
  const codes = collectBridgeErrorCodes(error)
  const text = collectBridgeErrorText(error)
  const explicitMethodMissing = codes.some((code) =>
    ['METHOD_NOT_FOUND', '-32601'].includes(code.toUpperCase())
  )
  const genericRpcMissing =
    codes.some((code) => ['RPC_ERROR', 'PAGE_ERROR'].includes(code.toUpperCase())) &&
    /getSemanticSnapshot/.test(text) &&
    /(不存在|不支持|not found|not a function|unknown method)/i.test(text)
  if (!explicitMethodMissing && !genericRpcMissing) return error
  const unsupported = new Error(
    '当前页面 Bridge 不支持 getSemanticSnapshot；请升级到 v1.10.0+ 后重新连接'
  )
  unsupported.code = 'SEMANTIC_SNAPSHOT_UNSUPPORTED'
  return unsupported
}

const ensurePrivateDirectory = (path) => {
  try {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) invalid(`semantic snapshot 输出目录不能是符号链接: ${path}`)
  if (!stat.isDirectory()) invalid(`semantic snapshot 输出路径不是目录: ${path}`)
  chmodSync(path, PRIVATE_DIRECTORY_MODE)
}

const inspectRegularFile = (path) => {
  if (!existsSync(path)) return null
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) invalid(`semantic snapshot 文件不能是符号链接: ${path}`)
  if (!stat.isFile()) invalid(`semantic snapshot 输出目标不是普通文件: ${path}`)
  return stat
}

const fileHasHash = (path, expectedHash) => {
  try {
    inspectRegularFile(path)
    return existsSync(path) && sha256(readFileSync(path)) === expectedHash
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

const removeExistingRegularFile = (path) => {
  if (!existsSync(path)) return
  inspectRegularFile(path)
  try {
    unlinkSync(path)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

const writeContentAddressedFile = (path, text, expectedHash) => {
  ensurePrivateDirectory(dirname(path))
  if (existsSync(path) && fileHasHash(path, expectedHash)) {
    chmodSync(path, PRIVATE_FILE_MODE)
    return
  }
  removeExistingRegularFile(path)

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, text, {
    encoding: 'utf8',
    flag: 'wx',
    mode: PRIVATE_FILE_MODE
  })
  try {
    try {
      renameSync(temporaryPath, path)
    } catch (error) {
      // Windows 不允许 rename 覆盖竞态胜者；同内容文件已落盘即视为成功。
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || !fileHasHash(path, expectedHash)) {
        throw error
      }
    }
    if (!fileHasHash(path, expectedHash)) {
      invalid(`semantic snapshot 本机文件校验失败: ${path}`)
    }
    chmodSync(path, PRIVATE_FILE_MODE)
  } finally {
    try {
      if (existsSync(temporaryPath)) {
        inspectRegularFile(temporaryPath)
        unlinkSync(temporaryPath)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

/**
 * 将 Bridge 的完整只读快照 envelope 按内容寻址写入受控目录。
 * outputDirectory 仅供单元测试注入；MCP 工具不向调用方开放任意落盘路径。
 */
export function persistSemanticSnapshot(payload, options = {}) {
  validateSemanticSnapshotEnvelope(payload)
  const canonicalPayload = canonicalize(payload)
  const text = JSON.stringify(canonicalPayload, null, 2) + '\n'
  const fileHash = sha256(text)
  const identity = payload.snapshot.identity
  if (!options.outputDirectory) ensurePrivateDirectory(DEFAULT_SNAPSHOT_ROOT)
  const outputDirectory = resolve(
    options.outputDirectory || join(DEFAULT_SNAPSHOT_ROOT, 'semantic-snapshots')
  )
  ensurePrivateDirectory(outputDirectory)
  const bookPart = safeFilePart(identity.bookId, 'book')
  const catalogPart = safeFilePart(identity.catalogId, 'catalog')
  const snapshotPath = join(
    outputDirectory,
    `${bookPart}-${catalogPart}-${fileHash}.json`
  )
  writeContentAddressedFile(snapshotPath, text, fileHash)

  return {
    snapshotPath,
    snapshotFileSha256: `sha256:${fileHash}`,
    snapshotStableHash: payload.stableHash,
    snapshotStableHashAuthority: 'bridge:getSemanticSnapshot/v1',
    snapshotStableHashVerified: true,
    sizeBytes: Buffer.byteLength(text),
    schemaVersion: payload.schemaVersion,
    identity,
    state: payload.snapshot.state,
    completeness: payload.snapshot.completeness,
    fullFidelity: isFullFidelitySemanticSnapshot(payload),
    meta: payload.meta
  }
}
