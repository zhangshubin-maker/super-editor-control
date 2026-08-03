---
name: super-editor-canvas
description: 超媒编辑器（super-editor-control 插件）画布与收尾技能。在需要切换/新增/删除/排序页面（slide）、滚动定位画布（scrollToBlock/scrollToElement/scrollCanvas）、截图核对渲染、快照回滚（checkpoint/rollback，替代撤销重做）、保存课件时使用。覆盖 window.__superEditor 的 selectSlide/addSlide/deleteSlide/moveSlide/checkpoint/rollback/save/screenshot 及视图方法。
---
# Super Editor Canvas（画布/页面/历史/保存）

## 1. 页面（slide）管理

| 方法 | 参数 | 返回 |
|------|------|------|
| `selectSlide(slideId)` | 标量 | 无（加载该页并切换） |
| `addSlide(payload)` | `{ name?, parentId?, template_id?, type? }`（不传 template_id 时自动创建空白页） | `{ slideId }` |
| `deleteSlide(slideId)` | 标量 | 无（写库操作，谨慎） |
| `renameSlide(slideId, name)` | (标量, string) | 无（目录重命名，即时写库） |
| `duplicateSlide(slideId)` | 标量 | `{ slideId }`（服务端复制整页，即时写库） |
| `getSlideMenu()` | 无 | 目录树 |
| `moveSlide(payload)` | `{ slideId, toIndex }` | 无（同级排序） |

```js
await b.selectSlide('3589')                    // 切到第 2 页
const r = await b.addSlide({ name: 'Module 2 Unit 4 预习' })  // 新建空页
await b.moveSlide({ slideId: '3589', toIndex: 0 })
```

- `addSlide`/`deleteSlide`/`moveSlide` 直接调目录接口**立即写库**（与区块/元素不同，没有"保存"缓冲），执行前必须确认。
- `addSlide` 未传 `template_id` 时，桥接自动复用模板库空白样章模板，没有则自动创建一个空白样章模板（后端要求 `template_id >= 1`，空串会被拒绝）。自主设计新目录时先加载 `super-editor-assets`，用 `editor_search_templates({ kind: 'chapter' })` 选型，再用 `editor_apply_template({ kind: 'chapter', ... })` 新增。
- 切换页面会丢弃未保存的当前页内存改动吗？不会——但建议先 `save()` 当前页再切换，避免混淆。

## 2. 快照 / 回滚 / 脏状态（ai_control 专用，替代撤销/重做）

> ai_control 模式**不写撤销/重做操作栈**（编辑器 commonDataUndo 不入栈），`undo()/redo()/canUndo()/canRedo()` 一律返回 `{ disabled: true, reason }`。回退统一用整页深拷贝快照。

| 方法 | 参数 | 说明 |
|------|------|------|
| `checkpoint({ label? })` | `{ label?: string }` | **任务开始或关键大节点前调用**：深拷贝整页画布存为快照，返回 `{ checkpointId, slideId, label, time, blockCount, elementCount }`。整页拷贝开销大，**不要频繁调用** |
| `rollback({ checkpointId })` | `{ checkpointId: string }` | 任务取消/失败时恢复画布到快照状态（仅限同一页面；快照在页面刷新后失效） |
| `listCheckpoints()` | 无 | 列出全部快照元信息 |
| `clearCheckpoints()` | 无 | 任务成功后清理全部快照 `{ cleared }` |
| `getHistoryState()` | 无 | `{ canUndo: false, canRedo: false, undoDisabled: true, reason, checkpointCount, checkpoints }` |
| `isDirty()` | 无 | 是否有未保存改动（供保存决策） |

```js
const ck = await b.checkpoint({ label: '重构前基线' })   // 关键节点打快照
// ...执行编辑...
const cks = await b.listCheckpoints()
await b.rollback({ checkpointId: ck.checkpointId })       // 不满意则回滚
await b.clearCheckpoints()                                // 任务成功后清理
```

纪律：任务开始打一个 checkpoint；每个可能出错的大改动（删区块、批量调整、整页重构）前再打一个；失败立即 `rollback()` 恢复，成功后 `clearCheckpoints()`。

## 3. 截图与渲染核对

