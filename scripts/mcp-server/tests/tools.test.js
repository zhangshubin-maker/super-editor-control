import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SERVER_PATH = fileURLToPath(new URL('../index.js', import.meta.url))

function createMockClient(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, SUPER_EDITOR_MOCK: '1', ...extraEnv },
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
        reject(new Error(`MCP mock 请求超时: ${method}\n${stderr}`))
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

const readToolData = (message) => {
  assert.equal(message.error, undefined)
  const block = message.result.content[0]
  assert.equal(block.type, 'text')
  return JSON.parse(block.text)
}

const readToolError = (message) => {
  assert.equal(message.error, undefined)
  assert.equal(message.result.isError, true)
  const block = message.result.content[0]
  assert.equal(block.type, 'text')
  return JSON.parse(block.text)
}

test('数字模块、题目和通用上传工具均可通过 mock MCP 调用', async () => {
  const client = createMockClient()
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18'
    })
    assert.equal(initialized.result.serverInfo.version, '0.11.0')

    const listed = await client.request('tools/list')
    const names = listed.result.tools.map((tool) => tool.name)
    assert.equal(new Set(names).size, names.length)
    const expected = [
      'editor_upload_file',
      'editor_list_digital_module_types',
      'editor_get_digital_module',
      'editor_list_digital_modules',
      'editor_create_digital_module',
      'editor_update_digital_module',
      'editor_delete_digital_module',
      'editor_copy_digital_module',
      'editor_export_semantic_snapshot',
      'editor_list_question_paths',
      'editor_get_question_search_options',
      'editor_search_questions',
      'editor_get_questions',
      'editor_validate_question_selection',
      'editor_get_question_solutions',
      'editor_add_questions_to_catalog',
      'editor_remove_catalog_question',
      'editor_move_catalog_question',
      'editor_get_question_explanations',
      'editor_start_question_explanation_generation',
      'editor_get_question_explanation_status',
      'editor_save_question_explanation',
      'editor_delete_question_explanation'
    ]
    expected.forEach((name) => assert.ok(names.includes(name), `缺少工具 ${name}`))

    const semanticSnapshotTool = listed.result.tools.find(
      (tool) => tool.name === 'editor_export_semantic_snapshot'
    )
    assert.deepEqual(semanticSnapshotTool.inputSchema.properties.slideId.type, ['string', 'number'])
    assert.deepEqual(semanticSnapshotTool.inputSchema.properties.richText.enum, [
      'none',
      'summary',
      'deep'
    ])

    const searchTool = listed.result.tools.find((tool) => tool.name === 'editor_search_questions')
    assert.deepEqual(searchTool.inputSchema.properties.scope.enum, [
      'currentCatalog',
      'currentBookResources',
      'learningPath',
      'book',
      'global'
    ])
    const explicitFilterFields = [
      'period',
      'subjectId',
      'gradeId',
      'volume',
      'difficulty',
      'features',
      'guidList',
      'haveResolution',
      'haveReview',
      'haveSolution',
      'haveSolutionVideo',
      'subModelIds',
      'searchAreaTypes',
      'sourceInfos',
      'businessTypes',
      'haveTag',
      'tagNodeIds'
    ]
    explicitFilterFields.forEach((field) => {
      assert.ok(searchTool.inputSchema.properties[field], `搜索工具缺少显式筛选字段 ${field}`)
    })
    const validateTool = listed.result.tools.find(
      (tool) => tool.name === 'editor_validate_question_selection'
    )
    const addQuestionsTool = listed.result.tools.find(
      (tool) => tool.name === 'editor_add_questions_to_catalog'
    )
    const saveExplanationTool = listed.result.tools.find(
      (tool) => tool.name === 'editor_save_question_explanation'
    )
    assert.equal(validateTool.inputSchema.properties.guids.maxItems, 50)
    assert.equal(addQuestionsTool.inputSchema.properties.guids.maxItems, 50)
    assert.equal(saveExplanationTool.inputSchema.properties.content.type, 'string')
    assert.equal(saveExplanationTool.inputSchema.properties.id.type, 'integer')
    assert.equal(searchTool.inputSchema.properties.pageNo.minimum, 0)
    assert.equal(searchTool.inputSchema.properties.pageSize.minimum, 1)
    assert.equal(searchTool.inputSchema.properties.pageSize.maximum, 100)
    assert.match(validateTool.inputSchema.properties.config.description, /rules/)
    const getQuestionsTool = listed.result.tools.find(
      (tool) => tool.name === 'editor_get_questions'
    )
    assert.match(
      getQuestionsTool.inputSchema.properties.includeDiagnostics.description,
      /uniqueGuids.*duplicateGuids/
    )

    const jumped = readToolData(
      await client.request('tools/call', {
        name: 'editor_jump_to_book',
        arguments: { bookId: 1820651, target: 'url' }
      })
    )
    const jumpUrl = new URL(jumped.url)
    const jumpRouteParams = new URLSearchParams(jumpUrl.hash.split('?')[1])
    assert.equal(jumpUrl.searchParams.has('book_id'), false)
    assert.equal(jumpUrl.searchParams.has('ai_control'), false)
    assert.equal(jumpRouteParams.get('book_id'), '1820651')
    assert.equal(jumpRouteParams.get('ai_control'), '1')

    const switched = readToolData(
      await client.request('tools/call', {
        name: 'editor_jump_to_book',
        arguments: { bookId: 1820651, target: 'current' }
      })
    )
    assert.equal(switched.ready, true)
    assert.equal(switched.bridgeReady, true)
    assert.equal(switched.windowId, 'mock-window')
    assert.equal(switched.currentSlideId, 'slide-1')
    assert.equal(switched.hotSwitched, true)
    assert.equal(switched.reloadScheduled, false)
    assert.equal(switched.contextEpoch, 2)
    assert.equal(switched.instancePreserved, true)
    assert.equal(switched.contentReady, true)
    assert.equal(switched.currentSlidePlaceholder, false)
    assert.equal(switched.emptyBook, false)

    const semanticSnapshot = readToolData(
      await client.request('tools/call', {
        name: 'editor_export_semantic_snapshot',
        arguments: { slideId: '2002', richText: 'deep' }
      })
    )
    assert.match(semanticSnapshot.snapshotFileSha256, /^sha256:[a-f0-9]{64}$/)
    assert.match(semanticSnapshot.snapshotStableHash, /^sha256:[a-f0-9]{64}$/)
    assert.equal(semanticSnapshot.snapshotStableHashAuthority, 'bridge:getSemanticSnapshot/v1')
    assert.equal(semanticSnapshot.snapshotStableHashVerified, true)
    assert.equal(semanticSnapshot.identity.catalogId, '2002')
    assert.equal(semanticSnapshot.state.source, 'persisted')
    assert.equal(semanticSnapshot.completeness.complete, true)
    assert.equal(semanticSnapshot.meta.digitalModuleCount, 1)
    const semanticSnapshotJson = JSON.parse(
      readFileSync(semanticSnapshot.snapshotPath, 'utf8')
    )
    assert.equal(semanticSnapshotJson.snapshot.identity.catalogName, '目录 2002')
    assert.equal(
      semanticSnapshotJson.snapshot.blocks[0].template_data_content.elements[0].content,
      '<p>示例文本</p>'
    )
    assert.equal(semanticSnapshotJson.snapshot.digitalModules.items[0].raw.model_id, 991)
    assert.equal(semanticSnapshotJson.snapshot.richText.items[0].runs[0].formats.bold, true)

    const semanticSnapshotDefault = readToolData(
      await client.request('tools/call', {
        name: 'editor_export_semantic_snapshot',
        arguments: {}
      })
    )
    const semanticSnapshotDefaultJson = JSON.parse(
      readFileSync(semanticSnapshotDefault.snapshotPath, 'utf8')
    )
    assert.equal(semanticSnapshotDefaultJson.snapshot.richText.detail, 'deep')

    for (const slideId of [0, -1, 'not-an-id']) {
      const invalidSlideId = readToolError(
        await client.request('tools/call', {
          name: 'editor_export_semantic_snapshot',
          arguments: { slideId }
        })
      )
      assert.match(invalidSlideId.error, /slideId 必须是正整数 id/)
    }

    const uploaded = readToolData(
      await client.request('tools/call', {
        name: 'editor_upload_file',
        arguments: { filePath: 'lesson.mp3' }
      })
    )
    assert.equal(uploaded.fileName, 'lesson.mp3')
    assert.equal(uploaded.mimeType, 'audio/mpeg')

    const created = readToolData(
      await client.request('tools/call', {
        name: 'editor_create_digital_module',
        arguments: {
          elementId: 'play-button',
          type: 77,
          mediaPath: 'lesson.mp3'
        }
      })
    )
    assert.equal(created.elementId, 'play-button')
    assert.equal(created.config.uploadedFile.fileName, 'lesson.mp3')
    assert.equal(JSON.stringify(created).includes('mediaPath'), false)

    const rejected = await client.request('tools/call', {
      name: 'editor_create_digital_module',
      arguments: {
        elementId: 'play-button',
        type: 77,
        mediaPath: 'lesson.mp3',
        validateOnly: true
      }
    })
    assert.equal(rejected.result.isError, true)
    const rejectedBody = JSON.parse(rejected.result.content[0].text)
    assert.match(rejectedBody.error, /validateOnly.*mediaPath/)

    const questions = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_questions',
        arguments: { guids: ['question-a', 'question-b'] }
      })
    )
    assert.deepEqual(
      questions.map((item) => item.guid),
      ['question-a', 'question-b']
    )

    const paths = readToolData(
      await client.request('tools/call', {
        name: 'editor_list_question_paths',
        arguments: { bookId: 123, flatten: false }
      })
    )
    assert.equal(paths.bookId, 123)
    assert.equal(paths.flatten, false)
    assert.equal(paths.items, undefined)
    assert.equal(paths.tree[0].child_list[0].id, 'mock-path-2')

    const options = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_question_search_options',
        arguments: { bookId: 123, refresh: true }
      })
    )
    assert.equal(options.bookId, 123)
    assert.equal(options.questionModels[0].modelId, 5)
    assert.equal(options.dictionaries.subjects[0].id, 2)

    const searched = readToolData(
      await client.request('tools/call', {
        name: 'editor_search_questions',
        arguments: {
          scope: 'currentBookResources',
          query: '一次函数',
          subjectId: 2,
          difficulty: 3,
          haveSolution: true,
          subModelIds: [1, 2],
          pageNo: 2,
          pageSize: 10
        }
      })
    )
    assert.equal(searched.scope, 'currentBookResources')
    assert.equal(searched.canonicalScope, 'currentBookResources')
    assert.equal(searched.query, '一次函数')
    assert.equal(searched.pageNo, 2)
    assert.equal(searched.pageSize, 10)
    assert.deepEqual(searched.appliedFilters, {})
    assert.deepEqual(searched.ignoredFilters, [
      'subjectId',
      'difficulty',
      'haveSolution',
      'subModelIds'
    ])
    assert.match(searched.warnings.join('\n'), /已忽略.*subjectId.*difficulty/)
    assert.equal(searched.items[0].resourceMappingId, 501)

    const globallySearched = readToolData(
      await client.request('tools/call', {
        name: 'editor_search_questions',
        arguments: {
          scope: 'global',
          query: '一次函数',
          filters: {
            subjectId: 2,
            difficulty: 2,
            haveSolution: true
          },
          difficulty: 3,
          subModelIds: [1, 2],
          pageNo: -3,
          pageSize: 500
        }
      })
    )
    assert.deepEqual(globallySearched.appliedFilters, {
      subjectId: 2,
      difficulty: 3,
      haveSolution: true,
      subModelIds: [1, 2]
    })
    assert.equal(globallySearched.pageNo, 0)
    assert.equal(globallySearched.pageSize, 100)
    assert.deepEqual(globallySearched.warnings, [])

    const diagnostics = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_questions',
        arguments: {
          guids: [' question-a ', 'question-a', 'missing-question'],
          includeDiagnostics: true
        }
      })
    )
    assert.deepEqual(diagnostics.requestedGuids, [
      'question-a',
      'question-a',
      'missing-question'
    ])
    assert.deepEqual(diagnostics.uniqueGuids, ['question-a', 'missing-question'])
    assert.deepEqual(diagnostics.foundGuids, ['question-a'])
    assert.deepEqual(diagnostics.missingGuids, ['missing-question'])
    assert.deepEqual(diagnostics.duplicateGuids, ['question-a'])

    const selection = readToolData(
      await client.request('tools/call', {
        name: 'editor_validate_question_selection',
        arguments: {
          guids: ['question-a', 'question-a', 'question-b'],
          targetModuleType: 93
        }
      })
    )
    assert.equal(selection.compatible, false)
    assert.deepEqual(selection.duplicateGuids, ['question-a'])
    assert.deepEqual(selection.selectedGuids, ['question-a', 'question-b'])
    assert.deepEqual(selection.foundGuids, ['question-a', 'question-b'])
    assert.equal(selection.items[0].guid, 'question-a')
    assert.ok(selection.reasons.every((reason) => reason.code && reason.message))
    assert.match(
      selection.reasons.map((reason) => reason.message).join('\n'),
      /只能关联一道题目/
    )

    const assessmentWithoutTimer = readToolData(
      await client.request('tools/call', {
        name: 'editor_validate_question_selection',
        arguments: {
          guids: ['question-a'],
          targetModuleType: 82,
          config: { questionMode: 2, timeMode: 0, rules: 1 }
        }
      })
    )
    assert.equal(assessmentWithoutTimer.compatible, false)
    assert.ok(
      assessmentWithoutTimer.reasons.some((reason) => reason.code === 'INVALID_TIME_MODE')
    )

    const countdownWithoutLimit = readToolData(
      await client.request('tools/call', {
        name: 'editor_validate_question_selection',
        arguments: {
          guids: ['question-a'],
          targetModuleType: 82,
          config: { questionMode: 1, timeMode: 1, rules: 2 }
        }
      })
    )
    assert.equal(countdownWithoutLimit.compatible, false)
    assert.ok(
      countdownWithoutLimit.reasons.some((reason) => reason.code === 'TIME_LIMIT_REQUIRED')
    )

    const solutions = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_question_solutions',
        arguments: { guids: [' question-a ', 'question-a'] }
      })
    )
    assert.deepEqual(solutions.requestedGuids, ['question-a'])
    assert.equal(solutions.items.length, 1)
    assert.equal(solutions.items[0].guid, 'question-a')
    assert.equal(solutions.items[0].hasSolution, true)
    assert.deepEqual(solutions.items[0].solutions[0].answer, ['A'])

    const validatedAdd = readToolData(
      await client.request('tools/call', {
        name: 'editor_add_questions_to_catalog',
        arguments: {
          guids: ['question-a'],
          bookId: 123,
          catalogId: 456,
          validateOnly: true
        }
      })
    )
    assert.equal(validatedAdd.validated, true)
    assert.equal(validatedAdd.added, false)
    assert.equal(validatedAdd.bookId, 123)
    assert.equal(validatedAdd.catalogId, 456)
    assert.deepEqual(validatedAdd.existingGuids, [])
    assert.deepEqual(validatedAdd.missingGuids, [])
    assert.deepEqual(validatedAdd.addableGuids, ['question-a'])
    assert.deepEqual(validatedAdd.addedGuids, [])

    const removed = readToolData(
      await client.request('tools/call', {
        name: 'editor_remove_catalog_question',
        arguments: { resourceMappingId: 789 }
      })
    )
    assert.equal(removed.resourceMappingId, 789)
    assert.equal(removed.persistedImmediately, true)

    const moved = readToolData(
      await client.request('tools/call', {
        name: 'editor_move_catalog_question',
        arguments: { resourceMappingId: 789, toIndex: 2 }
      })
    )
    assert.equal(moved.resourceMappingId, 789)
    assert.equal(moved.toIndex, 2)
    assert.equal(moved.persistedImmediately, true)

    const started = readToolData(
      await client.request('tools/call', {
        name: 'editor_start_question_explanation_generation',
        arguments: {
          guids: [' question-a ', 'question-a', 'question-b'],
          bookId: 123
        }
      })
    )
    assert.equal(started.started, true)
    assert.equal(started.batch, true)
    assert.deepEqual(started.guids, ['question-a', 'question-b'])

    const status = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_question_explanation_status',
        arguments: {
          guids: [' question-a ', 'question-a', 'question-b'],
          bookId: 123,
          includeResults: true
        }
      })
    )
    assert.equal(status.bookId, 123)
    assert.equal(status.items.length, 2)
    assert.equal(status.items[0].guid, 'question-a')
    assert.equal(status.items[0].taskStatus, 2)
    assert.equal(status.items[0].status, 'succeeded')
    assert.equal(status.items[0].done, true)
    assert.equal(status.items[0].explanations[0].questionGuid, 'question-a')
    assert.deepEqual(status.items[0].explainIds, [901])

    const explanations = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_question_explanations',
        arguments: { guids: [' question-a ', 'question-a'] }
      })
    )
    assert.deepEqual(explanations.requestedGuids, ['question-a'])
    assert.equal(explanations.items.length, 1)
    assert.equal(explanations.items[0].guid, 'question-a')
    assert.equal(explanations.items[0].explanations[0].id, 901)
    assert.deepEqual(explanations.items[0].explainIds, [901])

    const saved = readToolData(
      await client.request('tools/call', {
        name: 'editor_save_question_explanation',
        arguments: {
          questionGuid: 'question-a',
          content: '<p>更新后的讲解</p>',
          id: 902
        }
      })
    )
    assert.equal(saved.id, 902)
    assert.equal(saved.questionGuid, 'question-a')
    assert.equal(saved.persistedImmediately, true)

    const deleted = readToolData(
      await client.request('tools/call', {
        name: 'editor_delete_question_explanation',
        arguments: { explanationId: 902 }
      })
    )
    assert.equal(deleted.explanationId, 902)
    assert.equal(deleted.persistedImmediately, true)

    const emptyGuidsError = readToolError(
      await client.request('tools/call', {
        name: 'editor_get_questions',
        arguments: { guids: [] }
      })
    )
    assert.match(emptyGuidsError.error, /guids 必须是非空数组/)

    const tooManyGuidsError = readToolError(
      await client.request('tools/call', {
        name: 'editor_get_question_solutions',
        arguments: {
          guids: Array.from({ length: 51 }, (_, index) => `question-${index + 1}`)
        }
      })
    )
    assert.match(tooManyGuidsError.error, /最多处理 50 个/)

    const mappingIdError = readToolError(
      await client.request('tools/call', {
        name: 'editor_remove_catalog_question',
        arguments: { resourceMappingId: 0 }
      })
    )
    assert.match(mappingIdError.error, /resourceMappingId 必须是正整数/)

    const moveIndexError = readToolError(
      await client.request('tools/call', {
        name: 'editor_move_catalog_question',
        arguments: { resourceMappingId: 789, toIndex: -1 }
      })
    )
    assert.match(moveIndexError.error, /toIndex 必须是大于等于 0 的整数/)

    const questionGuidError = readToolError(
      await client.request('tools/call', {
        name: 'editor_save_question_explanation',
        arguments: { questionGuid: '  ', content: '<p>讲解</p>' }
      })
    )
    assert.match(questionGuidError.error, /questionGuid 不能为空/)

    const explanationContentError = readToolError(
      await client.request('tools/call', {
        name: 'editor_save_question_explanation',
        arguments: { questionGuid: 'question-a', content: '  ' }
      })
    )
    assert.match(explanationContentError.error, /content 不能为空/)

    const explanationRecordIdError = readToolError(
      await client.request('tools/call', {
        name: 'editor_delete_question_explanation',
        arguments: { explanationId: 0 }
      })
    )
    assert.match(explanationRecordIdError.error, /explanationId 必须是正整数/)

    const existingExplanationIdError = readToolError(
      await client.request('tools/call', {
        name: 'editor_save_question_explanation',
        arguments: {
          questionGuid: 'question-a',
          content: '<p>讲解</p>',
          id: 0
        }
      })
    )
    assert.match(existingExplanationIdError.error, /id 必须是正整数/)
  } finally {
    await client.close()
  }
})

