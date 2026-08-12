# window.__superEditor 桥接 API 契约（v1.12.0）

本文档定义 super-editor 编辑器侧需要实现的桥接层接口，供 Codex 通过浏览器控制编辑器（本插件 skill / MCP 的调用依据）。

v1.12.0 新增保留身份的区块/元素树安全替换：先 dry-run 取得字段差异与 `expectedHash`，正式写入时
强制保持 block/element id、元素类型、父子关系和顺序不变。数字模块以 element id 为关联锚点，任何
身份变化都在首个写入前拒绝。

v1.11.0 放开单个组内子元素的直接移动：子元素 `left/top` 始终使用所属区块局部坐标，`moveElement`
可递归定位目标并保持 owner bounds 预检；批量移动、对齐和间距仍保留顶层元素约束。

v1.10.0 新增只读 `getSemanticSnapshot`，用于冻结当前书本内当前或指定普通目录的完整可编辑语义
快照；保留原始区块/元素、定位索引、大纲、normalized+raw 数字模块、字体、可选富文本及上下文
一致性信息，不切页、不跨书、不写业务库。v1.9.0 新增的同页原子热切书以及
`contextEpoch` / `bookSwitching` 状态继续保持。MCP 仍兼容
v1.8.2 的完整刷新式 `jumpToBook(target=current)`；旧 Bridge 不需要为了继续使用立即升级。

## 1. 启用与挂载

- 仅在用户开启编辑器顶部“AI 控制”按钮时挂载 `window.__superEditor`，关闭按钮时卸载。
- 建议页面加载完成后（`mounted` 之后）挂载，路由销毁时移除：`delete window.__superEditor`。
- 提供一个 `window.__superEditor.disable()` 以便随时摘除。

## 2. 调用约定

- 所有方法返回 `Promise`；内部实现必须走 Vuex mutation/action（与用户 UI 操作同一条链路），保留操作日志。
- **AI 控制开启时不写撤销/重做操作栈**（编辑器的 `commonDataUndo` 在该模式下不再入栈），回退一律用 §4.4 的整页深拷贝快照 `checkpoint()` / `rollback()`；关闭 AI 控制时默认编辑器行为完全不变。
- 参数一律为普通对象/数组/基本类型；返回值一律可 JSON 序列化（不要返回 Vue 实例、DOM 节点、函数）。
- 每个写操作完成后 `await this.$nextTick()`，保证调用方随后截图/读状态时拿到最新渲染。
- 读操作返回“深拷贝”后的数据，避免调用方改动污染编辑器状态。

## 3. 数据形状（关键字段）

层级：`画布(slide) -> 区块(block/template) -> 打组(group) -> 元素(element)`

```js
// slide 关键字段
{ id, name, book_id, parent_id, page_id?, natural_code?, manual_code? }

// block 关键字段
{
  id,   // 后端内容 id；数字模块的 hypermedia_content_id 必须使用它
  uuid, // 画布区块 id；元素 templateId、布局和区块操作使用它
  name,
  template_data_content: {
    size: { width, height },
    paddingTop, paddingBottom,
    elements: [ ... ]  // 本区块元素（含 group 容器）
  }
}

// element 关键字段（详见《元素结构说明文档》）
{ id, type, templateId /*=所属区块uuid*/, groupId /*=父组id，表层为0*/, child_list?, ...业务字段 }

// getState() 返回
{
  bookInfo: { id, name, smart_book_type },
  bookId,              // 与 bookInfo.id 一致，便于原子核对上下文
  contextEpoch,        // 页面生命周期内单调递增的书本上下文版本
  bookSwitching,       // 热切准备/提交期间为 true，完成或失败后恢复 false
  slides: [ { id, name, pageId } ],
  currentSlideId,
  contentReady,              // 普通目录内容已完成加载；允许内容数组为空但加载状态必须明确
  currentSlidePlaceholder,   // 当前目录是 PDF 占位目录，无普通画布内容
  emptyBook,                 // 目标书没有任何可选目录
  selection: [ elementId ],
  dirty: Boolean
}

// getSlide(slideId) 返回
{
  slide: { id, name, pageId },
  blocks: [ { uuid, name, size: { width, height }, elements: [ element ] } ]
}
```

> `id` 与 `uuid` 不可互换。数字模块桥接只接收 `elementId`，由桥接在当前页元素树中找到
> 所属模板并读取模板后端 `id`；不得让调用方填写 `hypermedia_content_id`，更不得把 `uuid`
> 转成数字后提交。`getSlide` 是规范化的页面内容快照，区块项不承诺返回后端 `id`；需要后端内容 id 时
> 使用 `getBlock` / `listBlocks` 的 `backendId`（同值也以 `hypermediaContentId` 暴露），不要从 `uuid` 推导。

## 4. 方法清单

### 状态与查询

| 方法 | 参数 | 返回 |
|------|------|------|
| `ping()` | 无 | `{ version, editorType, bookId, mode, instanceId, windowId, contextEpoch, bookSwitching }` |
| `getState()` | 无 | 见上 |
| `listSlides()` | 无 | `[{ id, name, pageId }]` |
| `getUserInfo(payload?)` | `{ refresh? }` | 当前登录用户信息；优先读 Vuex，缺失或 refresh 时请求账号接口 |
| `searchBooks(payload)` | `{ query?, bookType?=6, smartBookType?, subjectId?, gradeId?, period?, volume?, pageNo?, pageSize?, filters? }` | `smartBookType` 兼容 1..4 数值、数字字符串和中文交互类型名；返回 `{ items, pageNo, pageSize, total, paginator }`，结果补充 `smart_book_type_name` |
| `getBookInfo(payload)` | `{ bookId }` | `getbookinfo` 完整书本属性、学科、关联教材、分类和版本信息 |
| `getBookManifest(payload?)` | `{ scope?: current/book, detail?: summary/standard/deep, slideId?, include?: { hierarchy?, blocks?, textPreview?, content? }, pageNo?, pageSize? }` | 目录层级、分页页面摘要、区块/元素/富文本统计、内容 hash 和 warnings；默认 current+summary，book 默认每页 40、上限 200 |
| `searchBookContent(payload)` | `{ query, scope?: current/book, slideId?, pageNo? >= 0, pageSize?: 1..200, targetKinds?: [element/tableCell/mindNode], caseSensitive?, wholeWord?, useRegex?, limit? }` | 跨普通文本、表格单元格和思维导图节点的稳定范围命中；默认只搜当前目录，book 必须显式指定，并可按目录分页 |
| `listBookVersions(payload?)` | `{ scope?: current/book, slideId?, pageNo?, pageSize?, versionPageNo?, versionPageSize? }` | current 时分页当前目录版本；book 时 page 分页目录、versionPage 分页每目录版本，返回 `pages/versions/pagination/warnings` |
| `getBookVersion(payload)` | `{ versionId, scope?: current/book, slideId? }` | 以版本记录 `log_id` 读取完整区块、contentHash 和 blockCount |
| `auditContent(payload?)` | `{ scope?: current/book, slideId?, slideIds?, checks?: [structure/text/resources/layout], cursor?: integer >= 0, limit?: 1..100, includeSuggestions? }` | 只读问题清单、稳定 issue id/sourceHash、严重级别统计和 nextCursor；默认仅当前目录，book 使用数值偏移分页扫描 |
| `buildBookEditorUrl(payload)` | `{ bookId, includeToken?=false }` | 继承当前编辑器环境的目标书本 URL；`book_id/business_id/Scope/token/ai_control` 只写入 `#/content-editor` 后的路由查询串，删除外层重复参数和旧 `catalog_id` |
| `jumpToBook(payload)` | `{ bookId, target?: url/current/new, includeToken? }` | current 热切成功返回 `{ bookId, url, target: 'current', hotSwitched: true, reloadScheduled: false, contextEpoch }`；不支持热切或安全回滚失败时可返回 `{ scheduled: true, reloadScheduled: true }` 并完整刷新。MCP 只发送一次命令；热切时等待同一 `instanceId` 的目标 epoch、非切换中状态及内容就绪，刷新兜底不沿用旧实例 epoch，并排除初始 `instanceId`，只按同一 `windowId` 接回真正的新实例 |
| `createBookFromSource(payload)` | `{ sourceBookId, copyMode?: light/full, name?, backgroundName?, smartBookType?, coverImgId?, coverImgUrl?, coverType?, includeToken? }` | 默认 light 只继承外部属性；full 复制目录和内容。返回 `{ sourceBookId, bookId, copyMode, includesCatalogAndContent, cloneMethod, book, editorUrl }` |
| `searchTemplates(payload)` | `{ scope?: book/center, kind?: chapter/block, interactionType?: hypermedia/interface, query?, pageNo?, pageSize?, classifyId?, parentId?, timeSort? }` | 本书或模板中心可用模板 `[{ id, name, type, kind, scope, suitType, interactionType, parentId, classifyId, classifyIds, cover, updatedAt }]`；`center` 不注入当前 `book_id` 且必须指定交互类型（分别映射 `suit_type=1/2`） |
| `listTemplates(payload)` | 同 `searchTemplates` | `searchTemplates` 兼容别名 |
| `getTemplateDetail(payload)` | `{ templateId, parseContent? }` | 根据本书或模板中心的模板 id 返回 `{ id, name, type, kind, suitType, interactionType, bookId, parentId, classifyIds, cover, content, childList, lines }` |
| `searchComponents(payload)` | `{ query?, scope?: all/system/mine, classifyType?, classifyId?, limit?, includeContent? }` | 可用组件元数据；默认不返回大体积 content |
| `searchImageLibrary(payload)` | `{ query?, scope?: book/global/all, groupId?, bookId?, limit? }` | 图片素材 `[{ id, name, url, format, width, height, groupId, groupName, scope }]` |
| `listDigitalModuleTypes(payload?)` | `{ type? }` | 数字模块类型、支持状态、默认值、配置字段和资源依赖 |
| `getDigitalModule(payload)` | `{ elementId, includeRaw? }` | 元素当前关联模块；没有时返回 `null` |
| `listDigitalModules(payload?)` | `{ elementIds?, type?, includeEmpty? }` | 批量读取当前页元素的数字模块关系 |
| `listQuestionPaths(payload?)` | `{ bookId?, flatten?=true }` | `{ bookId, flatten, items 或 tree, total, isPartial }`；扁平节点含 `id/name/parentId/depth/pathName` |
| `getQuestionSearchOptions(payload?)` | `{ bookId?, refresh? }` | 学段、学科、年级、册次、难度、题型及高级筛选字典 |
| `searchQuestions(payload?)` | `{ scope?: currentCatalog/currentBookResources/learningPath/book/global, query?, bookId?, catalogId?, pathId?, quesScope?, pageNo?, pageSize?, ...筛选, includeRaw? }` | `{ items, scope, pageNo, pageSize, total, isPartial, ... }`；`book` 是 `learningPath` 兼容别名 |
| `getQuestions(payload)` | `{ guids, includeRaw?, includeDiagnostics?/returnEnvelope? }` | 默认返回详情数组；诊断模式返回 `{ items, requestedGuids, uniqueGuids, foundGuids, missingGuids, duplicateGuids }`，不返回 `warnings` |
| `validateQuestionSelection(payload)` | `{ guids, targetModuleType, config? }` | 题数、缺失、重复、父子冲突、答案/题解与模块配置兼容性诊断 |
| `getQuestionSolutions(payload)` | `{ guids, includeRaw? }` | `{ items, requestedGuids, missingGuids }` |
| `getQuestionExplanations(payload)` | `{ guids, includeRaw? }` | 按 GUID 分组的已保存题目 AI 讲解记录 |
| `getQuestionExplanationStatus(payload)` | `{ guids, bookId?, includeResults? }` | 单次查询每题异步生成状态；可附已完成结果 |
| `getSlide(slideId)` | string | 见上 |
| `getBlock(blockId)` | string | `{ blockId, backendId, hypermediaContentId, name, size, elements }`（单区块含元素树） |
| `getElement(elementId)` | string | 元素完整数据，并补充 `{ blockId, blockBackendId, hypermediaContentId }` |
| `listElements(filter?)` | `{ blockId?, type? }` | 扁平元素列表 `[{ id, name, type, left, top, width, height, blockId, blockBackendId }]` |
| `findElements(filter?)` | 同 `listElements` | 同 `listElements`（别名） |
| `getCanvasTree()` | 无 | 整页结构化树：`{ slide, blocks: [{ blockId, backendId, index, name, size, elementCount, elements }], stats: { blockCount, elementCount, typeCounts } }`（AI 理解画布首选） |
| `getSlideStats()` | 无 | `{ blockCount, elementCount, typeCounts, wordCount }` |
| `listBlocks()` | 无 | `[{ blockId, backendId, index, name, size, elementCount }]` |
| `getBlockIndex(blockId)` | string | 区块在当前页原始下标 |
| `searchElements(filter?)` | `{ keyword?, type?, blockId? }` | 按名称/内容/类型搜索 `[{ id, name, type, left, top, width, height, blockId, inGroup }]` |
| `getElementsBounds(elementIds, options?)` | `(string[]（顶层元素）, { coordinateSpace?: block/page })`；默认 `block` | `{ minX, minY, maxX, maxY, width, height, centerX, centerY, coordinateSpace }`；`block` 只接受同一 owner 区块，`page` 可跨区块并使用 `blockTemplateListTopMap` 换算整页 Y |
| `getHistoryState()` | 无 | `{ canUndo: false, canRedo: false, undoDisabled: true, reason, checkpointCount, checkpoints: [{ checkpointId, slideId, label, time }] }` |
| `listElementTypes()` | 无 | `[{ type, name, defaultWidth, defaultHeight }]`（全部元素类型） |
| `getElementSchema(type)` | string | `{ type, typeName, defaults, commonProps, typeProps }`（该类型默认结构与可设置字段） |
| `isDirty()` | 无 | `Boolean` |

