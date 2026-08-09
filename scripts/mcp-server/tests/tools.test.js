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
    assert.equal(initialized.result.serverInfo.version, '0.8.0')

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
    assert.equal(selectSlideTool.inputSchema.allOf[0].not.properties.saveBeforeSwitch.const, true)
    assert.equal(selectSlideTool.inputSchema.allOf[0].not.properties.discardChanges.const, true)
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
    assert.equal(selectedSafely.dirtyAction, 'saved')

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
