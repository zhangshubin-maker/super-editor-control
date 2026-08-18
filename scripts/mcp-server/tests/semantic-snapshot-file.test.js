import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  calculateSemanticSnapshotStableHash,
  normalizeSemanticSnapshotBridgeError,
  persistSemanticSnapshot,
  validateSemanticSnapshotEnvelope
} from '../semanticSnapshotFile.js'

const PERSIST_WORKER_PATH = fileURLToPath(
  new URL('./fixtures/persist-semantic-snapshot-worker.js', import.meta.url)
)

const runPersistWorker = (payloadPath, outputDirectory) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PERSIST_WORKER_PATH, payloadPath, outputDirectory], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`semantic snapshot worker 退出 ${code}: ${stderr}`))
        return
      }
      resolve(JSON.parse(stdout))
    })
  })

const createPayload = () => {
  const payload = {
    schemaVersion: '1.0',
    snapshot: {
    identity: {
      bookId: 100,
      bookInfo: { name: '三年级语文上册' },
      catalogId: 200,
      catalogName: '第一课',
      catalogSort: 1,
      currentSlideId: 200,
      contextEpoch: 3,
      targetIsCurrent: true
    },
    state: {
      source: 'working',
      dirty: true,
      contentReady: true,
      capturedBookId: 100,
      contextEpoch: 3
    },
    slide: { id: 200, name: '第一课', sort: 1 },
    blocks: [
      {
        id: 301,
        uuid: 'block-1',
        template_type: 2,
        template_data_content: {
          name: '知识讲解',
          elements: [{ id: 'text-1', type: 'text', content: '<p>示例文本</p>' }]
        }
      }
    ],
    elementIndex: [
      {
        elementId: 'text-1',
        type: 'text',
        blockId: 'block-1',
        path: [0],
        groupPath: [],
        geometry: { left: 10, top: 20, width: 200, height: 50, rotate: 0 }
      }
    ],
    outline: { tree: [], selectedOutlineId: null, anchors: [] },
    digitalModules: {
      includeRaw: true,
      items: [
        {
          elementId: 'button-1',
          blockId: 'block-1',
          normalized: { modelId: 991, type: 84, name: '打印' },
          raw: { model_id: 991 }
        }
      ]
    },
    richText: {
      detail: 'deep',
      items: [
        {
          target: { kind: 'element', elementId: 'text-1' },
          canonicalHtml: '<p>示例文本</p>',
          runs: [{ start: 0, length: 4, formats: { bold: true } }],
          paragraphs: [{ index: 0, start: 0, length: 4, text: '示例文本' }]
        }
      ]
    },
    fonts: { source: 'current-editor', items: ['思源黑体 CN'] },
    completeness: {
      complete: true,
      sections: {
        blocks: true,
        elementIndex: true,
        outline: true,
        outlineAnchors: true,
        digitalModules: true,
        digitalModulesRaw: true,
        richText: true,
        fonts: true,
        contentReady: true
      },
      warnings: []
    }
  },
  meta: {
    blockCount: 1,
    elementCount: 1,
    digitalModuleCount: 1,
    richTextTargetCount: 1
  },
    stableHash: ''
  }
  payload.stableHash = calculateSemanticSnapshotStableHash(payload)
  return payload
}

test('semantic snapshot 使用规范 JSON 生成稳定路径并完整保存 envelope', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'semantic-snapshot-test-'))
  const payload = createPayload()
  const first = persistSemanticSnapshot(payload, { outputDirectory })
  const reordered = {
    stableHash: payload.stableHash,
    meta: payload.meta,
    snapshot: payload.snapshot,
    schemaVersion: payload.schemaVersion
  }
  const second = persistSemanticSnapshot(reordered, { outputDirectory })

  assert.equal(first.snapshotPath, second.snapshotPath)
  assert.match(first.snapshotFileSha256, /^sha256:[a-f0-9]{64}$/)
  assert.equal(first.snapshotStableHash, payload.stableHash)
  assert.equal(first.snapshotStableHashAuthority, 'bridge:getSemanticSnapshot/v1')
  assert.equal(first.snapshotStableHashVerified, true)
  assert.equal(first.identity.catalogId, 200)
  assert.equal(first.state.source, 'working')
  assert.equal(first.completeness.complete, true)
  assert.equal(first.fullFidelity, true)
  assert.deepEqual(JSON.parse(readFileSync(first.snapshotPath, 'utf8')), payload)

  writeFileSync(first.snapshotPath, '{"truncated":', 'utf8')
  const repaired = persistSemanticSnapshot(payload, { outputDirectory })
  assert.equal(repaired.snapshotPath, first.snapshotPath)
  assert.deepEqual(JSON.parse(readFileSync(repaired.snapshotPath, 'utf8')), payload)
})

