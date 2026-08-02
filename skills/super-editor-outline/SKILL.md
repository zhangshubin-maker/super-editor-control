---
name: super-editor-outline
description: 超媒编辑器（super-editor-control 插件）大纲能力技能。在需要读取/新增/重命名/删除/移动排序大纲节点、关联大纲与区块、维护大纲锚点，或准备「参考一个目录的大纲自动生成其他目录大纲」时使用。覆盖 window.__superEditor 的 getOutline/addOutline/renameOutline/deleteOutline/moveOutline/linkOutlineBlocks 与锚点系列方法（v0.8）。
---
# Super Editor Outline（大纲操控）

大纲是编辑器**图层面板左侧「大纲」标签**下的树（`commonOutline` store），不是画布元素。每个目录（slide/catalog）可以有自己的大纲树；大纲节点可与本页区块模板（`blockId`/uuid）关联，还可挂载锚点（位置锚点、检索锚点）。

> 先读后写：任何大纲编辑前先 `getOutline()` 拿到全量树，确认节点 id、父级与排序，再动手。

## 1. 数据模型

```js
// 大纲节点（树形，children 递归）
{
  id: 123,                 // 大纲节点 id（写接口用这个）
  book_id: 1816672,
  catalog_id: 3562,        // 所属目录/页面 id
  outline_name: '一级标题',
  parent_id: 0,            // 0=根节点，否则为父节点 id
  sort: 1,                 // 同级排序，从 1 开始
  content_uuids: ['block-uuid', ...], // 关联的区块 uuid（listBlocks 获取）
  children: []             // 子节点
}

// 锚点
{
  id, outline_id, name,
  type: 1 | 2,             // 1=位置锚点（UI 按关联区块自动维护） 2=检索锚点（AI 常用）
  position_x, position_y, width, height,
  content_uuid, relative_position_x, relative_position_y
}
```

## 2. 方法速查（桥接方法 ↔ MCP 工具）

| 能力 | 桥接方法 | MCP 工具 |
|------|---------|---------|
| 读当前页大纲 | `getOutline()` | `editor_outline_info` |
| 读任意目录大纲（不切页） | `getOutline({ slideId })` | `editor_outline_info({ slideId })` |
| 刷新当前页大纲树 | `refreshOutline()` | `editor_outline_refresh` |
| 新增节点 | `addOutline({ parentId?, sort?, name?, slideId? })` | `editor_outline_add` |
| 重命名 | `renameOutline({ outlineId, name, slideId? })` | `editor_outline_rename` |
| 删除（含子节点） | `deleteOutline({ outlineId, slideId? })` | `editor_outline_delete` |
| 移动/排序 | `moveOutline({ outlineId, parentId?, sort, slideId? })` | `editor_outline_move` |
| 关联区块（整体替换） | `linkOutlineBlocks({ outlineId, blockIds, slideId? })` | `editor_outline_link_blocks` |
| 选中/读取选中 | `selectOutline(outlineId)` / `getOutlineSelection()` | `editor_outline_select` |
| 查询锚点 | `getOutlineAnchors({ outlineId })` | `editor_outline_anchor_list` |
| 新增锚点 | `addOutlineAnchor({ outlineId, name?, type?, positionX?, positionY?, width?, height?, slideId? })` | `editor_outline_anchor_add` |
| 修改锚点 | `updateOutlineAnchor(anchor)`（含 id） | `editor_outline_anchor_update` |
| 删除锚点 | `deleteOutlineAnchor({ outlineId, anchorId })` | `editor_outline_anchor_delete` |

- `slideId` 省略一律表示当前页；传其他目录 id 可**读取**任意目录大纲。
- 跨目录**写**暂按「`selectSlide(目标页)` → `refreshOutline()` → 写入」执行；`selectSlide` 由 `super-editor-canvas` 技能提供。

## 3. 标准工作流

### 3.1 读取与核对
```js
// 一次拿到当前页大纲 + 区块清单
await b.batch({ steps: [
  { method: 'getOutline' },
  { method: 'listBlocks' }
] })
```
核对：节点 `sort` 是否连续、`parent_id` 指向是否有效、`content_uuids` 是否都是真实存在的区块 uuid。

### 3.2 新增/改名/移动（骨架搭建）
```js
// 新增根节点（追加末尾）
const root = await b.addOutline({ name: '一、词汇' })
// 新增子节点
await b.addOutline({ parentId: root.id, name: '1. 核心单词' })
// 改名
await b.renameOutline({ outlineId: root.id, name: '一、核心词汇' })
// 移动到另一个父节点下、指定同级位置
await b.moveOutline({ outlineId: root.id, parentId: 0, sort: 2 })
```

### 3.3 关联区块
```js
const blocks = await b.listBlocks() // [{ blockId, name, ... }]
// 把某个大纲节点关联到指定区块（整体替换，传 [] 清空）
await b.linkOutlineBlocks({
  outlineId: root.id,
  blockIds: [blocks[3].blockId, blocks[4].blockId]
})
```
大纲节点关联的区块会参与编辑器 UI 的「选中大纲 → 定位/选中对应区块」，以及学生端大纲弹框定位。

### 3.4 锚点
```js
// 查询
const { anchors } = await b.getOutlineAnchors({ outlineId: root.id })
// 新增检索锚点（默认 type=2）
await b.addOutlineAnchor({ outlineId: root.id, name: '核心单词区', positionX: 20, positionY: 300, width: 200, height: 80 })
// 修改（对象必须带 id）
await b.updateOutlineAnchor({ id: anchors[0].id, name: '改名后的锚点', position_y: 320 })
// 删除
await b.deleteOutlineAnchor({ outlineId: root.id, anchorId: anchors[0].id })
```
位置锚点（type=1）编辑器会在「查看关联锚点」时按关联区块自动创建/校正，AI 一般只操作检索锚点（type=2）。

### 3.5 删除
```js
await b.deleteOutline({ outlineId: root.id }) // 子节点一并删除
```
删除前建议 `getOutline()` 备份到磁盘（同 `super-editor-state` 的备份习惯）。

## 4. 自动生成其他目录大纲（准备用法）

后续如需「按已做好的目录大纲生成其他目录大纲」，推荐流程：

1. `getOutline({ slideId: 源目录 })` 读取模板大纲树（含层级、名称、区块关联结构）。
2. 逐个目标目录：`selectSlide(目标目录)` → `refreshOutline()` → 按模板结构 `addOutline`（带 `parentId`/`sort`/`name`）→ 用 `getCanvasTree`/`listBlocks` 找到对应区块并 `linkOutlineBlocks`。
3. 全部生成后 `getOutline` 抽查排序、父子关系与关联 uuid。

## 5. 注意事项

- 大纲写操作**即时持久化**（`saveoutline`/`updateoutlinesort`/`saveoutlinecontentrelation`/`addoutlineanchor` 等），不走画布 `save()`，也没有快照回滚；批量改动前先全量备份大纲树。
- `sort` 从 1 开始；同级内移动后服务端会重排，本地树在写后自动刷新。
- `content_uuids` 必须是**当前目录页面内**的区块 uuid；跨页 uuid 无效。
- 删除大纲节点会同时删除其子节点与锚点，操作前先读树确认影响范围。
- 若编辑器里看不到大纲树变化，调 `refreshOutline()` 后稍等 nextTick 再读。