test('semantic snapshot 对旧 Bridge 明确报不支持，不拼装摘要降级', async () => {
  const client = createMockClient({ SUPER_EDITOR_MOCK_SEMANTIC_SNAPSHOT_UNSUPPORTED: '1' })
  try {
    const response = await client.request('tools/call', {
      name: 'editor_export_semantic_snapshot',
      arguments: { richText: 'deep' }
    })
    const error = readToolError(response)
    assert.equal(error.errorCode, 'SEMANTIC_SNAPSHOT_UNSUPPORTED')
    assert.match(error.error, /不支持 getSemanticSnapshot.*升级到 v1\.10\.0\+/)
  } finally {
    await client.close()
  }
})

test('semantic snapshot 对部分读取结果保留诊断并明确 fullFidelity=false', async () => {
  const client = createMockClient({ SUPER_EDITOR_MOCK_SEMANTIC_SNAPSHOT_INCOMPLETE: '1' })
  try {
    const result = readToolData(
      await client.request('tools/call', {
        name: 'editor_export_semantic_snapshot',
        arguments: { richText: 'deep' }
      })
    )
    assert.equal(result.fullFidelity, false)
    assert.equal(result.completeness.complete, false)
    assert.equal(result.completeness.sections.richText, false)
    assert.equal(result.completeness.warnings[0].code, 'MOCK_SECTION_INCOMPLETE')
  } finally {
    await client.close()
  }
})

