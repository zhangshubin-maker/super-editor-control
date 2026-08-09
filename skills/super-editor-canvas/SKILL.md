---
name: super-editor-canvas
description: 超媒编辑器页面与画布收尾技能。在需要安全切换目录、增删移动页面、滚动定位、缩放视口、截图核对、建立或回滚当前页快照、导出/替换页面内容及保存当前页时使用。布局几何调整优先加载 super-editor-layout，完整当前页制作加载 super-editor-page-authoring。
---

# Super Editor Canvas

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。该策略是 checkpoint、
保存、dirty 切页、立即持久化和验证范围的唯一来源。

## 页面与安全切换

| 意图 | MCP 工具 |
|---|---|
| 列出目录 | `editor_list_slides` |
| 安全切换目录 | `editor_select_slide` |
| 新增/删除/移动目录 | `editor_add_slide` / `editor_delete_slide` / `editor_move_slide` |
| 重命名/复制目录 | `editor_rename_slide` / `editor_duplicate_slide` |
| 新增样章目录 | `editor_apply_template({ kind: 'chapter', ... })` |
| 其他页面操作 | 优先专用 MCP；没有时才用 `editor_rpc_call` |

目录增删移动、重命名、复制和应用 chapter 模板都会立即写库，当前页 checkpoint 不能回退。

```text
editor_select_slide({ slideId: "3589", saveBeforeSwitch: true })
```

当前页 dirty 时必须显式选择 `saveBeforeSwitch: true` 或在用户明确要求放弃时传
`discardChanges: true`；不要假设切页会自动保存，也不要同时传两个选项。

## checkpoint 与 rollback

| MCP 工具 | 用途 |
|---|---|
| `editor_checkpoint` | 中高风险当前页结构写入前建立一次整页快照 |
| `editor_rollback` | 仅恢复同一会话的当前页工作副本 |
| `editor_list_checkpoints` | 查看本会话快照 |
| `editor_clear_checkpoints` | 确认不再需要恢复时清理 |

micro 目标修改默认不打 checkpoint；不要把任务开始当成无条件触发器。

```text
editor_checkpoint({ label: "重排当前练习区前" })
editor_rollback({ checkpointId: "返回的 checkpointId" })
```

## 视图与截图

`editor_screenshot` 支持当前视口、指定区块和 full page。定位与缩放优先使用
`editor_scroll_to_block`、`editor_scroll_to_element`、`editor_set_zoom` 和 `editor_fit_canvas`；只有当前
tools/list 没有覆盖的视口操作才使用 `editor_rpc_call`。

```text
editor_scroll_to_block({ blockId: "block-uuid" })
editor_screenshot({ blockId: "block-uuid" })
editor_get_canvas_tree({})
```

- 当前页布局优先截受影响区块；整页流向变化或跨区块视觉关系本身是验收目标时，必须截 full page。
- canvas 类内容和跨域图片可能截图为空；结合正确的 `editor_get_canvas_tree`、文本布局检查和预览。
- 截图只能辅助判断视觉效果，不能证明媒体播放、Tab 切换或学生端互动可用。

## 保存与回读

当前页 dirty 时统一使用：

```text
editor_save_verified({
  scope: "current",
  expectedSlideId: "当前 slideId",
  verify: true
})
```

核对返回的 slideId、dirty、保存前后 hash 和回读结果；该工具已经负责后端回读，不额外刷新页面。
book 任务每页保存 current，`scope=book` 不会替代逐页保存。

整页导出使用 `editor_export_slide`；替换没有专用工具时才使用 `editor_rpc_call` 的
`replaceSlideContent`。
替换整页属于高风险结构写入，先确认目标并按公共策略建立 checkpoint；导出到磁盘只在确有跨会话
恢复需求且宿主支持文件系统时进行。