### 页面（slide）

| 方法 | 参数 | 返回 |
|------|------|------|
| `selectSlide(slideIdOrOptions)` | `slideId` 标量，或 `{ slideId, saveBeforeSwitch?, discardChanges? }`；两个安全选项不能同时为 true | `{ slideId, previousSlideId, changed, dirtyBefore, dirtyAction }`；切到其他页且当前页 dirty 时必须明确保存或丢弃，切到当前页不处理 dirty |
| `addSlide(payload)` | `{ name?, parentId?, template_id?, type?, saveBeforeSwitch?, discardChanges? }`（不传 template_id 时自动复用/创建空白样章模板） | `{ slideId }`；创建前先校验 dirty 处理意图，再写入目录并安全切到新页 |
| `applyTemplate(payload)` | `{ kind: chapter/block, templateId, name?, parentId?, index?, afterBlockId?, saveBeforeSwitch?, discardChanges? }` | 样章委托 `addSlide` 并返回 `{ slideId }`；区块模板只写当前页并返回 `{ templateId, blockId }` |
| `deleteSlide(slideIdOrOptions)` | `slideId` 标量，或 `{ slideId, saveBeforeSwitch?, discardChanges? }` | 无；删除当前 dirty 页时必须显式选择保存或丢弃，删除非当前页不切页 |
| `renameSlide(slideId, name)` | (string, string) | 无（目录重命名，即时生效） |
| `duplicateSlide(slideId)` | string | `{ slideId }`（服务端复制整页含内容） |
| `getSlideMenu()` | 无 | 目录树（当前 store 内的书本目录） |
| `refreshSlideMenu()` | 无 | 无（重新拉取目录） |
| `moveSlide(payload)` | `{ slideId, toIndex }`（同级排序） | 无 |

### 区块（block）

| 方法 | 参数 | 返回 |
|------|------|------|
| `addBlock(payload)` | `{ afterBlockId?, size? }` | `{ blockId }` |
| `cloneBlock(blockId, opts?)` | `(uuid, { afterBlockId?, name? })` | `{ blockId }`（新区块 uuid 和全部 element id 自动重生成） |
| `updateBlock(payload)` | `{ blockId, patch }`（patch 支持 `name`、`size` 等） | 无 |
| `deleteBlock(blockId)` | string | 无 |
| `moveBlock(payload)` | `{ blockId, toIndex }` | 无 |
| `insertBlocks(blocks, opts?)` | `(模板数组, { index? })` | `{ blockIds }`（批量插入，uuid 自动重新生成，元素 id 冲突自动替换） |
| `importBlocks(slideId, blocks, opts?)` | `(string, 模板数组, { index?, saveBeforeSwitch?, discardChanges? })` | `{ slideId, blockIds }`；目标不是当前页时先按 dirty 安全选项切换，再插入 |
| `replaceBlock(blockId, templateData)` | (string, 模板对象) | `{ blockId }`；整体替换内容并保持目标位置与原 block uuid，保留传入 element id；写前拒绝模板内部重复 id 及与其他区块的 id 冲突 |
| `replaceBlockSafe(payload)` | `{ blockId, templateData, dryRun?, expectedHash?, allowedPaths?, maxChangedPaths? }` | 保留身份的完整 JSON 原位替换；默认 dry-run，正式写入必须回传 `expectedHash`；强制保持前端 uuid、后端区块 id、全部 element id/类型/父子关系/顺序/templateId/groupId 不变，返回差异路径和 `digitalModuleAnchorsPreserved: true` |
| `renameBlock(blockId, name)` | (string, string) | 无 |
| `copyBlockToSlide(blockId, targetSlideId, opts?)` | `(string, string, { index?, saveBeforeSwitch?, discardChanges? })` | `{ slideId, blockIds }`；跨页复制 dirty 源页只允许先保存，明确拒绝一边复制未保存源内容一边丢弃 |
| `insertTemplate(templateData, index?)` | 模板结构对象 + 插入位置（省略追加末尾） | `{ blockId }`；作为**新区块**插入，统一重建 block uuid 和全部 element id，并同步子级 groupId/templateId，不保留源 id |
| `applyComponent(payload)` | `{ componentId, blockId, scope?, left?, top? }` | `{ componentId, elementIds }`（自动换 id、定位并记录使用历史） |

> **dirty 安全边界**：`selectSlide`、`addSlide`、删除当前页、跨页 `importBlocks`、
> `applyTemplate(kind=chapter)`、跨页 `copyBlockToSlide` 和跨页 `replaceSlideContent` 都复用安全切页链。dirty 时省略两个选项会在任何
> 目录/画布写入前拒绝，同时传入也会拒绝；`discardChanges` 必须来自明确意图。插件 typed MCP 在
> `saveBeforeSwitch=true` 时会先调用 `saveVerified(scope=current, verify=true, expectedSlideId)` 保存并回读，
> 再调用 Bridge。直接调用 Bridge 若也要求服务端回读，应先显式 `saveVerified`，不要把 legacy `save()`
> 当作已验证保存。删除当前页时丢弃动作延迟到后端删除成功；删除失败会恢复原页内容、选区和 dirty 状态。
> 页面新增、删除、应用样章均跨越后端和本地切页步骤，不是事务；遇到结果未知时先复读目录状态，禁止盲目重放。

