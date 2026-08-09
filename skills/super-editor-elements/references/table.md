# 表格结构操作

表格的 `tableData` 是展开网格。先用专用读取工具取得真实行列、合并关系和单元格 id，不直接拼装
完整表格 JSON。单元格局部文本、格式、链接或 embed 由 `super-editor-text` 处理。

## 工具

| 意图 | MCP 工具 | 关键参数 |
|---|---|---|
| 读取网格或结构 | `editor_table_info` | `tableId`；同时返回结构和 grid |
| 写单元格内容或背景 | `editor_table_set_cell` | `tableId`、0-based `row/col`、`content/background` |
| 更新表格字段 | `editor_table_update` | `tableId`、完整核对后的 patch |
| 行列增删、合并拆分 | `editor_table_structure` | `tableId`、结构操作及其坐标 |
| 收紧行高 | `editor_table_fit_heights` | `tableId`、可选 `waitMs/minHeight` |

以实时 MCP Schema 为准，不凭本参考猜 `operation` 枚举。

## 规则

- 合并起点格为 `isOrigin=true`；`isCovered=true` 的覆盖格不可直接写内容。
- 行列坐标从 0 开始；合并矩形的结束坐标含边界。
- 行列增删、合并拆分和整表替换属于结构性写入，先按公共策略建立当前页 checkpoint。
- 需要局部修改或保留 Quill 结构时，读取网格取得 `cellId`，再调用：

```text
editor_text_document({
  target: { kind: "tableCell", tableId: "table-id", cellId: "cell-id" }
})
```

- 内容变少或字号缩小后，编辑器可能不会自动收紧行高；此时使用
  `editor_table_fit_heights`，再检查表格下方元素是否需要调整。
- 结构写后重新读取表格网格；截图检查真实编辑容器，不把 `rendered=true` 当成布局稳定证明。

MCP-first 例程：

```text
editor_table_info({ tableId: "table-id" })
editor_table_set_cell({
  tableId: "table-id",
  row: 4,
  col: 4,
  content: "/ɡrəʊ ʌp/"
})
editor_table_info({ tableId: "table-id" })
```

字段名和操作值必须以当前工具 Schema 为准；若示例与 Schema 不一致，停止并采用 Schema。