test('dirty 当前页切书必须显式保存，保存后返回目标书就绪', async () => {
  const client = createMockClient({ SUPER_EDITOR_MOCK_DIRTY: '1' })
  try {
    await client.request('initialize', { protocolVersion: '2025-06-18' })

    const rejected = readToolError(
      await client.request('tools/call', {
        name: 'editor_jump_to_book',
        arguments: { bookId: 1820651, target: 'current' }
      })
    )
    assert.match(rejected.error, /saveBeforeSwitch: true/)

    const switched = readToolData(
      await client.request('tools/call', {
        name: 'editor_jump_to_book',
        arguments: { bookId: 1820651, target: 'current', saveBeforeSwitch: true }
      })
    )
    assert.equal(switched.ready, true)
    assert.equal(switched.bridgeReady, true)
  } finally {
    await client.close()
  }
})

test('整书创作工具默认保持当前目录轻调用，整书和深读必须显式请求', async () => {
  const client = createMockClient()
  try {
    const listed = await client.request('tools/list')
    const tools = listed.result.tools
    const names = tools.map((tool) => tool.name)
    const authoringTools = [
      'editor_get_book_manifest',
      'editor_search_book_content',
      'editor_save_verified',
      'editor_list_book_versions',
      'editor_get_book_version',
      'editor_restore_book_version',
      'editor_plan_question_lesson',
      'editor_render_questions_to_block',
      'editor_audit_content'
    ]
    authoringTools.forEach((name) => assert.ok(names.includes(name), `缺少工具 ${name}`))

    const manifestTool = tools.find((tool) => tool.name === 'editor_get_book_manifest')
    assert.deepEqual(manifestTool.inputSchema.properties.scope.enum, ['current', 'book'])
    assert.deepEqual(manifestTool.inputSchema.properties.detail.enum, [
      'summary',
      'standard',
      'deep'
    ])
    assert.equal(manifestTool.inputSchema.properties.pageSize.maximum, 200)
    assert.equal(manifestTool.inputSchema.properties.include.type, 'object')
    assert.match(manifestTool.description, /默认 scope=current、detail=summary/)

    const searchTool = tools.find((tool) => tool.name === 'editor_search_book_content')
    assert.deepEqual(searchTool.inputSchema.properties.targetKinds.items.enum, [
      'element',
      'tableCell',
      'mindNode'
    ])
    assert.equal(searchTool.inputSchema.properties.detail, undefined)
    assert.equal(searchTool.inputSchema.properties.pageNo.minimum, 0)
    assert.equal(searchTool.inputSchema.properties.pageSize.minimum, 1)
    assert.equal(searchTool.inputSchema.properties.pageSize.maximum, 200)
    const auditTool = tools.find((tool) => tool.name === 'editor_audit_content')
    assert.equal(auditTool.inputSchema.properties.cursor.type, 'integer')
    assert.equal(auditTool.inputSchema.properties.cursor.minimum, 0)
    assert.equal(auditTool.inputSchema.properties.limit.maximum, 100)
    const selectSlideTool = tools.find((tool) => tool.name === 'editor_select_slide')
    assert.equal(selectSlideTool.inputSchema.properties.saveBeforeSwitch.type, 'boolean')
    assert.equal(selectSlideTool.inputSchema.properties.discardChanges.type, 'boolean')
    assert.equal(selectSlideTool.inputSchema.allOf, undefined)
    const planTool = tools.find((tool) => tool.name === 'editor_plan_question_lesson')
    const renderTool = tools.find((tool) => tool.name === 'editor_render_questions_to_block')
    assert.equal(planTool.inputSchema.properties.guids.maxItems, 50)
    assert.equal(renderTool.inputSchema.properties.guids.maxItems, 30)
    assert.ok(renderTool.inputSchema.properties.afterBlockId)
    assert.ok(renderTool.inputSchema.properties.newBlockName)

    const localManifest = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_book_manifest',
        arguments: {}
      })
    )
    assert.equal(localManifest.scope, 'current')
    assert.equal(localManifest.detail, 'summary')
    assert.equal(localManifest.pages.length, 1)
    assert.equal(localManifest.pagination.pageSize, 1)

    const bookManifest = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_book_manifest',
        arguments: {
          scope: 'book',
          detail: 'deep',
          include: { hierarchy: true, blocks: true, textPreview: true },
          pageNo: 1,
          pageSize: 10
        }
      })
    )
    assert.equal(bookManifest.scope, 'book')
    assert.equal(bookManifest.detail, 'deep')
    assert.equal(bookManifest.pagination.pageNo, 1)
    assert.equal(bookManifest.pagination.pageSize, 10)

    const localSearch = readToolData(
      await client.request('tools/call', {
        name: 'editor_search_book_content',
        arguments: { query: '一次函数' }
      })
    )
    assert.equal(localSearch.scope, 'current')
    assert.deepEqual(localSearch.targetKinds, ['element', 'tableCell', 'mindNode'])

    const pagedSearch = readToolData(
      await client.request('tools/call', {
        name: 'editor_search_book_content',
        arguments: { query: '一次函数', scope: 'book', pageNo: 2, pageSize: 25 }
      })
    )
    assert.equal(pagedSearch.pagination.pageNo, 2)
    assert.equal(pagedSearch.pagination.pageSize, 25)

    const invalidLocalPagination = readToolError(
      await client.request('tools/call', {
        name: 'editor_search_book_content',
        arguments: { query: '一次函数', scope: 'current', pageNo: 0 }
      })
    )
    assert.match(invalidLocalPagination.error, /pageNo\/pageSize 仅用于 scope=book/)

    for (const arguments_ of [
      { query: '一次函数', scope: 'book', pageNo: -1 },
      { query: '一次函数', scope: 'book', pageSize: 201 }
    ]) {
      const invalidPage = readToolError(
        await client.request('tools/call', {
          name: 'editor_search_book_content',
          arguments: arguments_
        })
      )
      assert.match(invalidPage.error, /pageNo 必须是非负整数|pageSize 必须是 1-200 的整数/)
    }

    const invalidTarget = readToolError(
      await client.request('tools/call', {
        name: 'editor_search_book_content',
        arguments: { query: '一次函数', targetKinds: ['question'] }
      })
    )
    assert.match(invalidTarget.error, /targetKinds 不支持: question/)

    const saved = readToolData(
      await client.request('tools/call', {
        name: 'editor_save_verified',
        arguments: { expectedSlideId: 'slide-1', expectedContentHash: 'mock-slide-hash-1' }
      })
    )
    assert.equal(saved.scope, 'current')
    assert.equal(saved.saved, true)
    assert.equal(saved.savedScope, 'current')
    assert.equal(saved.verified, true)
    assert.equal(saved.persistedContentHash, saved.contentHash)
    assert.equal(saved.normalizationOnly, false)
    assert.equal(saved.reconciled, false)
    assert.deepEqual(saved.businessDiffPaths, [])

    const versions = readToolData(
      await client.request('tools/call', {
        name: 'editor_list_book_versions',
        arguments: { pageNo: 0, pageSize: 10, versionPageNo: 0, versionPageSize: 5 }
      })
    )
    assert.equal(versions.scope, 'current')
    assert.equal(versions.versions[0].id, 'version-1')

    const version = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_book_version',
        arguments: { versionId: 'version-1' }
      })
    )
    assert.equal(version.versionId, 'version-1')

    const restorePreview = readToolData(
      await client.request('tools/call', {
        name: 'editor_restore_book_version',
        arguments: { versionId: 'version-1', validateOnly: true }
      })
    )
    assert.equal(restorePreview.canRestore, true)
    assert.equal(restorePreview.restored, undefined)

    const missingRestoreSlide = readToolError(
      await client.request('tools/call', {
        name: 'editor_restore_book_version',
        arguments: { versionId: 'version-1', scope: 'book', validateOnly: true }
      })
    )
    assert.match(missingRestoreSlide.error, /scope=book.*slideId/)

    const plan = readToolData(
      await client.request('tools/call', {
        name: 'editor_plan_question_lesson',
        arguments: {
          guids: [' question-a ', 'question-b'],
          layout: 'practice',
          styleReference: { templateId: 100, blockTemplateIds: [101], reuse: true }
        }
      })
    )
    assert.equal(plan.scope, 'current')
    assert.equal(plan.detail, 'summary')
    assert.equal(plan.layout, 'practice')
    assert.deepEqual(plan.guids, ['question-a', 'question-b'])
    assert.equal(plan.styleReference.reuse, true)

    const rendered = readToolData(
      await client.request('tools/call', {
        name: 'editor_render_questions_to_block',
        arguments: {
          plan,
          blockId: 'block-1',
          validateOnly: true,
          expectedSlideId: 'slide-1'
        }
      })
    )
    assert.equal(rendered.mode, 'append')
    assert.equal(rendered.valid, true)
    assert.equal(rendered.rendered, false)

    const tooManyRenderQuestions = readToolError(
      await client.request('tools/call', {
        name: 'editor_render_questions_to_block',
        arguments: {
          guids: Array.from({ length: 31 }, (_, index) => `question-${index + 1}`),
          blockId: 'block-1',
          validateOnly: true
        }
      })
    )
    assert.match(tooManyRenderQuestions.error, /最多 30 项/)

    const selectedLegacy = readToolData(
      await client.request('tools/call', {
        name: 'editor_select_slide',
        arguments: { slideId: 'slide-2' }
      })
    )
    assert.equal(selectedLegacy.slideId, 'slide-2')
    assert.equal(selectedLegacy.changed, true)
    assert.equal(selectedLegacy.dirtyAction, 'none')

    const selectedSafely = readToolData(
      await client.request('tools/call', {
        name: 'editor_select_slide',
        arguments: { slideId: 'slide-2', saveBeforeSwitch: true }
      })
    )
    assert.equal(selectedSafely.slideId, 'slide-2')
    assert.equal(selectedSafely.dirtyBefore, false)
    assert.equal(selectedSafely.dirtyAction, 'none')

    const conflictingSwitch = readToolError(
      await client.request('tools/call', {
        name: 'editor_select_slide',
        arguments: {
          slideId: 'slide-2',
          saveBeforeSwitch: true,
          discardChanges: true
        }
      })
    )
    assert.match(conflictingSwitch.error, /不能同时为 true/)

    const localAudit = readToolData(
      await client.request('tools/call', {
        name: 'editor_audit_content',
        arguments: { checks: ['structure', 'text'] }
      })
    )
    assert.equal(localAudit.scope, 'current')
    assert.equal(localAudit.cursor, 0)
    assert.equal(localAudit.limit, 1)
    assert.equal(localAudit.scannedSlides, 1)
    assert.equal(localAudit.totalSlides, 1)
    assert.equal(localAudit.nextCursor, null)
    assert.deepEqual(localAudit.sourceHashes.map((item) => item.slideId), ['slide-1'])

    const wholeBookAudit = readToolData(
      await client.request('tools/call', {
        name: 'editor_audit_content',
        arguments: {
          scope: 'book',
          slideIds: ['slide-1', 'slide-2'],
          cursor: 0,
          limit: 1,
          includeSuggestions: true
        }
      })
    )
    assert.equal(wholeBookAudit.scope, 'book')
    assert.equal(wholeBookAudit.cursor, 0)
    assert.equal(wholeBookAudit.limit, 1)
    assert.equal(wholeBookAudit.scannedSlides, 1)
    assert.equal(wholeBookAudit.totalSlides, 2)
    assert.equal(wholeBookAudit.nextCursor, 1)
    assert.deepEqual(wholeBookAudit.sourceHashes.map((item) => item.slideId), ['slide-1'])

    const nextBookAudit = readToolData(
      await client.request('tools/call', {
        name: 'editor_audit_content',
        arguments: {
          scope: 'book',
          slideIds: ['slide-1', 'slide-2'],
          cursor: wholeBookAudit.nextCursor,
          limit: 1
        }
      })
    )
    assert.equal(nextBookAudit.cursor, 1)
    assert.equal(nextBookAudit.nextCursor, null)
    assert.deepEqual(nextBookAudit.sourceHashes.map((item) => item.slideId), ['slide-2'])

    const invalidAuditCursor = readToolError(
      await client.request('tools/call', {
        name: 'editor_audit_content',
        arguments: { scope: 'book', cursor: 'next-1' }
      })
    )
    assert.match(invalidAuditCursor.error, /cursor 必须是非负整数/)

    const accidentalBookScan = readToolError(
      await client.request('tools/call', {
        name: 'editor_audit_content',
        arguments: { slideIds: ['slide-1', 'slide-2'] }
      })
    )
    assert.match(accidentalBookScan.error, /slideIds\/cursor 仅用于 scope=book/)
  } finally {
    await client.close()
  }
})