> **模板/组件预检**：应用模板必须提供有效 `templateId`；`afterBlockId` 必须在当前页存在。
> 应用组件必须提供可访问的精确 `componentId` 和当前页 `blockId`，并在首个 `addElement` 前完成 content JSON、
> 组件内部 element id 唯一性、有限坐标及整体 bounds 不越出 owner 区块的检查。组件过大时先扩展区块或缩小素材，
> 不允许部分插入后再依赖回滚纠正几何。

### 元素（element）

| 方法 | 参数 | 返回 |
|------|------|------|
| `addElement(payload)` | `{ blockId, type, payload }` | `{ elementId }`；省略位置时按 **owner 区块尺寸**居中，不使用整页 viewport；统一重建传入元素树 id 并在写入前校验有限几何和 owner bounds |
| `applyLibraryImage(payload)` | `{ imageId? or url?, blockId? or elementId?, scope?, left?, top?, width?, height?, name?, fixedRatio? }` | `{ imageId, url, elementId }`（新增或替换图片，并记录素材使用历史） |
| `updateElement(payload)` | `{ elementId, patch }` | 无；patch 含 `left/top/x/y/width/height/rotate` 时先归一化数值并做 owner bounds 零写入预检；组元素拒绝直接通用几何更新 |
| `replaceElementSafe(payload)` | `{ elementId, elementData, dryRun?, expectedHash?, allowedPaths?, maxChangedPaths? }` | 保留身份的普通元素或组元素树完整 JSON 原位替换；`elementData` 可直接使用 `getElement` 结果；强制保持整棵树的 id、类型、父子关系、顺序、templateId/groupId，写后 hash 回读不一致时回滚 |
| `deleteElement(elementId)` | string | 无 |
| `moveElement(payload)` | `{ elementId, x, y }` | `{ elementCount: 1, x, y, dx, dy, coordinateSpace: block }`；支持组内子元素，`x/y` 是元素几何包围盒目标 `minX/minY`，坐标始终相对所属区块，并执行 owner bounds 预检 |
| `resizeElement(payload)` | `{ elementId, width, height }` | 无；宽高必须为有限正数，并按缩放后的旋转包围盒做 owner 区块边界预检，组元素拒绝直接缩放 |
| `rotateElement(payload)` | `{ elementId, angle }` | 无；角度必须为有限数，并按旋转后的真实包围盒做 owner 区块边界预检，组元素拒绝直接旋转 |
| `duplicateElement(elementId)` | string | `{ elementId }`；递归换 id 后默认 +20/+20，候选副本越出 owner 区块时零写入拒绝 |
| `addElements(payload)` | `{ blockId, elements: [{ type, payload }] }` | `{ elementIds }`；整批先重建 id、检查批内唯一性和 owner bounds，再逐项新增；中途失败补偿删除已新增项并报告 `rollbackApplied/rollbackFailures` |
| `updateElements(payload)` | `{ elementIds, patch }` | 无；几何 patch 先对全部目标完成 owner bounds 预检，全部通过后才一次 dispatch，任一失败零写入 |
| `deleteElements(elementIds)` | `string[]` | 无 |
| `duplicateElements(elementIds, opts?)` | `(string[], { offsetX?, offsetY? })` | `{ elementIds }`；默认 +20/+20，复制树递归换 id，全部候选先做 owner bounds 预检；中途失败补偿删除已新增副本 |
| `moveElements(payload)` | `{ elementIds, x, y }` | `{ elementCount, x, y, dx, dy, coordinateSpace: block }`；只接受同一 owner 区块的顶层元素，`x/y` 是**整个选择集包围盒**的目标 `minX/minY`，所有元素保持相对位置，不是把每个元素重叠到同一点 |
| `moveElementsByOffset(payload)` | `{ elementIds, dx?, dy? }` | `{ elementCount, dx, dy, coordinateSpace: block }`；每个元素在自己的 owner-local 坐标中偏移，写前统一做 owner 边界预检 |
| `alignElements(payload)` | `{ elementIds, align, target?, coordinateSpace? }`，align ∈ `top/bottom/left/right/horizontal/vertical/center/hdengju/vdengju`，target ∈ `selection/block/page`（`canvas` 是 `page` 兼容别名），coordinateSpace ∈ `block/page` | `{ align, target, elementCount, coordinateSpace }`；`selection` 可按选择集对齐或等间距，`block/page` 是外部参照 |
| `setElementSpacing(payload)` | `{ elementIds, direction: horizontal/vertical, spacing }` | `{ direction, spacing, elementCount, coordinateSpace: block }`（按方向重排为精确间距） |
| `centerElementInBlock(payload)` | `{ elementId, axis: horizontal/vertical/both }` | `{ elementId, blockId, axis, coordinateSpace: block }` |
| `lockElements(elementIds, locked?)` | `(string[], boolean)` | 无（isLock） |
| `hideElements(elementIds, hidden?)` | `(string[], boolean)` | 无（isHidden） |
| `setElementOpacity(payload)` | `{ elementId, opacity: 0~1 }` | 无 |
| `renameElement(elementId, name)` | (string, string) | 无 |
| `flipElement(payload)` | `{ elementId, direction: horizontal/vertical }` | 无（flipH/flipV，图片/文本框） |
| `setElementText(payload)` | `{ elementId, content }` | 无（text/shape/input/textarea/mind 写 content，latex 写 latex） |
| `setImageSrc(payload)` | `{ elementId, src }` | 无（image/video 换资源地址） |
| `setTextStyle(payload)` | `{ elementId, style: { fontSize?, color?, lineHeight?, fontName?, fontWeight?, verticalAlign?, wordSpace?, adaptive? } }` | 无（映射到文本元素顶层样式字段） |
| `orderElement(payload)` | `{ elementId, position }`，position ∈ `front/forward/backward/back` | 无 |

布局坐标和写入边界遵循以下不变量：

- `block` 坐标是元素所属区块的 owner-local 坐标；同一 `block` 计算必须来自同一 owner。即使元素位于组内，子元素的 `left/top` 仍是所属区块局部坐标，不是相对父组的坐标；`groupId` 只表示结构归属。
- 安全 JSON 替换必须使用同一候选对象执行两次：第一次保持 `dryRun=true`，第二次传
  `dryRun=false + expectedHash`。`allowedPaths` 是 JSON 路径前缀白名单，`maxChangedPaths` 默认 200。
  这两个工具允许完整富文本/组树一起往返，但不允许借机新增、删除、重排或重编号元素；结构迁移继续使用
  新增、删除、打组、解组、导入等显式工具。
- `page` 坐标只用于计算和返回，Y 通过 `blockTemplateListTopMap[block.uuid]` 加上 owner-local Y；
  计算出的移动量最终仍写回各元素自己的 owner-local `left/top`。
- 跨区块 `selection` 对齐必须显式传 `coordinateSpace: page`；`target: block` 只能用 `block`，
  `target: page` 只能用 `page`；等间距只支持 `target: selection`。
- `addElement(s)` 省略坐标时使用目标区块尺寸居中；显式几何、通用 `updateElement(s)` 几何 patch 和
  `duplicateElement(s)` 偏移都会先检查有限数、正宽高、旋转后真实 bounds 及 owner 边界。批量调用在
  首个写入前验证全部候选；只有底层 dispatch 运行时失败才进入已记录项的补偿回滚。
- `moveElements`、`moveElementsByOffset`、`alignElements`、`setElementSpacing`、
  `centerElementInBlock`、`resizeElement`、`rotateElement` 都先计算所有候选几何并检查 owner 边界；
  任一元素会越界时在首个位置/尺寸写入前整体拒绝。page 对齐不授予元素越过 owner 区块的权限。
- 组移动会把同一偏移写到叶子元素；组本身不能直接 resize/rotate。运行时写入异常会按已尝试叶子的
  原始坐标补偿恢复，并在错误上报告 `rollbackApplied`。

### 打组

| 方法 | 参数 | 返回 |
|------|------|------|
| `groupElements(elementIds)` | `string[]` | `{ groupId }` |
| `ungroup(groupId)` | string | 无 |

### 选中与视图（AI 控制增强）

| 方法 | 参数 | 返回 |
|------|------|------|
| `selectElement(elementId)` | string | `{ selected: [id] }`（单选并滚动定位） |
| `selectElements(elementIds)` | `string[]` | `{ selected: ids }`（多选） |
| `getSelection()` | 无 | `[elementId]`（当前选中） |
| `getViewport()` | 无 | `{ left, top, scale, canvasWidth, canvasHeight }` |
| `setViewport(payload)` | `{ left?, top? }` | 最新 `getViewport()` |
| `scrollCanvas(payload)` | `{ deltaX?, deltaY? }` | 最新 `getViewport()` |
| `scrollToElement(elementId)` | string | 最新 `getViewport()`（自动滚动到元素可见） |
| `setZoom(scale)` | number（0.1~3） | 最新 `getViewport()` |
| `zoomIn(step?)` / `zoomOut(step?)` | number（默认 0.1） | 最新 `getViewport()` |
| `fitCanvas()` | 无 | 最新 `getViewport()`（自适应窗口并居中） |
| `scrollToTop()` / `scrollToBottom()` | 无 | 最新 `getViewport()` |
| `clearSelection()` | 无 | `{ selected: [] }` |
| `getCanvasInfo()` | 无 | `{ slideId, canvasWidth, canvasHeight, scale, viewportLeft, viewportTop, stats }` |
| `scrollToBlock(blockId)` | string | 最新 `getViewport()`（滚动到区块顶部附近） |

> 选中元素后，右侧属性面板会同步显示该元素的 X/Y/宽高/样式，`getElement` 可直接读取数据；
> 所有视图操作均走 `baseEditorMain` 的 `setViewportLeft/Top` 与 `setScrollIntoElement`，与用户滚动画布等效。

### 历史 / 保存 / 视觉

