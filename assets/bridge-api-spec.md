# window.__superEditor 桥接 API 契约（v0.9）

本文档定义 super-editor 编辑器侧需要实现的桥接层接口，供 Codex 通过浏览器控制编辑器（本插件 skill / MCP 的调用依据）。

## 1. 启用与挂载

- 仅在 URL 带 `ai_control=1` 时挂载 `window.__superEditor`（开发/测试环境），生产环境默认关闭。
- 建议页面加载完成后（`mounted` 之后）挂载，路由销毁时移除：`delete window.__superEditor`。
- 提供一个 `window.__superEditor.disable()` 以便随时摘除。

## 2. 调用约定

- 所有方法返回 `Promise`；内部实现必须走 Vuex mutation/action（与用户 UI 操作同一条链路），保留操作日志。
- **ai_control 模式不写撤销/重做操作栈**（编辑器的 `commonDataUndo` 在该模式下不再入栈），回退一律用 §4.4 的整页深拷贝快照 `checkpoint()` / `rollback()`；默认编辑器（非 ai_control）行为完全不变。
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
  uuid, name,
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
  slides: [ { id, name, pageId } ],
  currentSlideId,
  selection: [ elementId ],
  dirty: Boolean
}

// getSlide(slideId) 返回
{
  slide: { id, name, size: { width, height }, background },
  blocks: [ { uuid, name, size: { width, height }, elements: [ element ] } ]
}
```

## 4. 方法清单

### 状态与查询

| 方法 | 参数 | 返回 |
|------|------|------|
| `ping()` | 无 | `{ version, editorType, bookId, mode }` |
| `getState()` | 无 | 见上 |
| `listSlides()` | 无 | `[{ id, name, pageId }]` |
| `listTemplates(payload)` | `{ pageNo?, pageSize?, type?, name?, timeSort? }`（type：2=区块模板，3=样章模板） | `[{ id, name, type, parentId, cover }]` |
| `getSlide(slideId)` | string | 见上 |
| `getBlock(blockId)` | string | `{ blockId, name, size, elements }`（单区块含元素树） |
| `getElement(elementId)` | string | 元素完整数据（含 `blockId`） |
| `listElements(filter?)` | `{ blockId?, type? }` | 扁平元素列表 `[{ id, name, type, left, top, width, height, blockId }]` |
| `findElements(filter?)` | 同 `listElements` | 同 `listElements`（别名） |
| `getCanvasTree()` | 无 | 整页结构化树：`{ slide, blocks: [{ blockId, index, name, size, elementCount, elements }], stats: { blockCount, elementCount, typeCounts } }`（AI 理解画布首选） |
| `getSlideStats()` | 无 | `{ blockCount, elementCount, typeCounts, wordCount }` |
| `listBlocks()` | 无 | `[{ blockId, index, name, size, elementCount }]` |
| `getBlockIndex(blockId)` | string | 区块在当前页原始下标 |
| `searchElements(filter?)` | `{ keyword?, type?, blockId? }` | 按名称/内容/类型搜索 `[{ id, name, type, left, top, width, height, blockId, inGroup }]` |
| `getElementsBounds(elementIds)` | `string[]`（顶层元素） | `{ minX, minY, maxX, maxY, width, height, centerX, centerY }`（包围盒） |
| `getHistoryState()` | 无 | `{ canUndo: false, canRedo: false, undoDisabled: true, reason, checkpointCount, checkpoints: [{ checkpointId, slideId, label, time }] }` |
| `listElementTypes()` | 无 | `[{ type, name, defaultWidth, defaultHeight }]`（全部元素类型） |
| `getElementSchema(type)` | string | `{ type, typeName, defaults, commonProps, typeProps }`（该类型默认结构与可设置字段） |
| `isDirty()` | 无 | `Boolean` |

### 页面（slide）

| 方法 | 参数 | 返回 |
|------|------|------|
| `selectSlide(slideId)` | string | 无 |
| `addSlide(payload)` | `{ name?, parentId?, template_id?, type? }`（不传 template_id 时自动复用/创建空白样章模板） | `{ slideId }` |
| `deleteSlide(slideId)` | string | 无 |
| `renameSlide(slideId, name)` | (string, string) | 无（目录重命名，即时生效） |
| `duplicateSlide(slideId)` | string | `{ slideId }`（服务端复制整页含内容） |
| `getSlideMenu()` | 无 | 目录树（当前 store 内的书本目录） |
| `refreshSlideMenu()` | 无 | 无（重新拉取目录） |
| `moveSlide(payload)` | `{ slideId, toIndex }`（同级排序） | 无 |

### 区块（block）

| 方法 | 参数 | 返回 |
|------|------|------|
| `addBlock(payload)` | `{ afterBlockId?, size? }` | `blockId` |
| `cloneBlock(blockId, opts?)` | `(uuid, { afterBlockId?, name? })` | `blockId`（新，元素 id 自动重生成） |
| `updateBlock(payload)` | `{ blockId, patch }`（patch 支持 `name`、`size` 等） | 无 |
| `deleteBlock(blockId)` | string | 无 |
| `moveBlock(payload)` | `{ blockId, toIndex }` | 无 |
| `insertBlocks(blocks, opts?)` | `(模板数组, { index? })` | `{ blockIds }`（批量插入，uuid 自动重新生成，元素 id 冲突自动替换） |
| `importBlocks(slideId, blocks, opts?)` | `(string, 模板数组, { index? })` | `{ slideId, blockIds }`（跨页导入：自动切换到目标页并插入） |
| `replaceBlock(blockId, templateData)` | (string, 模板对象) | `{ blockId }`（整体替换区块内容，保持原位置与原 uuid） |
| `renameBlock(blockId, name)` | (string, string) | 无 |
| `copyBlockToSlide(blockId, targetSlideId, opts?)` | `(string, string, { index? })` | `{ slideId, blockIds }`（跨页复制；目标页不同时当前页会切到目标页） |
| `insertTemplate(templateData, index?)` | 模板结构对象 + 插入位置（省略追加末尾） | `blockId`（原样插入，元素 id 保留；用于恢复/迁移区块） |

### 元素（element）

| 方法 | 参数 | 返回 |
|------|------|------|
| `addElement(payload)` | `{ blockId, type, payload }` | `elementId` |
| `updateElement(payload)` | `{ elementId, patch }` | 无 |
| `deleteElement(elementId)` | string | 无 |
| `moveElement(payload)` | `{ elementId, x, y }` | 无 |
| `resizeElement(payload)` | `{ elementId, width, height }` | 无 |
| `rotateElement(payload)` | `{ elementId, angle }` | 无 |
| `duplicateElement(elementId)` | string | `elementId`（新） |
| `addElements(payload)` | `{ blockId, elements: [{ type, payload }] }` | `{ elementIds }`（批量新增） |
| `updateElements(payload)` | `{ elementIds, patch }` | 无（批量改属性，一次 dispatch） |
| `deleteElements(elementIds)` | `string[]` | 无 |
| `duplicateElements(elementIds, opts?)` | `(string[], { offsetX?, offsetY? })` | `{ elementIds }`（批量复制，默认 +20/+20） |
| `moveElements(payload)` | `{ elementIds, x, y }` | 无（顶层元素左上角移到指定点） |
| `moveElementsByOffset(payload)` | `{ elementIds, dx?, dy? }` | 无（相对偏移） |
| `alignElements(payload)` | `{ elementIds, align, target? }`，align ∈ `top/bottom/left/right/horizontal/vertical/center/hdengju/vdengju`，target ∈ `selection/canvas` | `{ align, target, elementCount }`（对齐/等间距，与编辑器快捷键一致） |
| `setElementSpacing(payload)` | `{ elementIds, direction: horizontal/vertical, spacing }` | `{ direction, spacing, elementCount }`（按方向重排为等间距） |
| `centerElementInBlock(payload)` | `{ elementId, axis: horizontal/vertical/both }` | 无（在所属区块内居中） |
| `lockElements(elementIds, locked?)` | `(string[], boolean)` | 无（isLock） |
| `hideElements(elementIds, hidden?)` | `(string[], boolean)` | 无（isHidden） |
| `setElementOpacity(payload)` | `{ elementId, opacity: 0~1 }` | 无 |
| `renameElement(elementId, name)` | (string, string) | 无 |
| `flipElement(payload)` | `{ elementId, direction: horizontal/vertical }` | 无（flipH/flipV，图片/文本框） |
| `setElementText(payload)` | `{ elementId, content }` | 无（text/shape/input/textarea/mind 写 content，latex 写 latex） |
| `setImageSrc(payload)` | `{ elementId, src }` | 无（image/video 换资源地址） |
| `setTextStyle(payload)` | `{ elementId, style: { fontSize?, color?, lineHeight?, fontName?, fontWeight?, verticalAlign?, wordSpace?, adaptive? } }` | 无（映射到文本元素顶层样式字段） |
| `orderElement(payload)` | `{ elementId, position }`，position ∈ `front/forward/backward/back` | 无 |

### 打组

| 方法 | 参数 | 返回 |
|------|------|------|
| `groupElements(elementIds)` | `string[]` | `groupId` |
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

### 图片上传与使用（v0.9：生图 → 上传 → 放入课件）

图片上传复用项目标准 `upLoadFile`（uploadfile）通道，在编辑器页面内携带登录态完成；调用方只需传 base64 / dataURL 图片数据或直接传 url。

| 方法 | 参数 | 返回 |
|------|------|------|
| `uploadImage(payload)` | `{ data, fileName?="ai-image.png", mimeType?="image/png" }`（data 支持纯 base64 或 dataURL） | `{ url, fileId, fileName }` |
| `addImageElement(payload)` | `{ blockId, url?, data?, left?, top?, width?, height?, name?, fixedRatio?=true }`（传 data 时自动先上传） | `{ url, elementId }` |
| `setImageElementSrc(payload)` | `{ elementId, url?, data? }`（image/video 元素；传 data 时自动先上传） | `{ url, elementId }` |

- 只传 `url` 时不触发上传，适合直接使用外链或媒体库已有地址。
- 上传返回的 `url` 可直接作为图片元素 `src`、文本背景图 `background.image`（经 `updateElement` patch）或思维导图节点 `image`。
- 推荐工作流（模型具备生图能力后）：生成本地 PNG → MCP `editor_upload_image`（传 `imagePath`）或桥接 `uploadImage` → `editor_add_element(type=image, payload={src})` 或 `addImageElement` → `moveElement/resizeElement` 排版。
- 上传接口失败会抛错并返回服务端信息；图片过大（>10MB）或敏感内容被服务端拦截时请重试/调整提示词。

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
| 文本（v0.6，自适应：`background.extendType` = both/horizontal/vertical/none，`maxWidth/maxHeight` 上限，背景图尺寸为下限，组内元素自动联动位移） | | |
| `getTextInfo(payload)` | `{ elementId }` | `{ elementId, blockId, content(HTML), text(纯文本), wordCount, font, lineHeight, wordSpace, verticalAlign, textAlign, adaptive, overflowType, maxWidth, maxHeight, padding, background{type,extendType,color,image,width,height}, geometry, groupId, isLock, isHidden }` |
| `setTextContent(payload)` | `{ elementId, content, fitSize?, waitMs? }`（纯文本自动包 `<p>`，`\n` 自动拆成多段；fitSize 默认 true 触发自适应） | `{ elementId, content, text, extendType, width, height, dWidth, dHeight, autoResized, moved[] }` |
| `setTextAdaptive(payload)` | `{ elementId, extendType, fitSize? }`（both/horizontal/vertical/none） | `{ elementId, extendType, previous, width, height, dWidth, dHeight, autoResized, moved[] }` |
| `fitTextSize(payload)` | `{ elementId, waitMs? }`（强制重测） | `{ elementId, width, height, dWidth, dHeight, autoResized, moved[] }` |

### 数据交换（备份 / 整页导入导出）

| 方法 | 参数 | 返回 |
|------|------|------|
| `exportSlide(slideId?)` | string（省略=当前页） | `{ slideId, blocks }`（整页完整数据，可用于备份/跨页复用） |
| `replaceSlideContent(slideId, blocks)` | `(string, 模板数组)` | `{ slideId, blockIds }`（清空目标页后重建；传空数组=清空页面） |
| `getBridgeInfo()` | 无 | `{ version, instanceId, bookId, methods }`（methods 为全部可用方法名） |
| `batch(payload)` | `{ steps: [{ method, args }], stopOnError? }` | `{ results: [{ index, method, ok, value/error }], stopped, stoppedAt }`（一次往返串行执行多步，见下） |
| `screenshot(payload)` | `{ fullPage?, blockId? }` | `data:image/png;base64,...`（默认当前视口；`fullPage: true` 全部区块拼接整页；`blockId` 指定单区块） |

## 5. 实现注意事项

- **走 Vuex action**：所有写操作 dispatch 现有 action（见 `editor-integration-guide.md` 的映射表），这样 `commonDataSave` 会记录操作日志；**ai_control 下 `commonDataUndo` 不入栈**，撤销/重做由快照（checkpoint/rollback）承担，避免操作栈在长链路 AI 操控下不收敛。
- **id 生成与替换**：新增元素必须生成唯一 `id`，并设置 `templateId = 所在区块 uuid`、`groupId = 0`；打组后子元素 `groupId = 组 id`；复制/深拷贝时用 `replaceElementsId` 同步替换所有子级 `groupId`。
- **高度联动**：增删改元素后调用 `updateTemplateHeightByElementList(templateId)`（现有 action 已处理）。
- **错误处理**：任何失败都 reject，消息要可读（例如 `区块不存在: xxx`）。
- **不要**在桥接里直接 `commit` 绕过日志的 mutation（除非该动作本身无操作日志需求）。


- 页面增删改会通过目录接口持久化（ddBookCatalog / deletecatalog / updatecatalogsort），其他写操作先入本地 store，save() 时统一提交。

## 6. 安全

- 桥接只在 `ai_control=1` 且非生产环境挂载；服务端若可鉴权更佳。
- 调用一律走 §6.5 的 RPC 通道（方法白名单在页面/服务端过滤）；本插件不新增远程端口，不暴露任意代码执行。
- 建议给桥接增加调用白名单/频率限制（可选）。
## 6.5 RPC 通道（推荐调用方式，生产/开发通用）

编辑器侧（`src/modules/contentEditor/aiControl/index.js`）在挂载桥接时同时启动两类通道：

### 方式 A：同源 HTTP RPC 通道（推荐，生产/开发通用）
- 桥接主世界每 400ms 轮询 `{origin}/ai-control/rpc/poll?instance=<页面实例ID>`（默认 `window.location.origin + '/ai-control'`；可用 `window.__SUPER_EDITOR_RPC_URL` 覆盖为独立本地服务，如 `http://127.0.0.1:8765`）；
- dev server（`vue.config.js` devServer.before）已内置全部端点；生产由后端按 `assets/production-integration-spec.md` 提供；
- 外部服务（RPC 服务端）为每个页面实例维护命令队列；poll 到队列有命令时返回 `{ id, method, args }`，否则返回 204；
- 桥接执行 `window.__superEditor[method](...args)` 后 POST 结果到 `/rpc/result`：`{ id, ok, value|error }`；`ping()` 返回 `instanceId`（页面自身实例 ID）；
- 调用方 `POST {origin}/ai-control/rpc/request`：`{ method, args, timeoutMs?, targetInstance? }`，服务端入队并**长轮询等待结果**（最多 90s）后响应 `{ ok, value, error, instance }`（`instance` 为实际路由的页面实例 ID）；页面实例 ID 在 `<html data-se-rpc-instance="...">` 上，`ping()` 也会返回 `instanceId`；多标签页时用 `targetInstance` 精确路由，避免旧页面抢执行；
- 实例管理：服务端按 poll 心跳维护实例列表（30s 无 poll 自动清理），`request` 不带 `targetInstance` 时路由到最近 20s 内活跃的实例；调用方可先 `ping()`（不带 target）拿 `instance` 字段，之后所有调用固定带 `targetInstance`，避免多标签页串台；
- 特性：不依赖 CDP 端口、不依赖鼠标、无跨域；`args` 一律为数组，方法缺失/抛错时 `ok=false` 且返回可读 `error` 文本（优先 message/msg/desc，兜底 JSON 序列化）；
- 服务端需要允许 CORS（`Access-Control-Allow-Origin: *`）并处理 OPTIONS 预检（同源调用其实不需要）。

