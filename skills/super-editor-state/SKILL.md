---
name: super-editor-state
description: 超媒编辑器（super-editor-control 插件）状态读取技能。在需要了解课件现状、读取页面/区块/元素树、理解元素类型与结构、查找重复区块、判断脏状态时使用。负责通过 window.__superEditor 的 getState/getSlide/listSlides/isDirty 等只读方法获取画布全貌，为编辑/优化任务提供数据基础。
---
# Super Editor State（读取与理解画布）

所有编辑任务的第一步：**先读后改**。本技能覆盖桥接对象（`window.__superEditor`）的全部只读能力与数据结构理解。

## 1. 前置：确认桥接可用

- 页面必须带 `ai_control=1` 打开，且已挂载桥接。挂载标记：`document.documentElement.getAttribute('data-super-editor-bridge') === '1'`。
- 浏览器扩展/内置浏览器的 evaluate 是**只读沙箱**，读不到 `window.__superEditor`；一律通过同源 RPC 通道调用桥接方法（页面侧轮询执行，等效主世界调用），不要尝试在沙箱里直接执行桥接代码。
- 连接方式见主技能 `super-editor-control` 第 2 节。

## 2. 只读方法速查

| 方法 | 参数 | 返回 |
|------|------|------|
| `ping()` | 无 | `{ version, editorType, bookId, mode }` |
| `getState()` | 无 | 书本信息 + 全部页面 + 当前页 + 选中元素 + 脏状态 |
| `listSlides()` | 无 | `[{ id, name, pageId }]`（同 getState().slides） |
| `getOutline({ slideId? })` | 可选标量 | `{ slideId, outline: [大纲树], selectedOutlineId }`（目录级大纲；详见 `super-editor-outline` 技能，v0.8） |
| `getUserInfo(payload?)` | `{ refresh? }` | 当前登录用户信息（素材权限判断） |
| `searchTemplates(payload)` | `{ kind: chapter/block, query?, pageNo?, pageSize?, classifyId?, parentId? }` | 当前书本可用模板元数据；详细素材流程见 `super-editor-assets` |
| `getSlide(slideId)` | **标量** string/number | `{ slide: {...}, blocks: [...] }` |
| `getBlock(blockId)` | 标量 uuid | `{ blockId, name, size, elements }`（单区块含元素树） |
| `listElements(filter?)` | `{ blockId?, type? }` | 扁平元素列表（id/name/type/left/top/width/height/blockId） |
| `findElements(filter?)` | 同 `listElements` | 同 `listElements`（别名） |
| `getCanvasTree()` | 无 | 整页结构化树（区块+元素树+统计），AI 理解画布首选 |
| `getSlideStats()` | 无 | `{ blockCount, elementCount, typeCounts, wordCount }` |
| `listBlocks()` | 无 | `[{ blockId, index, name, size, elementCount }]` |
| `searchElements(filter?)` | `{ keyword?, type?, blockId? }` | 按名称/内容/类型搜索元素 |
| `getElementsBounds(elementIds)` | `string[]` | 多元素包围盒 `{ minX, minY, maxX, maxY, width, height, centerX, centerY }` |
| `getHistoryState()` | 无 | `{ canUndo: false, canRedo: false, undoDisabled: true, reason, checkpointCount, checkpoints: [{ checkpointId, slideId, label, time }] }`（ai_control 无撤销栈，看快照） |
| `listElementTypes()` | 无 | 全部元素类型及默认尺寸（编辑/创建前查询） |
| `getElementSchema(type)` | string | 该类型默认结构 + 可设置字段说明（对照 `元素结构说明文档.md`） |
| `isDirty()` | 无 | `Boolean`（是否有未保存改动） |

> ⚠️ 参数坑：`getSlide(slideId)` 等所有 id 参数都是**标量**。传 `{ slideId: 3562 }` 对象会被当成 id 序列化进请求体，服务端报 `Cannot deserialize value of type int from Object value`。

## 3. 数据结构（画布层级）

```
页面 slide（目录项，如 catalog_id=3562）
 └─ 区块 block（模板 template_type=2，字段：uuid/name/size/elements）
     └─ 元素 element（含 group 容器）
         └─ 组内子元素 child_list（坐标相对组）
```

- `getSlide()` 返回的 `blocks[]` 已归一化：`{ uuid, name, size: {width, height, paddingTop, paddingBottom, type}, elements: [...] }`。
- 元素通用字段：`id`、`type`、`templateId`（所属区块 uuid）、`groupId`（父组 id，顶层为 0）、`left/top/width/height/rotate`、`child_list`（组元素独有）。
- 原始模板字段（store 里）：`template_data_content`（运行时数据，含 name/size/elements）与 `template_info.content`（服务端存档，可能含旧格式 elements）并存；**运行时以 template_data_content 为准**。

## 4. 元素类型字典（编辑/创建元素时对照）

text、image、shape、line、table、video、audio、mind（思维导图）、latex、bracket（括号）、connectLine（连线）、input、outline（轮廓）、tab（选项卡）、textarea、group（组容器）。

每种类型的默认结构见 `super-editor-elements` 技能第 3 节；更细字段参考仓库 `元素结构说明文档.md` 与 `src/mixins/element/createElement.js`。

## 5. 实战检查清单

### 5.1 读取整页（编辑前必做）
```js
// 同源 RPC 调用模板（MCP 工具 editor_get_state / editor_get_slide，或 editor_rpc_call({ method: 'getState' })）
(async () => {
  const b = window.__superEditor
  const state = await b.getState()
  const slide = await b.getSlide(state.currentSlideId)
  return {
    slide: slide.slide,
    blockCount: slide.blocks.length,
    blocks: slide.blocks.map((blk, i) => ({
      index: i, uuid: blk.uuid, name: blk.name,
      size: blk.size,
      elementCount: (blk.elements || []).length
    }))
  }
})()
```

### 5.2 查找疑似重复区块
同名 ≠ 重复。逐块比对：
1. 元素 id 集合是否一致
2. 图片元素 `src` 是否相同
3. 文本元素 `content` 是否相同
4. 坐标/尺寸是否相同

相同才删除（用 `super-editor-blocks` 的 `deleteBlock`）。

### 5.3 编辑前备份
先 `checkpoint({ label: "编辑前基线" })` 在页面内打整页快照（ai_control 回滚首选，`rollback({ checkpointId })` 即恢复）；再把 `getSlide()` 完整返回 JSON 落盘（如 `.ai-control-backup/slide-<id>-original.json`），用于跨会话/前后对比。

## 6. MCP 工具对照

| 桥接方法 | MCP 工具 |
|---------|---------|
| `ping()` | `editor_status` |
| `getState()` | `editor_get_state` |
| `listSlides()` | `editor_list_slides` |
| `getSlide(slideId)` | `editor_get_slide` |
| `getOutline({ slideId? })` | `editor_outline_info` |
| `isDirty()` | 无（`editor_get_state` 返回 dirty） |