| 方法 | 参数 | 返回 |
|------|------|------|
| `undo()` / `redo()` | 无 | `{ disabled: true, reason }`（ai_control 已禁用，改用快照回滚） |
| `canUndo()` / `canRedo()` | 无 | `{ disabled: true, reason }`（同左） |
| `save()` | 无 | 无（复用编辑器保存流程） |
| `saveVerified(payload?)` | `{ scope?: current/book, verify?=true, expectedSlideId?, expectedContentHash? }` | 始终只保存当前 dirty 页，返回 `savedScope=current/savedSlides`；scope=book 额外做分页整书摘要校验，不会逐页重写 |
| `restoreBookVersion(payload)` | `{ versionId, scope?: current/book, slideId?, validateOnly?, expectedCurrentVersionId? }` | 恢复一个目录的持久版本；scope=book 必须明确 slideId，先 validateOnly 预检；实际恢复后当前目录会重载核对 |

### 快照 / 回滚（ai_control 专用，替代撤销/重做）

| 方法 | 参数 | 返回 |
|------|------|------|
| `checkpoint(payload)` | `{ label? }`（任务开始/关键大节点调用，勿频繁） | `{ checkpointId, slideId, label, time, blockCount, elementCount }`（整页深拷贝快照） |
| `rollback(payload)` | `{ checkpointId }`（仅限回滚到同一页面） | `{ checkpointId, slideId, label, time, blockCount, elementCount, rollbackAt }` |
| `listCheckpoints()` | 无 | `[{ checkpointId, slideId, label, time, blockCount, elementCount }]` |
| `clearCheckpoints()` | 无 | `{ cleared }` |

> 快照存于页面 window 级 `Map`（`window.__superEditorCheckpoints`），页面刷新即清空；**任务开始打一个 checkpoint，任务成功 `clearCheckpoints()`，失败 `rollback()`**。

### 批量执行（一次往返多步，减少等待）

| 方法 | 参数 | 返回 |
|------|------|------|
| `batch(payload)` | `{ steps: [{ method, args }], stopOnError?: boolean }` | `{ results: [{ index, method, ok, value \| error }], stopped, stoppedAt }` |

- `steps[].method` 为桥接方法名，`args` 为参数数组（无参数传 `[]`）；步骤**按顺序串行**执行，每步完成后等渲染（nextTick），写操作安全。
- `stopOnError=true`（默认）遇错即停并返回已执行结果；`false` 时收集全部结果继续。
- 用法：把无依赖的独立小步骤合并成一次调用（如 `checkpoint → 批量改元素 → scrollToBlock → getSlide 核对`，或 `getState + getSlide + listBlocks` 一次读完），省去逐条调用的轮询/往返等待。

### 大纲（outline，v0.8：图层面板左侧「大纲」树，目录级数据）

大纲是编辑器图层面板左侧「大纲」标签下的树（`commonOutline` store），与画布元素不同：节点是目录级数据，**写操作即时调用后端接口持久化，不走 `save()`**；当前页写完后自动刷新本地大纲树。

```js
// outline 节点关键字段
{ id, book_id, catalog_id, outline_name, parent_id, sort, content_uuids: [blockUuid], children: [...] }

// outline anchor 关键字段
{ id, book_id, catalog_id, outline_id, name, type /*1=位置锚点 2=检索锚点*/,
  position_x, position_y, width, height, content_uuid, relative_position_x, relative_position_y }
```

| 方法 | 参数 | 返回 |
|------|------|------|
| `getOutline(payload?)` | `{ slideId? }`（省略=当前页；传任意 slideId 直接读取该目录大纲，不切换页面） | `{ slideId, outline: [节点树], selectedOutlineId }` |
| `refreshOutline()` | 无 | 重新拉取当前页大纲并刷新 store，返回大纲树 |
| `addOutline(payload?)` | `{ parentId?=0, sort?, name?="未命名", slideId? }` | 新节点 `{ id, outline_name, parent_id, sort, content_uuids }` |
| `renameOutline(payload)` | `{ outlineId, name, slideId? }` | `{ outlineId, outline_name }` |
| `deleteOutline(payload)` | `{ outlineId, slideId? }` | `{ outlineId, deleted: true }` |
| `moveOutline(payload)` | `{ outlineId, parentId?=0, sort, slideId? }`（sort 从 1 开始） | `{ outlineId, parentId, sort }` |
| `linkOutlineBlocks(payload)` | `{ outlineId, blockIds: [blockUuid], slideId? }`（整体替换关联区块） | `{ outlineId, content_uuids }` |
| `selectOutline(outlineId)` | string（传 null 清空选中） | 当前选中 outlineId |
| `getOutlineSelection()` | 无 | 当前选中 outlineId |
| `getOutlineAnchors(payload)` | `{ outlineId }` | `{ outlineId, anchors: [...] }` |
| `addOutlineAnchor(payload)` | `{ outlineId, name?="锚点", type?=2, positionX?=0, positionY?=0, width?=0, height?=0, slideId? }` | `{ outlineId, ...接口返回 }` |
| `updateOutlineAnchor(anchor)` | 完整锚点对象（必须含 `id`） | `{ anchorId, updated: true }` |
| `deleteOutlineAnchor(payload)` | `{ outlineId, anchorId }` | `{ outlineId, anchorId, deleted: true }` |

- 读取其他目录的大纲（`getOutline({ slideId })`）不切换当前页面，适合「先读一个已做好的目录大纲，再自动生成其他目录大纲」的工作流。
- 跨目录**写**当前版本走「`selectSlide(目标页)` → `refreshOutline()` → `addOutline/renameOutline/...`」；如需不切换页面直接写任意目录，可在桥接层再扩展。
- 大纲关联的 `blockIds` 是本页区块模板的 `uuid`（用 `listBlocks` / `getCanvasTree` 获取）。
- 锚点编辑与编辑器 UI 一致：`updateOutlineAnchor` 走 `saveanchor` 接口；位置锚点（type=1）由 UI 按关联区块自动维护，AI 通常只增删改检索锚点（type=2）。

### 题目资源（v1.4）

题目桥接提供路径/字典、四类资源范围搜索、详情诊断、选题校验、题解、当前目录资源管理和题目 AI
讲解。对应 MCP 工具统一使用 `editor_` 前缀。

#### 搜索与诊断

| Bridge 方法 / MCP 工具 | 参数 | 返回与约束 |
|---|---|---|
| `listQuestionPaths` / `editor_list_question_paths` | `{ bookId?, flatten? }` | 递归学习路径或扁平节点；`pathId` 必须来自此结果 |
| `getQuestionSearchOptions` / `editor_get_question_search_options` | `{ bookId?, refresh? }` | `difficulties/questionModels/features/dictionaries/searchMap/context` 等实时字典 |
| `searchQuestions` / `editor_search_questions` | 见 §4 查询表 | `currentCatalog`、`currentBookResources`、`learningPath`、`global`；`book` 仅为 `learningPath` 兼容别名，不支持 `all` |
| `getQuestions` / `editor_get_questions` | `{ guids, includeRaw?, includeDiagnostics?/returnEnvelope? }` | 详情含父子题与内容诊断；诊断信封为 `{ items, requestedGuids, uniqueGuids, foundGuids, missingGuids, duplicateGuids }`，不返回 `warnings` |
| `validateQuestionSelection` / `editor_validate_question_selection` | `{ guids, targetModuleType, config? }` | `{ compatible, reasons, requestedGuids, selectedGuids, foundGuids, missingGuids, duplicateGuids, parentChildConflicts, items, targetModuleType }` |
| `getQuestionSolutions` / `editor_get_question_solutions` | `{ guids, includeRaw? }` | 独立答案/解答/解析及缺失诊断 |
| `planQuestionLesson` / `editor_plan_question_lesson` | `{ guids, scope?: current/book, detail?: summary/deep, slideId?, objective?, layout?: auto/practice/explain/assessment, styleReference? }` | 只处理显式 GUID 的只读编排计划；summary 读详情，deep 才预检 PC 题目组件/数据；不会隐式扫描整书 |
| `renderQuestionsToBlock` / `editor_render_questions_to_block` | `{ plan? or guids?, blockId?, slideId?, afterBlockId?, newBlockName?, questionGap?, startTop?, mode?: append/replace, styleReference?, validateOnly?, expectedSlideId? }` | 复用原生题目组件排版到目标/新建区块；validateOnly 零写入，实际写入返回元素和位置且 `saved=false` |

`editor_search_questions` 的显式筛选包括 `period/subjectId/gradeId/volume/difficulty/features/guidList`、
答案/解析状态、`subModelIds/searchAreaTypes/sourceInfos/businessTypes/haveTag/tagNodeIds`。兼容
`filters` 仅接受同一白名单，且不能覆盖关键词和分页。

#### 当前目录题目管理

| Bridge 方法 / MCP 工具 | 参数 | 语义 |
|---|---|---|
| `addQuestionsToCatalog` / `editor_add_questions_to_catalog` | `{ guids, bookId?, catalogId?, validateOnly? }` | 按 GUID 添加目录关系；`validateOnly` 不写库 |
| `removeCatalogQuestion` / `editor_remove_catalog_question` | `{ resourceMappingId }` | 删除一道目录题目关系 |
| `moveCatalogQuestion` / `editor_move_catalog_question` | `{ resourceMappingId, toIndex }` | 用 0 基下标调整目录题目顺序 |

添加使用题目 GUID；删除和排序必须使用 `currentCatalog/currentBookResources` 结果中的数值
`resourceMappingId`，不能传 GUID。三种写操作均立即持久化，不属于画布 `save/checkpoint/rollback`；
写前读取当前映射，写后重新搜索核对。加入目录只建立资源关系，不会把题目排版插入画布区块。

