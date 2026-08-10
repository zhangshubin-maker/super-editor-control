import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SERVER_PATH = fileURLToPath(new URL('../index.js', import.meta.url))

function createMockClient() {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, SUPER_EDITOR_MOCK: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let nextId = 1
  let buffer = ''
  let stderr = ''
  const pending = new Map()

  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        const message = JSON.parse(line)
        const waiter = pending.get(message.id)
        if (waiter) {
          pending.delete(message.id)
          clearTimeout(waiter.timer)
          waiter.resolve(message)
        }
      }
      index = buffer.indexOf('\n')
    }
  })

  const request = (method, params = {}) => {
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP text mock request timed out: ${method}\n${stderr}`))
      }, 5000)
      pending.set(id, { resolve, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  return {
    request,
    close: async () => {
      if (!child.killed) child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
}

function readToolData(message) {
  assert.equal(message.error, undefined)
  assert.notEqual(message.result.isError, true)
  const block = message.result.content[0]
  assert.equal(block.type, 'text')
  return JSON.parse(block.text)
}

function readToolError(message) {
  assert.equal(message.error, undefined)
  assert.equal(message.result.isError, true)
  const block = message.result.content[0]
  assert.equal(block.type, 'text')
  return JSON.parse(block.text)
}

async function callTool(client, name, args) {
  return readToolData(
    await client.request('tools/call', {
      name,
      arguments: args
    })
  )
}

async function callToolError(client, name, args) {
  return readToolError(
    await client.request('tools/call', {
      name,
      arguments: args
    })
  )
}

test('structured text tools are listed and callable through stdio mock MCP', async () => {
  const client = createMockClient()
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18'
    })
    assert.equal(initialized.result.serverInfo.version, '0.8.1')

    const listed = await client.request('tools/list')
    const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]))
    const expectedNames = [
      'editor_text_info',
      'editor_text_document',
      'editor_text_set_content',
      'editor_text_set_style',
      'editor_text_edit',
      'editor_text_set_link',
      'editor_text_remove_link',
      'editor_text_edit_embed',
      'editor_text_format',
      'editor_text_set_layout',
      'editor_text_inspect_layout',
      'editor_text_fit_to_box',
      'editor_text_search',
      'editor_text_copy_style',
      'editor_text_fonts'
    ]
    expectedNames.forEach((name) => assert.ok(tools.has(name), `missing tool ${name}`))

    assert.deepEqual(tools.get('editor_text_edit').inputSchema.properties.action.enum, [
      'insert',
      'replace',
      'delete',
      'findReplace'
    ])
    assert.match(tools.get('editor_text_edit').inputSchema.properties.index.description, /UTF-16/)
    assert.deepEqual(tools.get('editor_text_format').inputSchema.properties.scope.enum, [
      'default',
      'all',
      'range',
      'match',
      'paragraph'
    ])
    assert.deepEqual(tools.get('editor_text_edit_embed').inputSchema.properties.action.enum, [
      'insert',
      'update',
      'delete'
    ])
    assert.deepEqual(tools.get('editor_text_edit_embed').inputSchema.properties.embedType.enum, [
      'formulaMath',
      'pinyinBox',
      'image'
    ])
    assert.ok(
      tools.get('editor_text_edit_embed').inputSchema.properties.value.properties.originalWidth
    )
    assert.ok(tools.get('editor_text_edit_embed').inputSchema.properties.value.properties.offsetY)
    assert.equal(
      tools.get('editor_text_set_layout').inputSchema.properties.layout.additionalProperties,
      false
    )
    assert.deepEqual(
      tools.get('editor_text_set_layout').inputSchema.properties.layout.properties.fill.type,
      ['object', 'null']
    )
    assert.deepEqual(
      tools.get('editor_text_set_layout').inputSchema.properties.layout.properties.overflowType
        .items.enum,
      ['auto', 'overWithBreak', 'overSizeScroll']
    )
    const formatProperties = tools.get('editor_text_format').inputSchema.properties
    assert.equal(formatProperties.expectedContentHash.type, 'string')
    assert.equal(formatProperties.dryRun.type, 'boolean')
    assert.match(formatProperties.paragraphIndexes.description, /0-based/)
    const layoutProperties = tools.get('editor_text_set_layout').inputSchema.properties
    assert.equal(layoutProperties.expectedContentHash, undefined)
    assert.equal(layoutProperties.dryRun, undefined)
    const fitProperties = tools.get('editor_text_fit').inputSchema.properties
    assert.equal(fitProperties.expectedContentHash, undefined)
    assert.equal(fitProperties.dryRun, undefined)
    const fitToBoxProperties = tools.get('editor_text_fit_to_box').inputSchema.properties
    assert.equal(fitToBoxProperties.expectedContentHash.type, 'string')
    assert.equal(fitToBoxProperties.allowUniformizeMixedSizes.type, 'boolean')
    assert.equal(fitToBoxProperties.dryRun, undefined)
    const textTargetKinds = ['element', 'tableCell', 'mindNode']
    const documentSchema = tools.get('editor_text_document').inputSchema
    assert.deepEqual(documentSchema.properties.target.properties.kind.enum, textTargetKinds)
    assert.equal(documentSchema.properties.target.properties.tableId.type[0], 'string')
    ;[
      'editor_text_adaptive',
      'editor_text_fit',
      'editor_text_set_layout',
      'editor_text_inspect_layout',
      'editor_text_fit_to_box'
    ].forEach((name) => {
      assert.equal(tools.get(name).inputSchema.properties.target, undefined)
      assert.deepEqual(tools.get(name).inputSchema.required.includes('elementId'), true)
    })
    const searchProperties = tools.get('editor_text_search').inputSchema.properties
    assert.equal(searchProperties.limit.maximum, 500)
    assert.deepEqual(searchProperties.targetKinds.default, textTargetKinds)
    assert.deepEqual(searchProperties.targetKinds.items.enum, textTargetKinds)
    const copyProperties = tools.get('editor_text_copy_style').inputSchema.properties
    assert.equal(
      copyProperties.targetElementIds.maxItems,
      200
    )
    assert.equal(copyProperties.targetTargets.maxItems, 200)
    assert.deepEqual(copyProperties.sourceTarget.properties.kind.enum, textTargetKinds)

    const document = await callTool(client, 'editor_text_document', {
      elementId: 'text-1'
    })
    assert.equal(document.elementId, 'text-1')
    assert.deepEqual(document.target, { kind: 'element', elementId: 'text-1' })
    assert.equal(document.targetKind, 'element')
    assert.equal(document.standaloneLayoutSupported, true)
    assert.equal(document.contentHash, 'mock-text-hash-1')
    assert.equal(document.roundTripSafe, true)
    assert.deepEqual(document.roundTripWarnings, [])
    assert.equal(document.plainText, '示例文本')
    assert.equal(document.displayText, document.plainText)
    assert.equal(document.indexText, '示例文本')
    assert.equal(document.displayIndexMap[0].indexStart, 0)
    assert.equal(document.paragraphs[0].start, 0)
    assert.equal(document.runs[0].formats.bold, true)

    const genericTextUpdateError = await callToolError(client, 'editor_update_element', {
      elementId: 'text-1',
      patch: { content: '<p>旁路覆盖</p>' }
    })
    assert.match(genericTextUpdateError.error, /editor_text_\*/)
    const genericStyleUpdate = await callTool(client, 'editor_update_element', {
      elementId: 'text-1',
      patch: { left: 20, defaultFontSize: 18 }
    })
    assert.equal(genericStyleUpdate, null)

    const replacedDocument = await callTool(client, 'editor_text_set_content', {
      elementId: 'text-1',
      content: '整段新内容',
      expectedContentHash: document.contentHash,
      dryRun: true
    })
    assert.equal(replacedDocument.dryRun, true)
    assert.equal(replacedDocument.expectedContentHash, document.contentHash)
    assert.equal(replacedDocument.previousContentHash, document.contentHash)
    assert.equal(replacedDocument.contentHash, 'mock-text-hash-2')

    const defaultStyle = await callTool(client, 'editor_text_set_style', {
      elementId: 'text-1',
      style: { fontSize: 18, color: '#333333' },
      expectedContentHash: document.contentHash
    })
    assert.equal(defaultStyle.scope, 'default')
    assert.deepEqual(defaultStyle.appliedFormats, { fontSize: 18, color: '#333333' })
    assert.equal(defaultStyle.expectedContentHash, document.contentHash)

    const edited = await callTool(client, 'editor_text_edit', {
      elementId: 'text-1',
      action: 'insert',
      index: 2,
      text: '新增',
      expectedContentHash: document.contentHash
    })
    assert.equal(edited.action, 'insert')
    assert.equal(edited.changes[0].index, 2)
    assert.equal(edited.changes[0].replacement, '新增')
    assert.equal(edited.contentHash, 'mock-text-hash-2')

    const linked = await callTool(client, 'editor_text_set_link', {
      elementId: 'text-1',
      index: 0,
      length: 2,
      hyperlink: {
        input_type: 1,
        link_mode: 1,
        jump_type: 1,
        link_address: 'https://example.com',
        agent_id: 0,
        agent_params: []
      },
      expectedContentHash: document.contentHash,
      dryRun: true
    })
    assert.deepEqual(linked.range, { index: 0, length: 2 })
    assert.equal(linked.hyperlinkId, 'mock-link-1')
    assert.equal(linked.hyperlink.hyperlink_id, linked.hyperlinkId)
    assert.equal(linked.dryRun, true)

    const unlinked = await callTool(client, 'editor_text_remove_link', {
      elementId: 'text-1',
      hyperlinkId: linked.hyperlinkId,
      expectedContentHash: document.contentHash
    })
    assert.equal(unlinked.hyperlinkId, linked.hyperlinkId)
    assert.deepEqual(unlinked.ranges, [{ index: 0, length: 2 }])

    const embedded = await callTool(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'insert',
      index: 2,
      embedType: 'image',
      value: { url: 'https://example.com/image.png' },
      expectedContentHash: document.contentHash,
      dryRun: true
    })
    assert.equal(embedded.embedType, 'image')
    assert.equal(embedded.embeds[0].length, 1)
    assert.equal(embedded.dryRun, true)

    const partialImageUpdate = await callTool(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'update',
      index: 2,
      embedType: 'image',
      value: {
        width: 320,
        height: 180,
        originalWidth: 1280,
        originalHeight: 720,
        rotate: 15,
        opacity: 0.8,
        flip: 1,
        outlineWidth: 2,
        outlineColor: '#ff0000',
        outlineStyle: 'solid',
        verticalAlign: 'middle',
        offsetX: 4,
        offsetY: 6
      },
      expectedContentHash: document.contentHash,
      dryRun: true
    })
    assert.equal(partialImageUpdate.value.originalWidth, 1280)
    assert.equal(partialImageUpdate.value.offsetY, 6)

    const pinyinInsert = await callTool(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'insert',
      index: 2,
      embedType: 'pinyinBox',
      value: { pinyin: 'hǎo', word: '好' },
      expectedContentHash: document.contentHash,
      dryRun: true
    })
    assert.equal(pinyinInsert.value.word, '好')

    const formatted = await callTool(client, 'editor_text_format', {
      elementId: 'text-1',
      scope: 'range',
      index: 0,
      length: 2,
      formats: { bold: true, color: '#ff0000' },
      expectedContentHash: document.contentHash,
      dryRun: true
    })
    assert.equal(formatted.scope, 'range')
    assert.deepEqual(formatted.appliedFormats, { bold: true, color: '#ff0000' })
    assert.deepEqual(formatted.ranges[0], { index: 0, length: 2 })
    assert.equal(formatted.expectedContentHash, document.contentHash)
    assert.equal(formatted.dryRun, true)
    assert.equal(formatted.changed, false)

    const layout = await callTool(client, 'editor_text_set_layout', {
      elementId: 'text-1',
      layout: {
        extendType: 'vertical',
        paddingLeft: 12,
        overflowType: ['auto', 'overWithBreak'],
        fill: { enabled: true, color: '#ffffff' }
      }
    })
    assert.equal(layout.layout.extendType, 'vertical')
    assert.equal(layout.layout.padding.left, 12)
    assert.deepEqual(layout.layout.overflowType, ['auto', 'overWithBreak'])
    assert.deepEqual(layout.layout.fill, { enabled: true, color: '#ffffff' })
    assert.equal(layout.settled, true)

    const inspection = await callTool(client, 'editor_text_inspect_layout', {
      elementId: 'text-1'
    })
    assert.equal(inspection.measurement.overflow, false)
    assert.deepEqual(inspection.warnings, [])

    const fitted = await callTool(client, 'editor_text_fit_to_box', {
      elementId: 'text-1',
      minFontSize: 8,
      maxFontSize: 18,
      step: 1,
      expectedContentHash: document.contentHash
    })
    assert.equal(fitted.applied, true)
    assert.equal(fitted.fits, true)
    assert.equal(fitted.fontSize, 16)
    assert.equal(fitted.contentHash, 'mock-text-hash-2')

    const mixedSizeNoOp = await callTool(client, 'editor_text_fit_to_box', {
      elementId: 'text-mixed-sizes',
      expectedContentHash: document.contentHash
    })
    assert.equal(mixedSizeNoOp.applied, false)
    assert.equal(mixedSizeNoOp.reason, 'mixed-font-sizes')
    assert.deepEqual(mixedSizeNoOp.fontSizes, [14, 20])
    assert.deepEqual(mixedSizeNoOp.invalidFontSizes, [])
    assert.equal(mixedSizeNoOp.requiresExplicitUniformization, true)
    assert.equal(mixedSizeNoOp.uniformizedMixedSizes, false)
    assert.equal(mixedSizeNoOp.contentHash, document.contentHash)

    const mixedSizeUniformized = await callTool(client, 'editor_text_fit_to_box', {
      elementId: 'text-mixed-sizes',
      expectedContentHash: document.contentHash,
      allowUniformizeMixedSizes: true
    })
    assert.equal(mixedSizeUniformized.applied, true)
    assert.equal(mixedSizeUniformized.uniformizedMixedSizes, true)

    const searched = await callTool(client, 'editor_text_search', {
      query: '示例',
      limit: 20
    })
    assert.deepEqual(searched.targetKinds, ['element', 'tableCell', 'mindNode'])
    assert.equal(searched.searchedTargets, 3)
    assert.equal(searched.total, 3)
    assert.equal(searched.ranges[0].elementId, 'el-1')
    assert.equal(searched.items[0].ranges[0].index, 0)
    assert.equal(searched.matches[0].elementId, 'el-1')
    assert.equal(searched.matches[0].index, 0)
    assert.equal(searched.matches[0].length, 2)
    assert.equal(searched.matches[0].displayIndex, 0)
    assert.equal(searched.matches[0].displayLength, 2)
    assert.deepEqual(
      searched.matches.map((match) => match.targetKind),
      ['element', 'tableCell', 'mindNode']
    )

    const searchedMindNodes = await callTool(client, 'editor_text_search', {
      query: '示例',
      targetKinds: ['mindNode']
    })
    assert.deepEqual(searchedMindNodes.targetKinds, ['mindNode'])
    assert.equal(searchedMindNodes.total, 1)
    assert.equal(searchedMindNodes.matches[0].targetKind, 'mindNode')

    const copied = await callTool(client, 'editor_text_copy_style', {
      sourceElementId: 'text-1',
      targetElementIds: ['text-2', 'text-3'],
      scope: 'all'
    })
    assert.equal(copied.results.length, 2)
    assert.deepEqual(copied.targetElementIds, ['text-2', 'text-3'])
    assert.deepEqual(copied.sourceTarget, { kind: 'element', elementId: 'text-1' })
    assert.deepEqual(copied.copied, [
      { kind: 'element', elementId: 'text-2' },
      { kind: 'element', elementId: 'text-3' }
    ])

    const tableCellTarget = {
      kind: 'tableCell',
      tableId: 'table-1',
      cellId: 'cell-1'
    }
    const tableCellByPositionTarget = {
      kind: 'tableCell',
      tableId: 'table-1',
      row: 0,
      col: 1
    }
    const mindNodeTarget = {
      kind: 'mindNode',
      mindId: 'mind-1',
      nodeId: 'node-1'
    }
    const nestedInfo = await callTool(client, 'editor_text_info', {
      target: tableCellTarget
    })
    assert.equal(nestedInfo.targetKind, 'tableCell')
    assert.equal(nestedInfo.elementId, 'table-1')
    assert.equal(nestedInfo.geometry, null)
    assert.equal(nestedInfo.standaloneLayoutSupported, false)

    const nestedDocument = await callTool(client, 'editor_text_document', {
      target: tableCellByPositionTarget
    })
    assert.deepEqual(nestedDocument.target, tableCellByPositionTarget)
    assert.equal(nestedDocument.layoutOwner, 'table')

    const nestedContent = await callTool(client, 'editor_text_set_content', {
      target: mindNodeTarget,
      content: '新的节点文本'
    })
    assert.equal(nestedContent.targetKind, 'mindNode')
    assert.equal(nestedContent.elementId, 'mind-1')
    assert.equal(nestedContent.width, null)
    assert.equal(nestedContent.height, null)
    assert.equal(nestedContent.standaloneLayoutSupported, false)
    assert.equal(nestedContent.settled, false)
    assert.equal(nestedContent.deferredLayout, true)

    const nestedStyle = await callTool(client, 'editor_text_set_style', {
      target: tableCellTarget,
      style: { color: '#336699' }
    })
    assert.equal(nestedStyle.targetKind, 'tableCell')
    assert.equal(nestedStyle.scope, 'default')

    const nestedEdit = await callTool(client, 'editor_text_edit', {
      target: mindNodeTarget,
      action: 'insert',
      index: 0,
      text: '重点：'
    })
    assert.equal(nestedEdit.targetKind, 'mindNode')
    assert.equal(nestedEdit.width, null)
    assert.equal(nestedEdit.settled, false)
    assert.equal(nestedEdit.deferredLayout, true)

    const nestedLink = await callTool(client, 'editor_text_set_link', {
      target: tableCellTarget,
      index: 0,
      length: 2,
      hyperlink: {
        input_type: 1,
        link_mode: 1,
        jump_type: 1,
        link_address: 'https://example.com/cell',
        agent_id: 0,
        agent_params: []
      }
    })
    assert.equal(nestedLink.targetKind, 'tableCell')

    const nestedUnlink = await callTool(client, 'editor_text_remove_link', {
      target: tableCellTarget,
      hyperlinkId: nestedLink.hyperlinkId
    })
    assert.equal(nestedUnlink.targetKind, 'tableCell')

    const nestedEmbed = await callTool(client, 'editor_text_edit_embed', {
      target: mindNodeTarget,
      action: 'insert',
      index: 1,
      embedType: 'formulaMath',
      value: { latex: 'x^2' }
    })
    assert.equal(nestedEmbed.targetKind, 'mindNode')

    const nestedFormat = await callTool(client, 'editor_text_format', {
      target: tableCellTarget,
      scope: 'all',
      formats: { bold: true }
    })
    assert.equal(nestedFormat.targetKind, 'tableCell')
    assert.equal(nestedFormat.width, null)
    assert.equal(nestedFormat.settled, false)
    assert.equal(nestedFormat.deferredLayout, true)

    const nestedCopy = await callTool(client, 'editor_text_copy_style', {
      sourceTarget: tableCellTarget,
      targetTargets: [mindNodeTarget]
    })
    assert.deepEqual(nestedCopy.sourceTarget, tableCellTarget)
    assert.deepEqual(nestedCopy.targetTargets, [mindNodeTarget])
    assert.equal(nestedCopy.results[0].targetKind, 'mindNode')

    const mixedCopy = await callTool(client, 'editor_text_copy_style', {
      sourceElementId: 'text-1',
      targetTargets: [tableCellTarget],
      scope: 'character'
    })
    assert.equal(mixedCopy.sourceTarget.kind, 'element')
    assert.equal(mixedCopy.results[0].targetKind, 'tableCell')

    const fonts = await callTool(client, 'editor_text_fonts', {
      language: 'english'
    })
    assert.equal(fonts.language, 'english')
    assert.deepEqual(fonts.items.map((font) => font.value), ['Arial'])

    const documentError = await callToolError(client, 'editor_text_document', {
      elementId: '  '
    })
    assert.match(documentError.error, /elementId/)

    const duplicateTargetSelectorError = await callToolError(
      client,
      'editor_text_document',
      {
        elementId: 'text-1',
        target: { kind: 'element', elementId: 'text-1' }
      }
    )
    assert.match(duplicateTargetSelectorError.error, /elementId.*target|target.*elementId/)

    const tableTargetSelectorError = await callToolError(client, 'editor_text_document', {
      target: { kind: 'tableCell', tableId: 'table-1' }
    })
    assert.match(tableTargetSelectorError.error, /cellId.*row.*col|row.*col.*cellId/)

    const partialTablePositionError = await callToolError(client, 'editor_text_document', {
      target: { kind: 'tableCell', tableId: 'table-1', row: 0 }
    })
    assert.match(partialTablePositionError.error, /row.*col/)

    const targetFieldError = await callToolError(client, 'editor_text_document', {
      target: { kind: 'mindNode', mindId: 'mind-1', nodeId: 'node-1', tableId: 'table-1' }
    })
    assert.match(targetFieldError.error, /不支持.*tableId/)

    const nestedLayoutError = await callToolError(client, 'editor_text_set_layout', {
      target: tableCellTarget,
      layout: { paddingLeft: 8 }
    })
    assert.equal(nestedLayoutError.errorCode, 'TEXT_LAYOUT_TARGET_UNSUPPORTED')

    const nestedCopyLayoutError = await callToolError(client, 'editor_text_copy_style', {
      sourceTarget: tableCellTarget,
      targetTargets: [mindNodeTarget],
      scope: 'layout'
    })
    assert.equal(nestedCopyLayoutError.errorCode, 'TEXT_LAYOUT_TARGET_UNSUPPORTED')

    const nestedCopyAllError = await callToolError(client, 'editor_text_copy_style', {
      sourceElementId: 'text-1',
      targetTargets: [tableCellTarget],
      scope: 'all'
    })
    assert.equal(nestedCopyAllError.errorCode, 'TEXT_LAYOUT_TARGET_UNSUPPORTED')

    const styleError = await callToolError(client, 'editor_text_set_style', {
      elementId: 'text-1',
      style: {}
    })
    assert.match(styleError.error, /style/)

    const editError = await callToolError(client, 'editor_text_edit', {
      elementId: 'text-1',
      action: 'insert',
      text: 'missing index'
    })
    assert.match(editError.error, /index/)

    const replaceByMatchError = await callToolError(client, 'editor_text_edit', {
      elementId: 'text-1',
      action: 'replace',
      match: '示例',
      text: '替换'
    })
    assert.match(replaceByMatchError.error, /match|index.*length/)

    const deleteLengthError = await callToolError(client, 'editor_text_edit', {
      elementId: 'text-1',
      action: 'delete',
      index: 0
    })
    assert.match(deleteLengthError.error, /index.*length/)

    const findDelete = await callTool(client, 'editor_text_edit', {
      elementId: 'text-1',
      action: 'findReplace',
      match: '示例',
      occurrence: 1,
      dryRun: true
    })
    assert.equal(findDelete.action, 'findReplace')
    assert.equal(findDelete.changes[0].replacement, '')

    const linkError = await callToolError(client, 'editor_text_set_link', {
      elementId: 'text-1',
      index: 0,
      length: 2
    })
    assert.match(linkError.error, /hyperlinkId|hyperlink/)

    const blankLinkIdError = await callToolError(client, 'editor_text_set_link', {
      elementId: 'text-1',
      index: 0,
      length: 2,
      hyperlinkId: '  '
    })
    assert.match(blankLinkIdError.error, /hyperlinkId/)

    const urlMetadataError = await callToolError(client, 'editor_text_set_link', {
      elementId: 'text-1',
      index: 0,
      length: 2,
      hyperlink: { input_type: 1, link_mode: 1, jump_type: 1 }
    })
    assert.match(urlMetadataError.error, /link_address/)

    const agentMetadataError = await callToolError(client, 'editor_text_set_link', {
      elementId: 'text-1',
      index: 0,
      length: 2,
      hyperlink: { input_type: 1, link_mode: 1, jump_type: 2, agent_id: 0, agent_params: [] }
    })
    assert.match(agentMetadataError.error, /agent_id/)

    const unlinkError = await callToolError(client, 'editor_text_remove_link', {
      elementId: 'text-1'
    })
    assert.match(unlinkError.error, /hyperlinkId|index/)

    const partialUnlinkError = await callToolError(client, 'editor_text_remove_link', {
      elementId: 'text-1',
      index: 0
    })
    assert.match(partialUnlinkError.error, /index.*length/)

    const embedError = await callToolError(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'insert',
      index: 0
    })
    assert.match(embedError.error, /embedType/)

    const pinyinError = await callToolError(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'insert',
      index: 0,
      embedType: 'pinyinBox',
      value: { pinyin: 'hǎo', word: '两个' }
    })
    assert.match(pinyinError.error, /pinyinBox/)

    const imageError = await callToolError(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'insert',
      index: 0,
      embedType: 'image',
      value: { url: '  ' }
    })
    assert.match(imageError.error, /image/)

    const imageFieldError = await callToolError(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'update',
      index: 0,
      embedType: 'image',
      value: { style: 'width:100px' }
    })
    assert.match(imageFieldError.error, /image value.*style/)

    const formulaError = await callToolError(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'insert',
      index: 0,
      embedType: 'formulaMath',
      value: { latex: '' }
    })
    assert.match(formulaError.error, /formulaMath/)

    const deleteEmbedError = await callToolError(client, 'editor_text_edit_embed', {
      elementId: 'text-1',
      action: 'delete',
      index: 0,
      value: 'unexpected'
    })
    assert.match(deleteEmbedError.error, /delete.*value/)

    const hashError = await callToolError(client, 'editor_text_format', {
      elementId: 'text-1',
      scope: 'all',
      formats: { bold: true },
      expectedContentHash: '  '
    })
    assert.match(hashError.error, /expectedContentHash/)

    const formatError = await callToolError(client, 'editor_text_format', {
      elementId: 'text-1',
      scope: 'range',
      index: 0,
      formats: { bold: true }
    })
    assert.match(formatError.error, /length/)

    const defaultStyleFieldError = await callToolError(client, 'editor_text_set_style', {
      elementId: 'text-1',
      style: { align: 'center' }
    })
    assert.match(defaultStyleFieldError.error, /style.*align/)

    const layoutError = await callToolError(client, 'editor_text_set_layout', {
      elementId: 'text-1',
      layout: {}
    })
    assert.match(layoutError.error, /layout/)

    const fillLayoutError = await callToolError(client, 'editor_text_set_layout', {
      elementId: 'text-1',
      layout: { fill: '#ffffff' }
    })
    assert.match(fillLayoutError.error, /layout\.fill/)

    const overflowLayoutError = await callToolError(client, 'editor_text_set_layout', {
      elementId: 'text-1',
      layout: { overflowType: 'auto' }
    })
    assert.match(overflowLayoutError.error, /layout\.overflowType/)

    const unknownLayoutError = await callToolError(client, 'editor_text_set_layout', {
      elementId: 'text-1',
      layout: { madeUpLayoutField: true }
    })
    assert.match(unknownLayoutError.error, /madeUpLayoutField/)

    const fitError = await callToolError(client, 'editor_text_fit_to_box', {
      elementId: 'text-1',
      minFontSize: 20,
      maxFontSize: 12
    })
    assert.match(fitError.error, /minFontSize.*maxFontSize/)

    const fitFlagError = await callToolError(client, 'editor_text_fit_to_box', {
      elementId: 'text-1',
      allowUniformizeMixedSizes: 'yes'
    })
    assert.match(fitFlagError.error, /allowUniformizeMixedSizes.*布尔值/)

    const fitDryRunError = await callToolError(client, 'editor_text_fit_to_box', {
      elementId: 'text-1',
      dryRun: true
    })
    assert.match(fitDryRunError.error, /不支持 dryRun/)

    const fitConflict = await callToolError(client, 'editor_text_fit_to_box', {
      elementId: 'text-1',
      expectedContentHash: 'mock-text-hash-stale'
    })
    assert.equal(fitConflict.errorCode, 'TEXT_CONTENT_CONFLICT')

    const layoutHashError = await callToolError(client, 'editor_text_set_layout', {
      elementId: 'text-1',
      layout: { paddingLeft: 8 },
      expectedContentHash: document.contentHash
    })
    assert.match(layoutHashError.error, /不支持 expectedContentHash/)

    const resizeDryRunError = await callToolError(client, 'editor_text_fit', {
      elementId: 'text-1',
      dryRun: true
    })
    assert.match(resizeDryRunError.error, /不支持 dryRun/)

    const adaptive = await callTool(client, 'editor_text_adaptive', {
      elementId: 'text-1',
      extendType: 'vertical',
      waitMs: 3456
    })
    assert.equal(adaptive.waitMs, 3456)

    const searchError = await callToolError(client, 'editor_text_search', {
      query: '  '
    })
    assert.match(searchError.error, /query/)

    const searchTargetKindsError = await callToolError(client, 'editor_text_search', {
      query: '示例',
      targetKinds: ['element', 'unknown']
    })
    assert.match(searchTargetKindsError.error, /targetKinds/)

    const copyError = await callToolError(client, 'editor_text_copy_style', {
      sourceElementId: 'text-1',
      targetElementIds: []
    })
    assert.match(copyError.error, /targetElementIds/)
  } finally {
    await client.close()
  }
})