test('tools/list 保持 Codex 可机械转换的扁平 schema，并暴露高频 typed 编辑入口', async () => {
  const client = createMockClient()
  try {
    const listed = await client.request('tools/list')
    assert.equal(listed.error, undefined)
    const tools = listed.result.tools
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const forbiddenSchemaKeywords = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then']
    const inspectSchema = (schema, path) => {
      if (Array.isArray(schema)) {
        schema.forEach((item, index) => inspectSchema(item, `${path}[${index}]`))
        return
      }
      if (!schema || typeof schema !== 'object') return

      forbiddenSchemaKeywords.forEach((keyword) => {
        assert.equal(
          schema[keyword],
          undefined,
          `${path} 不能含 ${keyword}，否则 Codex 可能降级声明`
        )
      })
      if (schema.type === 'array') {
        assert.ok(
          Object.prototype.hasOwnProperty.call(schema, 'items') && schema.items,
          `${path} 的 array schema 必须声明真实 items`
        )
      }
      Object.entries(schema).forEach(([key, value]) => inspectSchema(value, `${path}.${key}`))
    }

    tools.forEach((tool) => {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} 顶层 schema 必须是 object`)
      assert.ok(tool.inputSchema.properties, `${tool.name} 必须声明 properties`)
      inspectSchema(tool.inputSchema, tool.name)
      assert.match(tool.description, /^\[[^\]]+\] /, `${tool.name} 缺少持久化边界标签`)
    })
    assert.match(byName.get('editor_get_state').description, /^\[只读\]/)
    assert.match(
      byName.get('editor_move_element').description,
      /^\[工作副本写入\|需 saveVerified\|可 checkpoint\]/
    )
    assert.match(
      byName.get('editor_create_book').description,
      /^\[立即写库\|checkpoint不可恢复\]/
    )
    assert.match(byName.get('editor_apply_template').description, /^\[按 kind：/)
    assert.match(byName.get('editor_batch').description, /^\[高级混合调用\|非事务/)
    assert.match(byName.get('editor_batch').description, /不是事务.*禁止.*screenshot/s)
    assert.match(byName.get('editor_save').description, /旧版保存入口.*editor_save_verified/)
    const copyDigitalModule = byName.get('editor_copy_digital_module')
    assert.equal(copyDigitalModule.inputSchema.properties.replaceExisting, undefined)
    assert.match(copyDigitalModule.description, /始终安全拒绝.*不是原子事务/)
    assert.match(byName.get('editor_connect').description, /^\[连接状态\|不写库\]/)
    assert.match(
      byName.get('editor_jump_to_book').description,
      /^\[导航\|改变编辑器上下文\|不写库\]/
    )
    assert.match(
      byName.get('editor_jump_to_book').description,
      /ai_control=1.*#\/content-editor.*不得拼在 hash 前/
    )
    assert.match(
      byName.get('editor_jump_to_book').description,
      /原 RPC 实例.*contextEpoch.*完整刷新.*同一 windowId/
    )
    assert.match(
      byName.get('editor_jump_to_book').description,
      /contentReady=true.*emptyBook.*currentSlidePlaceholder=true/
    )
    assert.match(
      byName.get('editor_jump_to_book').description,
      /排除.*旧 instanceId.*同一 windowId 的新实例/
    )
    assert.match(
      byName.get('editor_jump_to_book').inputSchema.properties.target.description,
      /优先原实例热切书.*完整刷新兜底/
    )
    assert.match(byName.get('editor_checkpoint').description, /^\[会话内快照\|不写库\]/)
    assert.match(byName.get('editor_clear_checkpoints').description, /^\[会话内快照\|不写库\]/)
    assert.match(byName.get('editor_set_zoom').description, /^\[仅视图状态\|不写库\]/)
    assert.match(byName.get('editor_undo').description, /已禁用/)
    assert.match(byName.get('editor_redo').description, /已禁用/)

    const searchTemplates = byName.get('editor_search_templates').inputSchema
    assert.deepEqual(searchTemplates.properties.scope.enum, ['book', 'center'])
    assert.deepEqual(searchTemplates.properties.interactionType.enum, [
      'hypermedia',
      'interface'
    ])
    assert.equal(searchTemplates.properties.pageNo.minimum, 0)
    assert.equal(searchTemplates.properties.pageSize.minimum, 1)
    assert.equal(searchTemplates.properties.pageSize.maximum, 100)

    const centerTemplates = readToolData(
      await client.request('tools/call', {
        name: 'editor_search_templates',
        arguments: {
          scope: 'center',
          kind: 'chapter',
          interactionType: 'interface',
          query: '作文不难'
        }
      })
    )
    assert.equal(centerTemplates[0].scope, 'center')
    assert.equal(centerTemplates[0].suitType, 2)
    assert.equal(centerTemplates[0].interactionType, 'interface')

    const centerTemplateDetail = readToolData(
      await client.request('tools/call', {
        name: 'editor_get_template',
        arguments: { templateId: centerTemplates[0].id }
      })
    )
    assert.equal(centerTemplateDetail.id, centerTemplates[0].id)
    assert.equal(centerTemplateDetail.kind, 'chapter')
    assert.equal(centerTemplateDetail.interactionType, 'interface')

    const appliedCenterTemplate = readToolData(
      await client.request('tools/call', {
        name: 'editor_apply_template',
        arguments: {
          kind: 'chapter',
          templateId: centerTemplates[0].id,
          name: '模板中心样章目录',
          discardChanges: true
        }
      })
    )
    assert.match(appliedCenterTemplate.slideId, /^mock-slide-/)

    const missingCenterInteractionType = readToolError(
      await client.request('tools/call', {
        name: 'editor_search_templates',
        arguments: { scope: 'center', kind: 'chapter' }
      })
    )
    assert.match(missingCenterInteractionType.error, /必须指定 interactionType/)

    const typedNames = [
      'editor_add_slide',
      'editor_delete_slide',
      'editor_move_slide',
      'editor_move_block',
      'editor_replace_block',
      'editor_replace_block_safe',
      'editor_copy_block_to_slide',
      'editor_replace_element_safe',
      'editor_move_element',
      'editor_move_elements',
      'editor_resize_element',
      'editor_rotate_element',
      'editor_set_element_spacing',
      'editor_center_element_in_block',
      'editor_duplicate_elements',
      'editor_get_elements_bounds',
      'editor_get_canvas_info',
      'editor_set_canvas_type',
      'editor_scroll_to_block',
      'editor_scroll_to_element',
      'editor_set_zoom',
      'editor_fit_canvas'
    ]
    typedNames.forEach((name) => assert.ok(byName.has(name), `缺少 typed 工具 ${name}`))
    assert.deepEqual(
      byName.get('editor_align_elements').inputSchema.properties.target.enum,
      ['selection', 'block', 'page']
    )
    assert.deepEqual(
      byName.get('editor_align_elements').inputSchema.properties.coordinateSpace.enum,
      ['block', 'page']
    )
    assert.deepEqual(
      byName.get('editor_get_elements_bounds').inputSchema.properties.coordinateSpace.enum,
      ['block', 'page']
    )
    const duplicateElementIds = byName.get('editor_duplicate_elements').inputSchema.properties.elementIds
    assert.equal(duplicateElementIds.minItems, 1)
    assert.equal(duplicateElementIds.uniqueItems, true)
    assert.equal(duplicateElementIds.items.minLength, 1)

    const textDocument = byName.get('editor_text_document').inputSchema
    assert.ok(textDocument.properties.elementId)
    assert.ok(textDocument.properties.target)
    assert.equal(textDocument.oneOf, undefined)

    const renderQuestions = byName.get('editor_render_questions_to_block').inputSchema
    assert.ok(renderQuestions.properties.plan)
    assert.ok(renderQuestions.properties.guids)
    assert.equal(renderQuestions.anyOf, undefined)

    const batchArgs = byName.get('editor_batch').inputSchema.properties.steps.items.properties.args
    assert.deepEqual(batchArgs.items.type, [
      'object',
      'array',
      'string',
      'number',
      'boolean',
      'null'
    ])
    const rpcArgs = byName.get('editor_rpc_call').inputSchema.properties.args
    assert.deepEqual(rpcArgs.items.type, batchArgs.items.type)
    const importBlocks = byName.get('editor_import_blocks').inputSchema.properties.blocks
    assert.equal(importBlocks.items.type, 'object')
    assert.equal(importBlocks.items.additionalProperties, true)

    const setLink = byName.get('editor_text_set_link').inputSchema
    assert.deepEqual(
      setLink.properties.hyperlink.properties.agent_params.items.type,
      ['object', 'array', 'string', 'number', 'boolean', 'null']
    )

    const successfulCalls = [
      ['editor_move_element', { elementId: 'el-1', x: 10, y: 20 }],
      ['editor_move_elements', { elementIds: ['el-1', 'el-2'], x: 10, y: 20 }],
      ['editor_resize_element', { elementId: 'el-1', width: 120, height: 60 }],
      ['editor_rotate_element', { elementId: 'el-1', angle: 15 }],
      [
        'editor_set_element_spacing',
        { elementIds: ['el-1', 'el-2'], direction: 'horizontal', spacing: 24 }
      ],
      ['editor_center_element_in_block', { elementId: 'el-1', axis: 'both' }],
      [
        'editor_align_elements',
        {
          elementIds: ['el-1', 'el-2'],
          align: 'vertical',
          target: 'selection',
          coordinateSpace: 'page'
        }
      ],
      [
        'editor_get_elements_bounds',
        { elementIds: ['el-1', 'el-2'], coordinateSpace: 'page' }
      ],
      ['editor_get_canvas_info', {}],
      ['editor_set_canvas_type', { canvasType: 'phone' }],
      ['editor_scroll_to_block', { blockId: 'block-1' }],
      ['editor_scroll_to_element', { elementId: 'el-1' }],
      ['editor_set_zoom', { scale: 1.25 }],
      ['editor_fit_canvas', {}],
      [
        'editor_apply_template',
        { kind: 'chapter', templateId: 100, discardChanges: true }
      ],
      ['editor_add_slide', { name: '新目录', templateId: 100, saveBeforeSwitch: true }],
      ['editor_delete_slide', { slideId: 'slide-2' }],
      ['editor_move_slide', { slideId: 'slide-2', toIndex: 0 }],
      ['editor_move_block', { blockId: 'block-1', toIndex: 0 }],
      ['editor_replace_block', { blockId: 'block-1', templateData: { template_type: 2 } }],
      [
        'editor_replace_block_safe',
        { blockId: 'block-1', templateData: { uuid: 'block-1', id: 1, template_type: 2 } }
      ],
      [
        'editor_replace_element_safe',
        { elementId: 'el-1', elementData: { id: 'el-1', type: 'text' } }
      ],
      [
        'editor_copy_block_to_slide',
        { blockId: 'block-1', targetSlideId: 'slide-2', index: 0 }
      ],
      [
        'editor_import_blocks',
        { slideId: 'slide-2', blocks: [{ template_type: 2 }], discardChanges: true }
      ]
    ]
    const successfulResults = new Map()
    for (const [name, argumentsValue] of successfulCalls) {
      successfulResults.set(
        name,
        readToolData(
          await client.request('tools/call', { name, arguments: argumentsValue })
        )
      )
    }
    const missingAutoCanvasWidth = readToolError(
      await client.request('tools/call', {
        name: 'editor_set_canvas_type',
        arguments: { canvasType: 'auto' }
      })
    )
    assert.match(missingAutoCanvasWidth.error, /width 必须是正整数/)
    const fixedCanvasWithWidth = readToolError(
      await client.request('tools/call', {
        name: 'editor_set_canvas_type',
        arguments: { canvasType: 'phone', width: 375 }
      })
    )
    assert.match(fixedCanvasWithWidth.error, /固定画布类型不接受 width/)
    const missingSafeHash = readToolError(
      await client.request('tools/call', {
        name: 'editor_replace_element_safe',
        arguments: {
          elementId: 'el-1',
          elementData: { id: 'el-1', type: 'text' },
          dryRun: false
        }
      })
    )
    assert.match(missingSafeHash.error, /expectedHash/)
    assert.deepEqual(successfulResults.get('editor_move_element'), {
      elementCount: 1,
      x: 10,
      y: 20,
      dx: 0,
      dy: 0,
      coordinateSpace: 'block'
    })
    const successfulCallLog = readToolData(
      await client.request('tools/call', {
        name: 'editor_rpc_call',
        arguments: { method: 'getMockCallLog', args: [] }
      })
    )
    assert.ok(
      successfulCallLog.some(
        (call) =>
          call.method === 'moveElement' &&
          JSON.stringify(call.args) ===
            JSON.stringify([{ elementId: 'el-1', x: 10, y: 20 }])
      ),
      'editor_move_element 应调用支持组内子元素的单元素 Bridge 方法'
    )
    assert.equal(successfulResults.get('editor_move_elements').coordinateSpace, 'block')
    assert.equal(successfulResults.get('editor_set_element_spacing').coordinateSpace, 'block')
    assert.equal(successfulResults.get('editor_center_element_in_block').blockId, 'block-1')
    assert.deepEqual(successfulResults.get('editor_align_elements'), {
      align: 'vertical',
      target: 'selection',
      elementCount: 2,
      coordinateSpace: 'page'
    })
    assert.equal(successfulResults.get('editor_get_elements_bounds').coordinateSpace, 'page')
    assert.equal(successfulResults.get('editor_get_canvas_info').canvasWidth, 794)
    assert.deepEqual(
      {
        canvasType: successfulResults.get('editor_set_canvas_type').canvasType,
        canvasWidth: successfulResults.get('editor_set_canvas_type').canvasWidth,
        syncedBlockIds: successfulResults.get('editor_set_canvas_type').syncedBlockIds
      },
      { canvasType: 'phone', canvasWidth: 375, syncedBlockIds: ['block-1'] }
    )
    assert.ok(
      successfulCallLog.some(
        (call) =>
          call.method === 'setCanvasType' &&
          JSON.stringify(call.args) === JSON.stringify([{ canvasType: 'phone' }])
      ),
      'editor_set_canvas_type 应调用页面级画布 Bridge 方法'
    )
    assert.match(successfulResults.get('editor_apply_template').slideId, /^mock-slide-/)
    assert.equal(
      successfulResults.get('editor_import_blocks').args[2].discardChanges,
      true
    )

    const screenshotBatch = readToolError(
      await client.request('tools/call', {
        name: 'editor_batch',
        arguments: { steps: [{ method: 'screenshot', args: [] }] }
      })
    )
    assert.match(screenshotBatch.error, /禁止截图步骤.*editor_screenshot/)

    const malformedBatchArgs = readToolError(
      await client.request('tools/call', {
        name: 'editor_batch',
        arguments: { steps: [{ method: 'getState', args: { detail: true } }] }
      })
    )
    assert.match(malformedBatchArgs.error, /args 必须是 JSON 参数数组/)

    const malformedRpcArgs = readToolError(
      await client.request('tools/call', {
        name: 'editor_rpc_call',
        arguments: { method: 'getState', args: { detail: true } }
      })
    )
    assert.match(malformedRpcArgs.error, /args 必须是 JSON 参数数组/)

    const invalidImageSource = readToolError(
      await client.request('tools/call', {
        name: 'editor_apply_image',
        arguments: {
          imageId: 1,
          url: 'https://mock.example.com/image.png',
          blockId: 'block-1'
        }
      })
    )
    assert.match(invalidImageSource.error, /必须且只能提供 imageId \/ url 之一/)

    const invalidPatch = readToolError(
      await client.request('tools/call', {
        name: 'editor_update_element',
        arguments: { elementId: 'el-1', patch: {} }
      })
    )
    assert.match(invalidPatch.error, /patch 不能为空对象/)

    const irrelevantBlockSwitchFlags = readToolError(
      await client.request('tools/call', {
        name: 'editor_apply_template',
        arguments: {
          kind: 'block',
          templateId: 100,
          saveBeforeSwitch: true
        }
      })
    )
    assert.match(irrelevantBlockSwitchFlags.error, /仅适用于 chapter/)

    const unsupportedCopyReplacement = readToolError(
      await client.request('tools/call', {
        name: 'editor_copy_digital_module',
        arguments: {
          sourceElementId: 'source-el',
          targetElementId: 'target-el',
          replaceExisting: true
        }
      })
    )
    assert.match(unsupportedCopyReplacement.error, /不支持 replaceExisting/)
  } finally {
    await client.close()
  }
})

test('typed 切页工具在 dirty 页先 saveVerified 回读，再执行 Bridge 切页', async () => {
  const scenarios = [
    {
      tool: 'editor_select_slide',
      bridgeMethod: 'selectSlide',
      arguments: { slideId: 'slide-2', saveBeforeSwitch: true }
    },
    {
      tool: 'editor_add_slide',
      bridgeMethod: 'addSlide',
      arguments: { name: '新目录', templateId: 100, saveBeforeSwitch: true }
    },
    {
      tool: 'editor_delete_slide',
      bridgeMethod: 'deleteSlide',
      arguments: { slideId: 'slide-1', saveBeforeSwitch: true }
    },
    {
      tool: 'editor_import_blocks',
      bridgeMethod: 'importBlocks',
      arguments: {
        slideId: 'slide-2',
        blocks: [{ template_type: 2 }],
        saveBeforeSwitch: true
      }
    },
    {
      tool: 'editor_apply_template',
      bridgeMethod: 'applyTemplate',
      arguments: { kind: 'chapter', templateId: 100, saveBeforeSwitch: true }
    },
    {
      tool: 'editor_render_questions_to_block',
      bridgeMethod: 'renderQuestionsToBlock',
      arguments: {
        guids: ['question-a'],
        slideId: 'slide-2',
        blockId: 'block-1',
        validateOnly: true,
        saveBeforeSwitch: true
      }
    }
  ]

  for (const scenario of scenarios) {
    const client = createMockClient({ SUPER_EDITOR_MOCK_DIRTY: '1' })
    try {
      readToolData(
        await client.request('tools/call', {
          name: scenario.tool,
          arguments: scenario.arguments
        })
      )
      const calls = readToolData(
        await client.request('tools/call', {
          name: 'editor_rpc_call',
          arguments: { method: 'getMockCallLog', args: [] }
        })
      )
      const stateIndex = calls.findIndex((call) => call.method === 'getState')
      const saveIndexes = calls
        .map((call, index) => (call.method === 'saveVerified' ? index : -1))
        .filter((index) => index >= 0)
      const businessIndex = calls.findIndex((call) => call.method === scenario.bridgeMethod)
      assert.ok(stateIndex >= 0, `${scenario.tool} 未读取 dirty 状态`)
      assert.deepEqual(saveIndexes.length, 1, `${scenario.tool} 应且只应 saveVerified 一次`)
      assert.ok(stateIndex < saveIndexes[0], `${scenario.tool} 必须先读状态再保存`)
      assert.ok(saveIndexes[0] < businessIndex, `${scenario.tool} 必须保存回读后再切页`)
      assert.deepEqual(calls[saveIndexes[0]].args, [
        { scope: 'current', verify: true, expectedSlideId: 'slide-1' }
      ])
    } finally {
      await client.close()
    }
  }

  const nonCurrentDeleteClient = createMockClient({ SUPER_EDITOR_MOCK_DIRTY: '1' })
  try {
    readToolData(
      await nonCurrentDeleteClient.request('tools/call', {
        name: 'editor_delete_slide',
        arguments: { slideId: 'slide-2', saveBeforeSwitch: true }
      })
    )
    const calls = readToolData(
      await nonCurrentDeleteClient.request('tools/call', {
        name: 'editor_rpc_call',
        arguments: { method: 'getMockCallLog', args: [] }
      })
    )
    assert.equal(calls.some((call) => call.method === 'saveVerified'), false)
  } finally {
    await nonCurrentDeleteClient.close()
  }
})