#### 题目 AI 讲解

| Bridge 方法 / MCP 工具 | 参数 | 语义 |
|---|---|---|
| `getQuestionExplanations` / `editor_get_question_explanations` | `{ guids, includeRaw? }` | 读取已保存讲解；返回记录 `id` 可用于 type 94 |
| `startQuestionExplanationGeneration` / `editor_start_question_explanation_generation` | `{ guids, bookId? }` | 启动后立即返回 `{ started, batch, guids, ... }`，不在内部长轮询 |
| `getQuestionExplanationStatus` / `editor_get_question_explanation_status` | `{ guids, bookId?, includeResults? }` | 单次查询每题状态，必要时附完成结果 |
| `saveQuestionExplanation` / `editor_save_question_explanation` | `{ questionGuid, content: string, id? }` | 新增或按讲解记录 `id` 更新并立即写库；content 是 HTML/Markdown/富文本字符串，不接收对象 |
| `deleteQuestionExplanation` / `editor_delete_question_explanation` | `{ explanationId }` | 按讲解记录 ID 删除并立即写库 |

type 94 必须区分父题 GUID、子题 GUID、讲解记录 `id` 与后端 `explain_ids`：模块项
`questions[{ guid, explainIds }]` 中的 `guid` 是实际讲解对象，`explainIds` 是该对象已保存讲解记录 ID
列表。先生成/查询讲解，再配置模块；任务 ID、题目 GUID 和展示序号都不能作为讲解记录 ID。

type 82 中 `timeMode=0` 是正计时、`timeMode=1` 是倒计时；倒计时必须提供 `timeLimit`。
测评/竞速模式 `questionMode=2` 不允许正计时 `timeMode=0`，创建前必须经
`validateQuestionSelection` 校验。

当前版本不涵盖完整题目创建/编辑、OCR 或 AI 录题；题库现有题目的课件编排使用
`planQuestionLesson` / `renderQuestionsToBlock`。

### 数字模块（v1.4：元素点击交互）

数字模块关系由后端即时持久化，一个元素最多关联一个模块。所有方法只接收元素 `elementId`，
桥接内部解析所属模板的后端 `id` 作为 `hypermedia_content_id`，并在修改时保留关系
`id`、共享 `model_id`、内容行 `id/model_id` 以及嵌套实体 `id`。

| 方法 | 参数 | 返回 |
|------|------|------|
| `createDigitalModule(payload)` | `{ elementId, type, name?, config?, replaceExisting?=false, validateOnly?=false }` | 新关系；已有模块时默认拒绝，显式替换会携带现有关系/模型 id 向 `addControlModel` 发**一次更新请求**，不先删；`validateOnly` 只返回请求预览 |
| `updateDigitalModule(payload)` | `{ elementId, type?, name?, config?, replaceType?=false, validateOnly?=false }` | 更新后的关系；切换类型必须显式 `replaceType`，保留现有关系/模型/内容实体 id 并单次调用 `addControlModel`，不执行 delete-first |
| `deleteDigitalModule(payload)` | `{ elementId, ignoreMissing?=true }` | `{ deleted, missing?, elementId, relationId?, modelId?, type?, typeName?, name? }` |
| `copyDigitalModule(payload)` | `{ sourceElementId? or modelId?, targetElementId, replaceExisting?=false }` | 仅目标为空时建立 `relation` 并复用同一个 `model_id`；目标已有模块时始终拒绝，`replaceExisting=true` 也不会先删 |

- 类型 `61/76/77/78/79/80/81/82/83/85/86/87/93/94/96/98/99` 提供语义化配置适配；其中 `94` 需要已生成的讲解 ID，`98` 只关联已完成生成的播客资源。类型清单会明确其余类型的支持程度和资源要求。
- 模块名优先使用调用方名称，其次根据 URL、媒体名、目标或题目生成；仍无法生成时使用模块类型中文名。
- `77` 音频和 `78` 视频可使用素材库 URL、AI 生成资源 URL，或先调用 `uploadFile` 上传本地文件，再把上传结果交给配置适配器。
- `82/83/93/94` 等题目型模块使用题目/子题 GUID，不使用题目数字 `id`、目录 `id` 或展示序号；type 82/94 还须遵守上一节的组合校验和讲解记录 ID 规则。
- `copyDigitalModule` 对齐现有 `addcontrolmodelrelation`：源与目标共享 `model_id`，修改共享模型可能影响所有关系；当前版本不声明独立深复制。若业务确实要覆盖，只能显式 `deleteDigitalModule` 后再复制；这两个立即持久化请求**不是事务**，删除成功而复制失败时不会自动恢复旧关系，因此不得包装成“安全覆盖”。
- 数字模块同元素更新和类型切换必须复用现有关系标识走单次 `addControlModel`；禁止为了改类型先调用 `deleteControlPosition`。只有用户明确删除模块时才调用删除接口。
- `create/update/delete/copy` 成功后发送 `ELEMENT_DIGITAL_MODULE` 广播刷新编辑器侧面板。
- 这些写操作不进入画布快照，`checkpoint`、`rollback` 和 `save` 都不能撤销；调用前必须先查询确认目标。

### 文件上传与媒体使用（v1.3）

文件上传复用项目标准 `upLoadFile`（uploadfile）通道，在编辑器页面内携带登录态完成；调用方传 base64 / dataURL 数据，MCP 侧可把本地图片、音频、视频或文档路径转换为 dataURL。

| 方法 | 参数 | 返回 |
|------|------|------|
| `uploadFile(payload)` | `{ data, fileName?, mimeType?="application/octet-stream" }`（data 支持纯 base64 或 dataURL） | `{ url, fileId, fileName, mimeType }` |
| `uploadImage(payload)` | `{ data, fileName?="ai-image.png", mimeType?="image/png" }`（data 支持纯 base64 或 dataURL） | `{ url, fileId, fileName }` |
| `addImageElement(payload)` | `{ blockId, url?, data?, left?, top?, width?, height?, name?, fixedRatio?=true }`（传 data 时自动先上传） | `{ url, elementId }` |
| `setImageElementSrc(payload)` | `{ elementId, url?, data? }`（image/video 元素；传 data 时自动先上传） | `{ url, elementId }` |

- 只传 `url` 时不触发上传，适合直接使用外链或媒体库已有地址。
- `uploadImage` 是兼容接口，内部复用 `uploadFile`；通用上传结果可直接用于音频/视频数字模块。
- 上传返回的 `url` 可直接作为图片元素 `src`、文本背景图 `background.image`（经 `updateElement` patch）或思维导图节点 `image`。
- 推荐工作流（模型具备生图能力后）：生成本地 PNG → MCP `editor_upload_image`（传 `imagePath`）或桥接 `uploadImage` → `editor_add_element(type=image, payload={src})` 或 `addImageElement` → `moveElement/resizeElement` 排版。
- 插件当前通过 base64 RPC 传本地文件，主动限制原文件不超过 70MB；大视频应优先使用素材库或已有远程 URL。上传接口失败会抛错并返回服务端信息。

### 表格 / 选项卡 / 思维导图 / 文本

| 方法 | 参数 | 返回 |
|------|------|------|
| `updateTable(payload)` | `{ tableId, patch }`（widths/heights/borderColor 等顶层字段） | 无 |
| `setTableCellContent(payload)` | `{ tableId, row, col, content }`（0 基，被合并覆盖格不可写） | 无 |
| `setTableCellBackground(payload)` | `{ tableId, row, col, background }`（传空串/null 清除） | 无 |
| `setTableData(payload)` | `{ tableId, tableData }`（整表数据替换） | 无 |
| `getTableInfo(payload)` | `{ tableId }` | `{ tableId, rows, cols, widths, heights, mergedCells, border, style }` |
| `getTableGrid(payload)` | `{ tableId }` | `{ rows, cols, mergedCells, grid: [[{ row, col, id, rowspan, colspan, isOrigin, isCovered, origin, content(纯文本), contentHtml, backgroundColor }]] }`（AI 读表格首选） |
| `insertTableRow(payload)` | `{ tableId, index }`（0 基，自动处理合并跨行） | `{ tableId, rows, cols }` |
| `deleteTableRow(payload)` | `{ tableId, index, count? }` | `{ tableId, rows, cols }` |
| `insertTableColumn(payload)` | `{ tableId, index }`（0 基） | `{ tableId, rows, cols }` |
| `deleteTableColumn(payload)` | `{ tableId, index, count? }` | `{ tableId, rows, cols }` |
| `mergeTableCells(payload)` | `{ tableId, startRow, startCol, endRow, endCol }`（0 基含边界） | `{ tableId, merged }` |
| `splitTableCell(payload)` | `{ tableId, row, col }`（合并起点坐标） | `{ tableId, split }` |
| `fitTableHeights(payload)` | `{ tableId, waitMs?=2000, minHeight?=30 }`（按单元格实际内容高度重算每行最小高度并写回 heights，等效逐行拖拽收缩；内容变小时编辑器不会自动收缩，用它收紧；自动处理 rowspan 合并单元格） | `{ tableId, changed, heights, oldHeights, height }` |
| `setTabs(payload)` | `{ tabId, tabs: [{ id?, label }] }`（id 缺失自动生成） | 无 |
| `setActiveTab(payload)` | `{ tabId, index }` | 无 |
| 思维导图（v0.5，数据模型：`content` = kityminder JSON 字符串 `{ root: { data: { id, text(HTML), type }, children: [] }, template, theme }`） | | |
| `getMindData(payload)` | `{ mindId }` | `{ mindId, template, theme, version, connectColor, root }`（原始数据，适合备份） |
| `getMindTree(payload)` | `{ mindId }` | `{ mindId, template, theme, nodeCount, depth, root: { id, text(纯文本), textHtml, type, depth, path, attrs, children[] } }`（AI 读思维导图首选） |
| `setMindData(payload)` | `{ mindId, content }`（对象或 JSON 字符串，自动补齐节点 id） | `{ mindId, nodeCount }` |
| `setMindNodeText(payload)` | `{ mindId, nodeId, text }`（纯文本自动包 `<p>`，HTML 原样保留） | `{ mindId, nodeId, text }` |
| `addMindNode(payload)` | `{ mindId, nodeId?, position: child/sibling, text?, index?, data? }` | `{ mindId, nodeId(新), position, parentId }` |
| `deleteMindNode(payload)` | `{ mindId, nodeId }`（中心主题不可删） | `{ mindId, nodeId, deleted, remaining }` |
| `updateMindNode(payload)` | `{ mindId, nodeId, patch }`（color/fontsize/bold/italic/fontFamily/background/note/image/hyperlink/priority/progress/expandState 等，null 删除） | `{ mindId, nodeId, updated }` |
| `setMindTemplate(payload)` | `{ mindId, template }`（default/right/left/right_angle/default_angle/left_angle/orthogonal） | `{ mindId, template }` |
| `setMindTheme(payload)` | `{ mindId, theme }`（mind-default/retro/youth/minimalist/black） | `{ mindId, theme }` |
本契约的结构化富文本内容级方法统一接受且只接受一种目标选择器：