test('semantic snapshot 缺少完整结构或 raw 数字模块时拒绝落盘', () => {
  const payload = createPayload()
  assert.throws(
    () => validateSemanticSnapshotEnvelope({ schemaVersion: '1.0', snapshot: {}, meta: {} }),
    /snapshot.identity/
  )
  assert.throws(
    () =>
      persistSemanticSnapshot({
        ...payload,
        snapshot: {
          ...payload.snapshot,
          digitalModules: { items: [], includeRaw: false }
        }
      }),
    /includeRaw 必须为 true/
  )
  assert.throws(() => persistSemanticSnapshot({ ...payload, stableHash: 'sha256:not-a-hash' }), /stableHash/)
  assert.throws(
    () =>
      persistSemanticSnapshot({
        ...payload,
        snapshot: {
          ...payload.snapshot,
          identity: { ...payload.snapshot.identity, catalogId: '' }
        }
      }),
    /identity.catalogId/
  )
  assert.throws(
    () =>
      persistSemanticSnapshot({
        ...payload,
        snapshot: { ...payload.snapshot, fonts: undefined }
      }),
    /snapshot.fonts/
  )
})

test('不完整快照会保留诊断落盘但明确 fullFidelity=false', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'semantic-snapshot-incomplete-test-'))
  const payload = createPayload()
  payload.snapshot.completeness.complete = false
  payload.snapshot.completeness.sections.richText = false
  payload.snapshot.completeness.warnings = [
    { code: 'RICH_TEXT_PARTIAL', section: 'richText', message: '一个目标读取失败' }
  ]
  payload.stableHash = calculateSemanticSnapshotStableHash(payload)
  const result = persistSemanticSnapshot(payload, { outputDirectory })
  assert.equal(result.fullFidelity, false)
  assert.equal(result.completeness.complete, false)
  assert.equal(result.completeness.warnings[0].code, 'RICH_TEXT_PARTIAL')
})

test('书级字体清单为空时保留诊断但不阻塞完整语义快照', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'semantic-snapshot-empty-fonts-test-'))
  const payload = createPayload()
  payload.snapshot.fonts = { source: 'book-store-empty', items: [] }
  payload.snapshot.completeness.complete = false
  payload.snapshot.completeness.sections.fonts = false
  payload.snapshot.completeness.warnings = [
    {
      code: 'FONT_MAPPING_EMPTY',
      section: 'fonts',
      message: '当前书本字体映射为空；未猜测可用字体'
    }
  ]
  payload.stableHash = calculateSemanticSnapshotStableHash(payload)

  const result = persistSemanticSnapshot(payload, { outputDirectory })

  assert.equal(result.fullFidelity, true)
  assert.equal(result.completeness.complete, false)
  assert.equal(result.completeness.sections.fonts, false)
  assert.equal(result.completeness.warnings[0].code, 'FONT_MAPPING_EMPTY')
})

test('字体清单为空并伴随其他缺项时仍阻塞完整语义快照', () => {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'semantic-snapshot-fonts-plus-gap-test-'))
  const payload = createPayload()
  payload.snapshot.fonts = { source: 'book-store-empty', items: [] }
  payload.snapshot.completeness.complete = false
  payload.snapshot.completeness.sections.fonts = false
  payload.snapshot.completeness.sections.richText = false
  payload.snapshot.completeness.warnings = [
    {
      code: 'FONT_MAPPING_EMPTY',
      section: 'fonts',
      message: '当前书本字体映射为空；未猜测可用字体'
    },
    { code: 'RICH_TEXT_PARTIAL', section: 'richText', message: '一个目标读取失败' }
  ]
  payload.stableHash = calculateSemanticSnapshotStableHash(payload)

  const result = persistSemanticSnapshot(payload, { outputDirectory })

  assert.equal(result.fullFidelity, false)
})