### 方式 B：DOM 属性通道（备用，供可写 DOM 的隔离环境）
- 请求：`document.documentElement.setAttribute('data-se-rpc-req', JSON.stringify({ id, method, args }))`；
- 响应：`data-se-rpc-res` 属性变为 `JSON.stringify({ id, ok, value|error })`；
- 主世界通过 MutationObserver 监听 `data-se-rpc-req` 属性变化并执行。
- 注意：某些严格只读沙箱（无 `setAttribute`）只能用方式 A。

## 7. 实战经验（2026-08 首轮验证补充）

### 7.1 探测与连接
- 页面挂载后 `document.documentElement` 会出现 `data-super-editor-bridge="1"` 属性，卸载时移除。任何隔离世界/主世界都可以用它探测桥接是否就绪。
- 浏览器扩展类控制工具（如 content-script 沙箱）通常**看不到** `window.__superEditor`，此时以 DOM 标记为准；真正调用方法一律走 §6.5 同源 RPC 通道（页面侧轮询执行，等效主世界调用）。
- URL 带 `token` 时，任意浏览器打开该 URL 即可直接鉴权；调用方只需能访问同源 RPC 路由。

### 7.2 参数约定（重要）
- `getSlide(slideId)` / `selectSlide(slideId)` / `deleteBlock(blockId)` 等方法的 id 参数一律是**标量**（string/number），传 `{ slideId }` 对象会触发服务端反序列化错误（`Cannot deserialize ... int from Object`）。
- `addBlock({ afterBlockId?, size? })` 返回 `{ blockId }`；`addElement({ blockId, type, payload })` 返回 `{ elementId }`；新增后可立刻 `getSlide` 校验。

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
- 元素坐标以 `getElement` / `listElements` 返回的 `left/top/width/height`（区块内相对坐标）为准；区块在画布中的绝对位置可用 `blockTemplateListTopMap` 换算。
- 编辑前先 `getSlide` 全量 JSON 备份；保存后 `Page.reload` 再从服务端读取验证持久化。

### 7.5 页面增删（addSlide/deleteSlide 实测要点）
- 后端 `addcatalogandtemplate` 校验 `template_id >= 1`：空字符串会被拒绝（`template_id 最小不能小于1`）。`addSlide` 不传 `template_id` 时桥接会自动：① 扫描模板库空白样章模板（无区块）复用；② 没有再调用 `addtemplate` 创建一个空白样章模板（按 book_id 缓存）。
- `deleteSlide` 删除当前页后会自动切回目录第一页；删除前先 `getSlide` 备份。
- 错误信息：轮询通道会把 axios 拦截器 reject 的 `response.data`（含 `msg` 字段）解析为可读文本；旧版直接 `String(err)` 会得到 `[object Object]`，已修复。