- legacy 普通文本：`{ elementId }`；统一写法：`{ target: { kind: 'element', elementId } }`；
- 表格单元格：`{ target: { kind: 'tableCell', tableId, cellId } }`，或用 0-based `row + col`
  代替 `cellId`；若同时给出两种定位，它们必须指向同一单元格；被合并覆盖的格不可写；
- 思维导图节点：`{ target: { kind: 'mindNode', mindId, nodeId } }`；节点 id 重复时拒绝操作。

下表中的 `selector` 指 `{ elementId } | { target }`。返回统一带
`elementId`（所属外层元素 id）、规范化 `target`、`targetKind`、`layoutOwner` 和
`standaloneLayoutSupported`。内容级方法包括
`getTextInfo/getTextDocument/setTextContent/editText/setTextLink/removeTextLink/editTextEmbed/formatText`；
文本框布局与几何方法 `setTextAdaptive/fitTextSize/setTextLayout/inspectTextLayout/fitTextToBox` 仍只接受
独立文本元素 `elementId`。

| 文本方法 | 参数 | 返回 |
|------|------|------|
| `getTextInfo(payload)` | `{ ...selector }` | 统一目标身份 + `{ blockId, content(HTML), text(纯文本), wordCount, font, lineHeight, wordSpace, verticalAlign, textAlign, adaptive, overflowType, maxWidth, maxHeight, padding, background, geometry, groupId, isLock, isHidden }`；嵌套目标 `geometry=null` |
| `setTextContent(payload)` | `{ ...selector, content, expectedContentHash?, dryRun?, fitSize?, waitMs? }`（纯文本自动包 `<p>`，换行自动拆段；实际写入时 fitSize 默认 true） | 统一目标身份 + `{ dryRun, changed, previousContentHash, contentHash, content, plainText, displayText, indexText }`；独立文本写入另返回 width/height/dWidth/dHeight/autoResized/moved[] |
| `setTextAdaptive(payload)` | `{ elementId, extendType, fitSize?, waitMs? }`（both/horizontal/vertical/none） | `{ elementId, extendType, previous, width, height, dWidth, dHeight, autoResized, moved[] }` |
| `fitTextSize(payload)` | `{ elementId, waitMs? }`（强制重测） | `{ elementId, width, height, dWidth, dHeight, autoResized, moved[] }` |
| `getTextDocument(payload)` | `{ ...selector, includeHtml?, includeRuns?, includeParagraphs?, includeEmbeds? }` | 统一目标身份 + `{ blockId, content, html?, canonicalHtml?, plainText/displayText, displayLength, indexText, displayIndexMap, length, indexUnit, indexModel, terminalNewline, contentHash, htmlHash, hyperlinkMetadataHash, canonicalized, serializationStable, semanticEquivalent, renderEquivalent, interactionEquivalent, roundTripSafe, roundTripWarnings, paragraphs?, runs?, embeds?, hyperlinks, orphanedHyperlinkMetadata, defaultStyle, layout, geometry }`；拼音 word 只在显示文本中展开，写入范围使用结构索引 |
| `formatText(payload)` 的 MCP 默认样式别名 | `editor_text_set_style({ ...selector, style, expectedContentHash?, fitSize?, waitMs? })` | 等价于 `formatText({ scope: 'default', formats: style })`；只接受默认字体/字号/颜色/粗斜体/行距/字距等字段，不强行覆盖已有内联 run |
| `editText(payload)` | `{ ...selector, action: insert/replace/delete/findReplace, index?, length?, text?, html?, match?, occurrence?, caseSensitive?, replaceAll?, expectedContentHash?, dryRun?, fitSize?, waitMs? }` | 统一目标身份 + `{ action, dryRun, changed, changes[], beforeHash, previousContentHash, contentHash, plainText, content, canonical, indexUnit, indexModel, width?, height?, moved? }`；insert 用 index，replace/delete 用 index+length，只有 findReplace 用 match；findReplace 省略 text/html 时删除匹配 |
| `setTextLink(payload)` | `{ ...selector, index, length, hyperlinkId?, hyperlink?, expectedContentHash?, dryRun?, fitSize?, waitMs? }` | 统一目标身份 + `{ changed, dryRun, range, hyperlinkId, hyperlink, previousContentHash, contentHash, plainText, content, width?, height?, moved? }`；原子设置链接格式并同步 hyperlinkParamList。新链接的 `hyperlink.hyperlink_id` 可省略，由 Bridge 生成并以返回的 `hyperlinkId` 为准。兄弟单元格/节点仍引用同一 id 时，单目标 metadata 修改返回 `TEXT_HYPERLINK_SHARED`，应省略 id 新建独立链接。URL 元数据用 `input_type/link_mode/jump_type=1/link_address/agent_id=0/agent_params=[]`；智能体用 jump_type=2 和真实 agent_id/agent_params |
| `removeTextLink(payload)` | `{ ...selector, hyperlinkId? }` 或 `{ ...selector, index, length }`，另支持 expectedContentHash/dryRun/fitSize/waitMs | 统一目标身份 + `{ changed, dryRun, ranges[], hyperlinkId, previousContentHash, contentHash, plainText, content, width?, height?, moved? }`；清理不再被正文引用的链接元数据 |
| `editTextEmbed(payload)` | `{ ...selector, action: insert/update/delete, index, embedType?, value?, expectedContentHash?, dryRun?, fitSize?, waitMs? }` | 统一目标身份 + `{ action, changed, dryRun, index, embedType, value, previousContentHash, contentHash, plainText, content, embeds[] }`；支持 formulaMath/pinyinBox/image。image 使用完整 ImageBot 对象，可含 url、宽高/原始宽高、rotate/opacity/flip、描边、verticalAlign、offsetX/Y；blot 未注册或未保留完整 value 时返回 TEXT_EMBED_NOT_REGISTERED |
| `formatText(payload)` | `{ ...selector, scope: default/all/range/match/paragraph, index?, length?, match?, occurrence?, paragraphIndexes?, formats, expectedContentHash?, dryRun?, fitSize?, waitMs? }`；`paragraphIndexes` 为 0-based | 统一目标身份 + `{ scope, appliedFormats, dryRun, changed, ranges?, beforeHash?, previousContentHash?, contentHash?, content?, beforeStyle?, afterStyle?, width?, height?, moved? }` |
| `setTextLayout(payload)` | `{ elementId, layout, fitSize?, waitMs? }`；不接受 expectedContentHash/dryRun；layout 支持 extendType/maxWidth/maxHeight、overflowType 数组、padding、横竖排/对齐、background、fill `{enabled?,color?}`、outline/shadow/borderRadius | `{ elementId, before, layout, geometry, changedKeys, width, height, dWidth, dHeight, rendered, settled, deferredLayout, moved[] }`；嵌套外观对象深合并 |
| `inspectTextLayout(payload)` | `{ elementId }` | `{ elementId, rendered, measurement?, geometry, overflow, clipped, needResetSize, fontNames, roundTripSafe, extendType, overflowType, paragraphCount, runCount, embedCount, textLength, defaultStyle, warnings[] }`；measurement 含内容/容器宽高和 overflowX/overflowY/overflow |
| `fitTextToBox(payload)` | `{ elementId, minFontSize?, maxFontSize?, step?, expectedContentHash?, allowUniformizeMixedSizes?, waitMs? }`（保持文本框宽高不变并缩小字号；不接受 dryRun） | 返回 `{ applied, fitted, overflow, reason?, previousFontSize?, fontSize?, inspectionBefore, inspectionAfter?, fits?, attempts?, reachedMinimum?, fontSizes?, invalidFontSizes?, requiresExplicitUniformization?, uniformizedMixedSizes?, contentHash }`；混合/不可解析字号默认 `reason=mixed-font-sizes` 且零写入，只有明确传 `allowUniformizeMixedSizes=true` 才统一字号；未渲染或已放入时 `applied:false` 并给出原因，不伪装完成 |
| `searchTextElements(payload)` | `{ query, blockId?, targetKinds?: ['element','tableCell','mindNode'], caseSensitive?, wholeWord?, useRegex?, limit? }` | `{ query, scope, blockId, targetKinds, searchedTargets, searchedElements, total, truncated, warnings[], ranges[], items[], matches[] }`；默认搜索三类目标，每个命中带统一目标身份、可直接写入的 index/length 和仅供展示的 displayIndex/displayLength；仅搜索当前已加载目录，matches 为兼容平铺结果 |
| `copyTextStyle(payload)` | source 从 `sourceElementId/sourceTarget` 二选一，targets 从 `targetElementIds/targetTargets` 二选一；两侧可混用；另有 `scope?: default/character/paragraph/layout/all, fitSize?, waitMs?` | `{ sourceElementId, sourceTarget, targetElementIds, targetTargets, scope, copied, results }`；保留目标文本内容。嵌套目标支持 default/character/paragraph；layout/all 仅支持独立文本并对嵌套目标返回 `TEXT_LAYOUT_TARGET_UNSUPPORTED` |
| `listTextFonts(payload)` | `{ language?: all/chinese/english/number }` | `{ language, items: [{ label, value, source, available, languages[] }] }` |