test('complete=true 会深校验定位、raw 模块、deep 文本与分节一致性', () => {
  const cases = [
    ['定位路径', (payload) => delete payload.snapshot.elementIndex[0].path, /elementIndex\[0\]\.path/],
    ['raw 模块', (payload) => delete payload.snapshot.digitalModules.items[0].raw, /\.raw 必须是对象/],
    ['deep runs', (payload) => delete payload.snapshot.richText.items[0].runs, /\.runs 必须是数组/],
    ['分节布尔值', (payload) => { payload.snapshot.completeness.sections.fonts = 'full' }, /sections\.fonts 必须是布尔值/],
    ['完整快照 warning', (payload) => { payload.snapshot.completeness.warnings = [{ code: 'X', message: '错误' }] }, /warnings 必须为空/]
  ]
  for (const [name, mutate, expected] of cases) {
    const payload = createPayload()
    mutate(payload)
    payload.stableHash = calculateSemanticSnapshotStableHash(payload)
    assert.throws(() => validateSemanticSnapshotEnvelope(payload), expected, name)
  }
})

test('Bridge stableHash 由 MCP 按权威内容重算且忽略 capturedAt', () => {
  const payload = createPayload()
  payload.snapshot.state.capturedAt = '2026-08-12T10:00:00.000Z'
  const first = calculateSemanticSnapshotStableHash(payload)
  payload.snapshot.state.capturedAt = '2026-08-12T11:00:00.000Z'
  const second = calculateSemanticSnapshotStableHash(payload)
  assert.equal(first, second)
  payload.stableHash = first
  validateSemanticSnapshotEnvelope(payload)

  payload.snapshot.slide.name = '被篡改'
  assert.throws(() => validateSemanticSnapshotEnvelope(payload), /stableHash 校验失败/)
})

test('只把明确方法不存在错误映射为 SEMANTIC_SNAPSHOT_UNSUPPORTED', () => {
  for (const error of [
    Object.assign(new Error('unknown'), { code: 'METHOD_NOT_FOUND' }),
    Object.assign(new Error('unknown'), { code: -32601 }),
    Object.assign(new Error('__superEditor.getSemanticSnapshot 不存在'), { code: 'RPC_ERROR' }),
    { code: 'RPC_ERROR', payload: { error: 'unknown method getSemanticSnapshot' } },
    { code: 'PAGE_ERROR', data: { error: 'getSemanticSnapshot not a function' } }
  ]) {
    assert.equal(normalizeSemanticSnapshotBridgeError(error).code, 'SEMANTIC_SNAPSHOT_UNSUPPORTED')
  }
  const ordinaryRpcError = Object.assign(new Error('getSemanticSnapshot 网络超时'), {
    code: 'RPC_ERROR'
  })
  assert.equal(normalizeSemanticSnapshotBridgeError(ordinaryRpcError), ordinaryRpcError)
})

test('多进程同时写入同一内容寻址目标得到同一完整文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-snapshot-race-test-'))
  const outputDirectory = join(root, 'snapshots')
  const payloadPath = join(root, 'payload.json')
  const payload = createPayload()
  writeFileSync(payloadPath, JSON.stringify(payload), 'utf8')
  const results = await Promise.all(
    Array.from({ length: 8 }, () => runPersistWorker(payloadPath, outputDirectory))
  )
  assert.equal(new Set(results.map((item) => item.snapshotPath)).size, 1)
  assert.equal(new Set(results.map((item) => item.snapshotFileSha256)).size, 1)
  assert.deepEqual(JSON.parse(readFileSync(results[0].snapshotPath, 'utf8')), payload)
})

test('快照输出路径拒绝普通文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-snapshot-nondir-test-'))
  const nonDirectory = join(root, 'not-a-directory')
  writeFileSync(nonDirectory, 'file')
  assert.throws(
    () => persistSemanticSnapshot(createPayload(), { outputDirectory: nonDirectory }),
    /不是目录/
  )
})

test('快照目录和文件使用私有权限并拒绝符号链接', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'semantic-snapshot-security-test-'))
  const outputDirectory = join(root, 'snapshots')
  mkdirSync(outputDirectory, { mode: 0o777 })
  chmodSync(outputDirectory, 0o777)
  const result = persistSemanticSnapshot(createPayload(), { outputDirectory })
  assert.equal(lstatSync(outputDirectory).mode & 0o777, 0o700)
  assert.equal(lstatSync(result.snapshotPath).mode & 0o777, 0o600)

  const realDirectory = join(root, 'real')
  const symlinkDirectory = join(root, 'link')
  mkdirSync(realDirectory)
  symlinkSync(realDirectory, symlinkDirectory, 'dir')
  assert.throws(
    () => persistSemanticSnapshot(createPayload(), { outputDirectory: symlinkDirectory }),
    /符号链接/
  )
})
