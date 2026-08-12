---
name: super-editor-elements
description: 超媒编辑器通用元素操作技能。用户要求新增、删除、复制、移动、缩放、旋转、对齐、分布、调整层级、打组或解组画布元素时使用；表格和思维导图的结构操作也由本技能路由。文本内容、富文本格式和文本框适配改用 super-editor-text，完整页面编排改用 super-editor-page-authoring，系统性布局调整配合 super-editor-layout。
---

# Super Editor Elements

执行任何写操作前读取公共
[任务策略](../super-editor-control/references/task-policy.md)。公共策略决定读取范围、checkpoint、保存和验证，
本技能只负责元素领域操作。

## 核心边界

- 使用 `editor_*` MCP 工具，不在浏览器 evaluate 中调用 `window.__superEditor`。
- `editor_update_element` 只修改几何、通用样式和资源等字段。**禁止**用它写文本元素的
  `content`、`hyperlinkParamList` 或字数统计字段；这些字段必须交给 `super-editor-text`。
- `patch` 是浅合并；修改 `background`、`outline` 等嵌套对象前先读完整对象，再整体传回。
- 坐标是所属区块的局部坐标；即使元素位于组内，子元素的 `left/top` 仍然是相对所属区块的坐标，不是相对父组的坐标。移动组可能影响全部子元素。
- 不套用固定品牌色、字体或字号；先复用当前书和代表性模板的设计语言。

## 常用 MCP 工具

| 意图 | MCP 工具 | 说明 |
|---|---|---|
| 读元素 | `editor_get_element` | 读取完整元素和真实 `blockId` |
| 搜索元素 | `editor_search_elements` | 按当前页名称、内容、类型或区块缩小目标 |
| 新增 | `editor_add_element` | 传 `blockId/type/payload` |
| 修改通用属性 | `editor_update_element` | 几何、通用样式、非富文本字段 |
| 精确移动/缩放/旋转 | `editor_move_element` / `editor_resize_element` / `editor_rotate_element` | 单元素 typed 操作；移动支持组内子元素，无需解组 |
| 删除 | `editor_delete_element` | 删除前按公共策略判断风险 |
| 批量复制 | `editor_duplicate_elements` | 支持偏移量 |
| 批量偏移 | `editor_move_elements_by_offset` | 相对移动多个元素 |
| 对齐/间距/区块内居中 | `editor_align_elements` / `editor_set_element_spacing` / `editor_center_element_in_block` | 优先使用 typed 几何封装 |
| 打组/解组 | `editor_group_elements` / `editor_ungroup` | 打组至少两个元素 |
| 调层级 | `editor_order_element` | `front/forward/backward/back` |
| 其他桥接能力 | `editor_rpc_call` | 仅在没有专用 MCP 工具时使用 |

MCP-first 示例：

```text
editor_add_element({
  blockId: "block-uuid",
  type: "shape",
  payload: { left: 120, top: 80, width: 240, height: 100 }
})

editor_update_element({
  elementId: "element-id",
  patch: { opacity: 0.9 }
})

editor_move_element({ elementId: "element-id", x: 140, y: 90 })
editor_resize_element({ elementId: "element-id", width: 260, height: 120 })
editor_group_elements({ elementIds: ["a", "b"] })
editor_order_element({ elementId: "a", position: "front" })
```

修改文本时改用：

```text
editor_text_document({ elementId: "text-id" })
editor_text_edit({
  elementId: "text-id",
  action: "findReplace",
  match: "旧文案",
  text: "新文案",
  expectedContentHash: "刚读取的文本 contentHash"
})
```

## 按需读取

- 表格行列、合并拆分、单元格结构：[table.md](references/table.md)。单元格富文本仍用
  `super-editor-text` 的 `tableCell` target。
- 思维导图节点树、结构与主题：[mind-map.md](references/mind-map.md)。节点富文本仍用
  `super-editor-text` 的 `mindNode` target。
- 上传及新增/替换图片：[media.md](references/media.md)。素材库优先使用 `super-editor-assets`。
- 文本自适应联动的历史实测信息仅在排障时读取：
  [text-layout-observations.md](references/text-layout-observations.md)。
- Tab 控件不是默认课件创作重点；只有用户明确要求 Tab 结构时读取
  [tab.md](references/tab.md)。

## 工作流

1. 按规模只读目标元素、所属区块和必要兄弟元素；目标明确时不读取整页。
2. 结构性或多元素重排按公共策略建立一次 checkpoint；单元素可复读修改默认不建立整页快照。
3. 优先使用专用 MCP 工具；只有工具表没有覆盖的方法才使用 `editor_rpc_call`。
4. 复读受影响元素。尺寸或位置变化时加载 `super-editor-layout` 检查边界、对齐和遮挡。
5. 当前页 dirty 时按公共策略调用 `editor_save_verified(scope=current)`。

新增元素后以工具返回的 `elementId` 为准，不猜生成 id；删除或批量操作发生
`OUTCOME_UNKNOWN` 时先读取目标，禁止直接重放。