嵌套目标的内容写入可能返回 `rendered=true` 但 `settled=false/deferredLayout=true`，表示 Bridge 已请求领域
重排但无法独立验证表格或思维导图布局稳定；此时必须复读内容并截图核对外层元素。嵌套目标的
`width/height/dWidth/dHeight/autoResized` 为 `null`，不能当作独立文本框几何使用。

文本索引统一采用 UTF-16 / Quill 语义，公式、图片、拼音等内嵌对象长度按 1 计算。
`plainText/displayText` 会展开拼音 word，不能把它的下标直接当 Quill index；使用 paragraphs/runs/embeds
或搜索返回的 index/length。超链接必须使用
`setTextLink/removeTextLink`，公式、拼音和内嵌图片必须使用 `editTextEmbed`；不要把这些格式直接塞给
`formatText`。安全往返检查会保护任意 data-* 节点、answer-tag、phoneme，以及图片/拼音/链接的尺寸、
样式和语义属性；注册不完整时拒绝覆盖。写操作若带
`expectedContentHash`。`contentHash` 联合覆盖 canonical HTML 与稳定排序后的 `hyperlinkParamList`，所以正文或仅链接参数变化时都必须拒绝覆盖；`htmlHash`、`hyperlinkMetadataHash` 仅供分项诊断，不能代替并发校验。批量查找替换和格式化优先用 `dryRun` 核对命中范围。
`fitTextSize` 会让文本框按内容和 `extendType` 改变尺寸，不改正文且不接受 expectedContentHash/dryRun；
`fitTextToBox` 则保持文本框尺寸并缩小字号，接受 expectedContentHash 但不接受 dryRun，二者不可互换。
混合字号只有在用户明确同意统一后才传 `allowUniformizeMixedSizes=true`。不要用 `updateElement` 直接拼接富文本 HTML，以免破坏超链接、公式、列表和格式范围。
读取及内容写入共用有界 canonical 稳定化：最多 5 轮 `parse → production convertHTML`。相邻两轮
HTML 完全一致，或 Quill 文档的文本顺序、有效样式、内嵌对象及超链接语义一致，均可返回或落库；
标签嵌套、属性顺序和连续 run 切分差异不单独阻塞。每轮仍执行受保护结构检查，真实语义变化或超限
继续拒绝写入。

### 数据交换（备份 / 整页导入导出）

| 方法 | 参数 | 返回 |
|------|------|------|
| `exportSlide(slideId?)` | string（省略=当前页） | `{ slideId, blocks }`（整页完整数据，可用于备份/跨页复用） |
| `getSemanticSnapshot(payload?)` | `{ slideId?, richText?: 'none'\|'summary'\|'deep' }`（默认当前页、`deep`；只能是当前书本内普通目录） | `{ schemaVersion:'1.0', snapshot:{ identity, state, slide, blocks, elementIndex, outline, digitalModules, richText, fonts, completeness }, meta, stableHash }`；完整只读 envelope，见下方契约 |
| `replaceSlideContent(slideId, blocks, options?)` | `(string, 模板数组, { saveBeforeSwitch?, discardChanges? })` | `{ slideId, blockIds }`；跨页时先安全切换，再清空目标页重建；传空数组=清空页面，失败会恢复调用前本地内容并报告 `rollbackApplied` |
| `getBridgeInfo()` | 无 | `{ version, instanceId, windowId, bookId, contextEpoch, bookSwitching, methods }`（methods 为全部可用方法名） |
| `batch(payload)` | `{ steps: [{ method, args }], stopOnError? }` | `{ results: [{ index, method, ok, value/error }], stopped, stoppedAt }`（一次往返串行执行多步，见下） |
| `screenshot(payload)` | `{ fullPage?, blockId? }` | `data:image/png;base64,...`（默认当前视口；`fullPage: true` 全部区块拼接整页；`blockId` 指定单区块） |

## 5. 实现注意事项

- **语义快照完整性**：`getSemanticSnapshot` 在读取前后必须核对 `bookId/contextEpoch/dirty`，书本切换或
  dirty 状态漂移时拒绝返回；当前目录允许读取 working 副本并显式返回 `state.source='working'` 与
  `dirty`，非当前目录返回持久态 `state.source='persisted'`。`blocks` 保留完整原始可编辑对象；
  `elementIndex` 每项至少含 `elementId/type/blockId/path/groupPath/geometry`，并尽量保留
  `sourceId/blockDatabaseId/name/groupId`；`digitalModules.items` 同时包含 `normalized` 与 `raw`，且
  `includeRaw=true`；`richText.detail` 必须与请求一致，deep 保留 canonical HTML、runs、paragraphs、
  embeds、links、样式、布局与 hashes。`completeness.sections` 的
  `blocks/elementIndex/outline/outlineAnchors/digitalModules/digitalModulesRaw/richText/fonts/contentReady`
  全部使用 boolean；只有全为 `true` 且 warnings 为空时 `complete=true`。部分读取不静默丢弃：设置
  `complete=false`、对应 section=false 并附至少一个 warning。`stableHash` 是对
  `{schemaVersion,snapshot,meta}` 递归排除 `capturedAt/stableHash` 后做对象键排序、保留数组顺序的
  canonical JSON SHA-256；MCP 会用同一算法复算验证。它不同于 MCP 落盘文件的 SHA-256。
- **语义快照兼容边界**：MCP 不用页面导出或业务摘要拼装缺失能力。旧 Bridge
  没有 `getSemanticSnapshot` 时明确返回不支持；需要完整语义制作时只有 deep 且
  `completeness.complete=true` 的结果可继续。

- **原子热切书**：`target=current` 必须先处理 dirty 页并进入互斥状态，再预取目标书元数据、目录与首目录内容；提交前释放旧目录锁、隔离旧请求，提交时统一替换 URL、`sessionStorage.book_id` 和书本级 store。成功后递增 `contextEpoch` 并将 `bookSwitching=false`，最后才返回 `hotSwitched=true`。热切失败不得暴露新旧混合状态；能回滚则恢复原上下文，不能安全回滚才安排完整刷新兜底。
- **内容就绪**：v1.9.0+ 热切书完成后的 `getState()` 必须明确返回 `contentReady/currentSlidePlaceholder/emptyBook`。普通书只有在存在 `currentSlideId` 且 `contentReady=true` 时可操作；空书以 `emptyBook=true`、PDF 占位目录以 `currentSlidePlaceholder=true` 显式表示无需普通画布内容。不得用“模板数组非空”代替加载完成，因为正常空白目录也可以已经加载就绪。
- **刷新 epoch**：只有 `hotSwitched=true` 返回的 `contextEpoch` 才属于同一实例的最低就绪版本。`reloadScheduled=true` 的旧页 epoch 不得约束刷新后新实例，新实例允许从 `contextEpoch=0` 重新开始。
- **刷新实例屏障**：`scheduled/reloadScheduled=true` 后，旧页面在 `setTimeout(location.reload)` 延迟期可能已因 URL 或 session 变化上报目标 `bookId`。MCP 必须把发出导航命令的 `instanceId` 加入本次认领排除项；旧实例无论上报何种 book/store 状态都不能完成切换，只有同一 `windowId` 下不同的实例可返回 `ready=true`。
- **迟到响应隔离**：每个书本异步加载都必须捕获发起时的上下文版本，并在提交响应前核对 `contextEpoch`/目标 bookId；旧书响应不得写进新书 store。
- **Bridge 生命周期**：热切书不得销毁 `window.__superEditor`、RPC 轮询、`instanceId` 或 `windowId`。完整刷新兜底允许更换 `instanceId`，但必须保留原 `windowId`。
- **走 Vuex action**：所有写操作 dispatch 现有 action（见 `editor-integration-guide.md` 的映射表），这样 `commonDataSave` 会记录操作日志；**ai_control 下 `commonDataUndo` 不入栈**，撤销/重做由快照（checkpoint/rollback）承担，避免操作栈在长链路 AI 操控下不收敛。
- **id 生成与替换**：新增元素必须生成唯一 `id`，并设置 `templateId = 所在区块 uuid`、`groupId = 0`；打组后子元素 `groupId = 组 id`；复制/深拷贝时用 `replaceElementsId` 同步替换所有子级 `groupId`。
- **高度联动**：增删改元素后调用 `updateTemplateHeightByElementList(templateId)`（现有 action 已处理）。
- **错误处理**：任何失败都 reject，消息要可读（例如 `区块不存在: xxx`）。
- **数字模块 ID 不变量**：元素的 `templateId` 和区块操作使用模板 `uuid`；数字模块 `hypermedia_content_id` 只能使用所属模板后端 `id`。模板尚无后端 `id` 时先保存/刷新内容，仍无 `id` 则拒绝写入。
- **即时持久化边界**：数字模块、目录题目、题目讲解和书本/目录写操作直接请求后端，不属于当前页 JSON 快照；不得承诺可由 `rollback()` 或稍后的 `save()` 回滚。
- **不要**在桥接里直接 `commit` 绕过日志的 mutation（除非该动作本身无操作日志需求）。


