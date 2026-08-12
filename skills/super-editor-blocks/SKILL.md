---
name: super-editor-blocks
description: 超媒编辑器区块操作技能。在需要新增、删除、复制、移动、重命名、调整尺寸、批量插入、结构性替换、保留 ID 的完整 JSON 原位替换或跨页复制当前课件区块时使用。负责区块结构，不直接修改区块内富文本；页面整体创作配合 super-editor-page-authoring，跨页制作配合 super-editor-book-authoring。
---

# Super Editor Blocks

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。公共策略决定任务规模、
checkpoint、保存和立即持久化边界。

区块是当前页的横向内容区域，元素坐标相对区块左上角。使用返回的真实 `blockId`（区块 uuid），
不要用目录 id、数据库 id 或名称代替。

## MCP 工具

| 意图 | MCP 工具 | 说明 |
|---|---|---|
| 读当前区块清单 | `editor_list_blocks` | 轻量读取顺序、名称、尺寸和元素数 |
| 读完整当前页 | `editor_get_slide` | 只有需要区块元素树或全页顺序时使用 |
| 新增空区块 | `editor_add_block` | 可传 `afterBlockId/size` |
| 更新名称或尺寸 | `editor_update_block` | `patch` 浅合并 |
| 重命名 | `editor_rename_block` | 优先于通用 RPC |
| 克隆当前页区块 | `editor_clone_block` | 生成新 blockId 和元素 id |
| 移动/结构性整体替换 | `editor_move_block` / `editor_replace_block` | 结构替换保留目标位置和 blockId，仍属于高风险写入 |
| 保留身份的 JSON 替换 | `editor_replace_block_safe` | 两阶段原位替换，保持前后端区块 id 和递归元素身份 |
| 跨页复制 | `editor_copy_block_to_slide` | dirty 源页显式先保存 |
| 删除 | `editor_delete_block` | 删除区块及全部元素 |
| 跨页导入 | `editor_import_blocks` | 目标页和模板数据必须明确 |
| 其他 Bridge 能力 | `editor_rpc_call` | 仅在没有专用 MCP 工具时使用 |

## MCP-first 示例

```text
editor_add_block({
  afterBlockId: "existing-block-uuid",
  size: { width: 794, height: 240 }
})

editor_update_block({
  blockId: "block-uuid",
  patch: { name: "知识讲解", size: { height: 320 } }
})

editor_clone_block({
  blockId: "source-block-uuid",
  afterBlockId: "source-block-uuid",
  name: "巩固练习"
})
```

```text
editor_move_block({ blockId: "block-uuid", toIndex: 3 })
```

## 工作流

1. 用 `editor_list_blocks` 核对目标和顺序；只有需要元素级证据时才读完整页。
2. 删除、替换、批量插入或跨页导入属于结构性/高风险写入，按公共策略建立 checkpoint 并确认目标。
3. 新增或克隆后使用返回的真实 blockId，复读清单核对位置、数量和尺寸。
4. 克隆区块后换文案时，先读取元素并使用 `super-editor-text`；**不要**用
   `editor_update_element.patch.content`。图片替换使用 `super-editor-assets` 或专用图片工具。
5. 多元素位置和内容适配交给 `super-editor-layout`；完整教学环节编排交给
   `super-editor-page-authoring`。
6. 当前页 dirty 时按公共策略使用 `editor_save_verified(scope=current)`。

完整区块 JSON 来自 `editor_export_slide`、仅需修改少量属性，并且挂在元素 id 上的数字模块关系必须保留时，
优先使用 `editor_replace_block_safe`：先 dry-run，核对 `changedPaths`、`identityPreserved` 和
`digitalModuleAnchorsPreserved`，再把返回的 `expectedHash` 用于正式写入。不要手工重建对象，不允许增删、
重排或重编号元素；需要结构变化时改用显式区块/元素工具。

同名不等于重复。删除前比较区块 id、文本、图片和元素结构；发生 `OUTCOME_UNKNOWN` 时先复读，
禁止直接重放删除、替换或导入。
