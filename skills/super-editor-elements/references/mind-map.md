# 思维导图结构操作

思维导图元素的内容是 kityminder JSON。节点 id 必须来自实际树，不能按文本或路径猜测。

## 工具

| 意图 | MCP 工具 |
|---|---|
| 读取规范树或原始数据 | `editor_mind_info` |
| 改节点整体文本/属性 | `editor_mind_set_node` |
| 新增或删除节点 | `editor_mind_structure` |
| 整图、模板或主题更新 | `editor_mind_update` |

以实时 MCP Schema 为准选择操作枚举。

## 规则

- 先读取树，使用返回的 `mindId/nodeId/path`；节点 id 不唯一或不存在时停止。
- 节点增删、整图替换属于结构性写入，按公共策略建立当前页 checkpoint。
- 节点局部替换、字符/段落格式、链接或 embed 使用统一富文本 target：

```text
editor_text_document({
  target: { kind: "mindNode", mindId: "mind-id", nodeId: "node-id" }
})
```

- `editor_mind_set_node` 只用于整个节点文本或节点级属性，不替代细粒度富文本工具。
- 结构写后重新读取树并截图外层思维导图。节点变化可能触发整图重新排版；仅有数据回读成功不足以证明
  无遮挡或尺寸稳定。

MCP-first 例程：

```text
editor_mind_info({ mindId: "mind-id" })
editor_mind_set_node({
  mindId: "mind-id",
  nodeId: "从 tree 返回取得",
  patch: { bold: true, color: "#D14424" }
})
editor_mind_info({ mindId: "mind-id" })
```

字段名和操作值必须以当前工具 Schema 为准；若示例与 Schema 不一致，停止并采用 Schema。