- 页面增删改会通过目录接口持久化（`addBookCatalog` / `deletecatalog` / `updatecatalogsort`），
  大纲、目录题目、题目讲解和数字模块也各自立即写库；区块、元素、文本及应用到当前页的区块模板、
  组件和图片先写本地工作副本，最后用 `saveVerified(scope=current)` 保存并回读。不能笼统地把“其他写操作”
  都归到 `save()`，也不能承诺页面 checkpoint 能撤销立即持久化域。

## 6. 安全

- 桥接只在用户主动开启顶部“AI 控制”后挂载；关闭按钮或页面销毁时必须卸载。
- 调用一律走 §6.5 的 RPC 通道；插件只监听回环地址 `127.0.0.1`，不监听局域网网卡。
- 建议给桥接增加调用白名单/频率限制（可选）。
## 6.5 RPC 通道（推荐调用方式，生产/开发通用）

编辑器侧（`src/modules/contentEditor/aiControl/index.js`）在挂载桥接时同时启动两类通道：

### 方式 A：插件本机 HTTP RPC（推荐，生产/开发通用）
- 桥接默认长轮询 `http://127.0.0.1:8765/ai-control/rpc/poll?instance=<页面实例ID>&windowId=<浏览器窗口ID>`；`instance` 每次加载变化，`windowId` 在同一窗口刷新/导航时保持、新窗口独立生成；`window.__SUPER_EDITOR_RPC_URL` 仅用于开发时覆盖基地址；
- broker 由插件 MCP 进程提供，正式后端和 Electron 都不需要部署 RPC；多个 MCP 进程自动选主和故障接管；
- 插件首次连接后固定 `windowId`；v1.9.0 热切书优先保持原 `instanceId` 和租约，只有实例确实失活时才等待同一窗口的新实例，禁止把其他书本窗口作为自动重连回退。
- 每次开启按钮生成新的 instance ID。poll 有命令时返回 `{ id, method, args }`，无命令最长等待 20 秒后返回 204；
- 桥接只执行一次 `window.__superEditor[method](...args)`，随后 POST `{ id, instance, ok, value, error, errorCode? }`；结果传输失败只重发同一结果；
- MCP 驱动使用 `clientId` 租用页面并固定 `targetInstance`，多任务不会串台；页面心跳 TTL 120 秒，空闲租约 TTL 30 秒；
- broker 对 CORS/PNA 预检返回 `Access-Control-Allow-Private-Network: true`。正式页面需 HTTPS，CSP `connect-src` 需允许 `http://127.0.0.1:8765`；
- 已派发命令发生断连时返回 `OUTCOME_UNKNOWN`，调用方必须先读取状态，禁止自动重放写操作。完整协议见 `production-integration-spec.md`。

### 方式 B：DOM 属性通道（备用，供可写 DOM 的隔离环境）
- 请求：`document.documentElement.setAttribute('data-se-rpc-req', JSON.stringify({ id, method, args }))`；
- 响应：`data-se-rpc-res` 属性变为 `JSON.stringify({ id, ok, value|error })`；
- 主世界通过 MutationObserver 监听 `data-se-rpc-req` 属性变化并执行。
- 注意：某些严格只读沙箱（无 `setAttribute`）只能用方式 A。

## 7. 实战经验（2026-08 首轮验证补充）

### 7.1 探测与连接
- 页面挂载后 `document.documentElement` 会出现 `data-super-editor-bridge="1"` 属性，卸载时移除。任何隔离世界/主世界都可以用它探测桥接是否就绪。
- 浏览器扩展类控制工具（如 content-script 沙箱）通常**看不到** `window.__superEditor`，此时以 DOM 标记为准；真正调用方法一律走 §6.5 插件本地 RPC 通道。
- URL 带 `token` 时，普通浏览器可沿用既有鉴权；RPC broker 不参与业务登录。

### 7.2 参数约定（重要）
- `getSlide(slideId)` / `deleteBlock(blockId)` 等方法的 id 参数仍使用**标量**（string/number）。
  `selectSlide` 和 `deleteSlide` 是安全切页例外：都兼容标量，也接受
  `{ slideId, saveBeforeSwitch?, discardChanges? }`；dirty 当前页要离开或删除时必须传对象表达处理意图。
- `addBlock({ afterBlockId?, size? })` 返回 `{ blockId }`；`addElement({ blockId, type, payload })` 返回 `{ elementId }`；新增后可立刻 `getSlide` 校验。
- 高频只读入口优先使用 `getState`、`getCanvasTree`、`listBlocks`、`getBlock`、`getElement`、
  `getElementsBounds`，不要为一个局部目标先导出整页。页面操作使用
  `selectSlide/addSlide/deleteSlide/moveSlide/exportSlide/replaceSlideContent`；区块操作使用
  `addBlock/cloneBlock/updateBlock/moveBlock/importBlocks/copyBlockToSlide/replaceBlock/replaceBlockSafe/deleteBlock`；
  完整元素树原位替换使用 `replaceElementSafe`。
- 视图定位使用 `scrollToBlock/scrollToElement/fitCanvas/getViewport`；它们不修改课件内容。
  `getElementsBounds(ids, { coordinateSpace: 'page' })` 才是跨区块几何的标准入口，不要自行猜测区块累计高度。

### 7.3 文本元素样式模板（与产品风格一致）
```js
// 一级标题（橙色粗体，产品色 rgb(211,94,15)，字体江城圆体 20px）
{
  type: 'text', adaptive: 'width', defaultFontSize: 20, defaultFontName: '江城圆体',
  defaultFontWeight: 600, wordSpace: 1.8,
  content: '<p><b class="cmihee-bold" data-weight="600" style="font-weight: 600; color: rgb(211, 94, 15); font-size: 20px; font-family: num-江城圆体, en-江城圆体, zh-江城圆体;">标题文字</b></p>'
}
// 正文内容（思源黑体 CN 16px，行高 1.6，自适应高度）
{
  type: 'text', adaptive: 'height', defaultFontSize: 16, defaultFontName: '思源黑体 CN',
  defaultFontChinese: '思源黑体 CN', defaultFontEnglish: '思源黑体 CN', defaultFontNumber: '思源黑体 CN',
  lineHeight: 1.6,
  content: '<p style="margin: 0 0 4px 0;"><span style="font-family: &quot;num-思源黑体 CN&quot;, &quot;en-思源黑体 CN&quot;, &quot;zh-思源黑体 CN&quot;; font-size: 16px; color: rgb(51, 51, 51);">正文</span></p>'
}
```

### 7.4 画布渲染与验证
- 编辑器画布是**虚拟滚动**：`#canvas-ref` 只渲染可视区块；`screenshot()` 用项目 `utils/html-to-image` 截图，`blockId` 模式定位 `#template-container-<uuid>`，`fullPage` 模式逐块截图拼接（ai_control 下区块全量渲染，均可截）。canvas 类区块（四线三格/手写格）与跨域图片可能渲染为空。
- **滚动必须走桥接**：`scrollToBlock(blockId)` / `scrollToElement(elementId)` / `scrollCanvas({ deltaY })`（`scrollTop` 被自定义滚动接管，直接赋值无效；也不要用鼠标滚轮模拟）。
- 元素坐标以 `getElement` / `listElements` 返回的 `left/top/width/height`（owner 区块内相对坐标）为准；
  需要整页坐标时调用 `getElementsBounds(ids, { coordinateSpace: 'page' })`，由 Bridge 使用
  `blockTemplateListTopMap` 换算，调用方不要重复叠加。
- 读取和保护范围按任务风险决定：明确的单元素小改只复读目标；多元素重排或结构改写才按需
  `checkpoint`，高风险整页替换才考虑 `exportSlide`。保存使用 `saveVerified(scope=current)` 的服务端回读；
  不再要求每次编辑前全量 `getSlide` 备份，也不以 `save() + Page.reload` 作为普通验证链。

### 7.5 页面增删（addSlide/deleteSlide 实测要点）
- 后端 `addcatalogandtemplate` 要求有效 `template_id`。`addSlide` 不传 `template_id` 时桥接会：
  ① 扫描模板库中的空白样章模板（无区块）复用；② 没有时调用 `addtemplate` 创建空白样章模板并按
  `book_id` 缓存。当前页 dirty 时，Bridge 在创建目录前就要求 `saveBeforeSwitch` 或 `discardChanges`。
- `deleteSlide` 删除非当前页时不切页；删除当前页时优先安全切到现存的另一页，只有最后一页被删除时
  才清空当前内容。dirty 丢弃会延迟到后端删除成功，删除请求失败则恢复原页内容、选区和 dirty；
  不再假设总会“切回目录第一页”。是否额外导出备份按破坏性任务风险和用户意图判断，不是所有删除的固定前置步骤。
- `addSlide` 的后端建目录、刷新目录树和本地切页不是原子事务。建目录成功但刷新/切页失败时，Bridge
  先恢复原页内容、目录树、选区和 dirty，再自动尝试 `deletecatalog(addId)` 清理新目录。抛出的错误带
  `createdSlideId`、`rollbackApplied`、`cleanupApplied` 和 `outcome`：
  `created-slide-cleaned-up` 表示补偿删除成功；`orphan-slide-may-remain` 表示删除失败，并附
  `cleanupFailure`。后者必须用 `listSlides/refreshSlideMenu` 复读后再决定人工补偿，不能直接重试创建。
- 错误信息：轮询通道会把 axios 拦截器 reject 的 `response.data`（含 `msg` 字段）解析为可读文本；旧版直接 `String(err)` 会得到 `[object Object]`，已修复。