### 3.1 截图能力与限制（重要）
- `screenshot(opts)` 用项目 `utils/html-to-image`（toPng/toCanvas）截图，支持三种模式：
  - `screenshot({})`：当前视口（`#canvas-ref`）
  - `screenshot({ blockId })`：指定区块（`#template-container-<uuid>`；ai_control 模式区块全量渲染，任意区块可截）
  - `screenshot({ fullPage: true })`：遍历全部区块逐块截图并纵向拼接为整页
- MCP 工具 `editor_screenshot` 返回 **image 内容块**，模型可直接看到图片，用于排版/视觉核对。
- 已知局限：canvas 类区块（四线三格、手写格）与跨域图片可能渲染为空；布局核对请结合 `editor_canvas_tree` 数值（left/top/width/height）双通道确认。

### 3.2 滚动定位与核对（画布虚拟滚动，必须走桥接）
`scrollTop` 赋值无效（编辑器自定义滚动接管），**禁止用鼠标滚轮模拟**。一律用桥接方法：

| 方法 | 说明 |
|------|------|
| `scrollToBlock(blockId)` | 滚动到区块顶部附近（基于 `blockTemplateListTopMap`） |
| `scrollToElement(elementId)` | 元素超出可视区时自动滚动到可见（走 `setScrollIntoElement`） |
| `scrollCanvas({ deltaX?, deltaY? })` | 相对滚动（viewportLeft/Top 增量） |
| `setViewport({ left?, top? })` | 绝对定位（viewport 左上角坐标，top 通常为负） |
| `setZoom(scale)` | 缩放（0.1~3） |
| `zoomIn(step?)` / `zoomOut(step?)` | 步进缩放（默认 0.1） |
| `fitCanvas()` | 自适应窗口并居中 |
| `scrollToTop()` / `scrollToBottom()` | 页首/页尾 |
| `clearSelection()` | 清空选中 |
| `getCanvasInfo()` | `{ slideId, canvasWidth, canvasHeight, scale, viewportLeft, viewportTop, stats }` |
| `exportSlide(slideId?)` | 整页 JSON（备份/复用） |
| `replaceSlideContent(slideId, blocks)` | 清空目标页后重建（谨慎） |
| `getViewport()` | 读取当前 `{ left, top, scale, canvasWidth, canvasHeight }` |

```js
await b.scrollToBlock('w8fecasuXh12577')        // 定位到区块
await b.scrollToElement('RuAt6oqsOT')           // 定位到元素
const vp = await b.getViewport()                // 确认视口
```

### 3.3 截图（经桥接）
```js
await b.screenshot({})                  // 当前视口
await b.screenshot({ blockId: 'xxx' })  // 指定区块（template uuid）
await b.screenshot({ fullPage: true })  // 整页拼接（34 区块约 5-10s）
```

## 4. 保存（save）

```js
const dirty = await b.isDirty()
if (dirty) {
  const r = await b.save()   // POST 整页 content_ens 到服务端
  return r
}
```

- `save()` 一次性提交**当前页全部区块**（含元素、图片、表格），成功后标记已提交。
- 保存是写库动作：**保存前备份**（`getSlide` 全量 JSON 落盘），保存后 `Page.reload` 重新加载并从服务端 `getSlide` 验证（区块数、新增/改名/删除是否生效）。

## 5. 推荐收尾流程（编辑任务）

1. `checkpoint({ label: "任务前基线" })` → 2. 小步执行编辑 → 3. 每步 `getSlide`/滚动核对 → 4. 不满意用 `rollback({ checkpointId })` 回退 → 5. `save()` → 6. `Page.reload` 后 `getSlide` 验证持久化 → 7. 任务成功 `clearCheckpoints()` → 8. 告知用户刷新页面查看。

## 6. MCP 工具对照

| 桥接方法 | MCP 工具 |
|---------|---------|
| `selectSlide` | `editor_select_slide` |
| `checkpoint` / `rollback` / `listCheckpoints` / `clearCheckpoints` | `editor_checkpoint` / `editor_rollback` / `editor_list_checkpoints` / `editor_clear_checkpoints` |
| `save` | `editor_save` |
| `screenshot` | `editor_screenshot` |
| `addSlide`（空白）/ `deleteSlide` / `moveSlide` / `canUndo`（已禁用） | `editor_rpc_call` |
| `applyTemplate({ kind: 'chapter', ... })` | `editor_apply_template` |
