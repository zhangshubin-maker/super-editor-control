---
name: super-editor-blocks
description: 超媒编辑器（super-editor-control 插件）区块操作技能。在需要新增、删除、复制、移动、重命名、调整尺寸超媒画布区块（block/模板）时使用。详细描述 window.__superEditor 桥接对象中 addBlock/updateBlock/deleteBlock/moveBlock/cloneBlock 的调用方式、参数、返回值与常见坑。
---
# Super Editor Blocks（区块控制）

区块 = 画布上的一个横向区域（模板），宽度跟随画布（默认 794），内部承载元素。本技能覆盖区块级全部操作。

## 1. 方法速查

| 方法 | 参数 | 返回 |
|------|------|------|
| `addBlock(payload)` | `{ afterBlockId?, size? }` | `{ blockId }` |
| `getBlock(blockId)` | 标量 uuid | `{ blockId, name, size, elements }`（单区块含元素树） |
| `updateBlock(payload)` | `{ blockId, patch: { name?, size? } }` | 无 |
| `deleteBlock(blockId)` | 标量 uuid | 无 |
| `moveBlock(payload)` | `{ blockId, toIndex }` | 无 |
| `insertBlocks(blocks, opts?)` | `(模板数组, { index? })` | `{ blockIds }`（批量插入，uuid 重生成） |
| `replaceBlock(blockId, templateData)` | (string, 模板对象) | `{ blockId }`（整体替换，原位保持） |
| `renameBlock(blockId, name)` | (string, string) | 无 |
| `copyBlockToSlide(blockId, targetSlideId, opts?)` | `(string, string, { index? })` | `{ slideId, blockIds }`（跨页复制） |
| `importBlocks(slideId, blocks, opts?)` | `(string, 模板数组, { index? })` | `{ slideId, blockIds }`（跨页导入） |
| `cloneBlock(blockId, opts?)` | `(uuid, { afterBlockId?, name? })` | `{ blockId }`（新） |

全部走 Vuex action。ai_control 下不支持撤销/重做（操作栈已停用），删区块/批量插入前先 `checkpoint({ label })`，出错用 `rollback({ checkpointId })` 恢复整页。

## 2. 新增区块（addBlock）

```js
// 桥接调用示例：在某个区块后面插入 794x200 的新区块
(async () => {
  const b = window.__superEditor
  const r = await b.addBlock({
    afterBlockId: 'w8fecasuXh12545', // 省略则追加到末尾
    size: { width: 794, height: 200 }
  })
  return r // { blockId: 'xxxxxx' }
})()
```

- 新区块无元素，高度即 `size.height`；添加元素后高度会被 store 自动重算（`updateTemplateHeightByElementList`）。
- 区块内元素坐标是**区块局部坐标**（left/top 相对区块左上角），画布宽 794，常规内容区建议 left 75、宽 644。
- 添加元素见 `super-editor-elements`。

## 3. 修改区块（updateBlock）

```js
// 重命名
await b.updateBlock({ blockId: 'xxxx', patch: { name: '5-表格-词汇（新）' } })
// 调整尺寸（与现有 size 合并，可只传 height）
await b.updateBlock({ blockId: 'xxxx', patch: { size: { height: 300 } } })
```

## 4. 删除区块（deleteBlock）

```js
await b.checkpoint({ label: '删区块前' })  // 先打快照（ai_control 无撤销栈）
await b.deleteBlock('xxxx') // 连同内部所有元素一起删除
```

纪律：删除前先 `getSlide` 确认对象存在；疑似重复区块先比对（见 `super-editor-state` 5.2），不要仅凭同名删除。

## 5. 移动区块（moveBlock）

```js
// toIndex 是 blockTemplateList（过滤后）里的目标下标
await b.moveBlock({ blockId: 'xxxx', toIndex: 3 })
```

- 目标下标基于**当前可见区块列表**（getSlide().blocks 的下标一致），插入到该下标位置（原下标元素之前）。
- 顺序直接影响画布纵向排列与打印/预览顺序，重排前先用 `getSlide` 打印完整顺序清单。

## 6. 复制区块（cloneBlock）

```js
// 复制"学习目标"区块，插到它后面，命名为副本
const r = await b.cloneBlock('iSkXeeDCyN', {
  afterBlockId: 'iSkXeeDCyN',
  name: '2-2-学习目标（副本）'
})
// r.blockId 为新 uuid；元素全部复制，id 自动重生成（含组内 groupId 同步）
```

- 复制后元素 `templateId` 自动更新为新区块 uuid，不会与原块冲突。
- 复制大区块（如 1200px 高的表格块）会连图片/表格数据一起复制，适合"同结构换内容"的场景：复制 → `updateElement` 改文本/图片。
- 复制块的高度可能被 store 按元素实际布局重算（padding 修正），属正常行为。

## 7. 常见坑

- `deleteBlock`/`cloneBlock` 的 id 参数是**标量**；传对象会报错。
- 区块插入位置以 `afterBlockId` 指定时，若目标块不在当前页会抛 `区块不存在`。
- 重命名只改 `template_data_content.name` 与 `template_info.name`，服务端存档同步更新，安全。
- 批量操作后务必 `getSlide` 核对顺序与数量；保存见 `super-editor-canvas`。

## 8. MCP 工具对照

| 桥接方法 | MCP 工具 |
|---------|---------|
| `addBlock` | `editor_add_block` |
| `updateBlock` | `editor_update_block` |
| `deleteBlock` | `editor_delete_block` |
| `moveBlock` | `editor_rpc_call`（method: moveBlock） |
| `insertTemplate` | `editor_rpc_call`（method: insertTemplate） |
| `cloneBlock` | `editor_clone_block` |
