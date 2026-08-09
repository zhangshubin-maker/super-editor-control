---
name: super-editor-state
description: 超媒编辑器状态读取技能。在需要确认当前书本与目录、读取页面/区块/元素树、定位目标元素、检查脏状态、理解元素层级或查找疑似重复内容时使用。按 micro/current/book 只读取解决任务所需的最小范围，不承担写入、保存或默认整页备份。
---

# Super Editor State

先读后改不等于先读整页。根据公共
[任务策略](../super-editor-control/references/task-policy.md)选择最小读取范围：目标明确的 micro 直接读目标；
只有当前页结构任务才读区块清单或画布树；整书任务由 `super-editor-book-authoring` 分页读取 manifest。

## MCP 工具

| 需要 | MCP 工具 | 使用范围 |
|---|---|---|
| 连接、书本、当前页、dirty | `editor_status` / `editor_get_state` | 目标上下文不确定或准备切页时 |
| 页面清单 | `editor_list_slides` | 需要定位目录时 |
| 当前/指定页完整结构 | `editor_get_slide` | current 结构任务；传 MCP 对象 `{ slideId }` |
| 当前页区块清单 | `editor_list_blocks` | 只需顺序、名称、尺寸、元素数时优先 |
| 当前页画布树 | `editor_get_canvas_tree` | 需要区块与嵌套元素层级、几何和统计时 |
| 单元素 | `editor_get_element` | micro 首选 |
| 搜索元素 | `editor_search_elements` | 目标 id 不明确时在当前页缩小候选 |
| 其他只读 Bridge 方法 | `editor_rpc_call` | 只有没有专用 MCP 工具时使用 |

浏览器 evaluate 看不到 `window.__superEditor`；不要尝试直接执行 Bridge。Bridge 方法的标量参数与
MCP 工具的对象参数不是一回事，例如工具调用是：

```text
editor_get_slide({ slideId: "3562" })
editor_get_element({ elementId: "element-id" })
editor_search_elements({ keyword: "学习目标", type: "text" })
```

## 画布层级

```text
目录/页面 slide
└─ 区块 block（uuid/blockId）
   └─ 元素 element
      └─ 组内 child_list（坐标相对组）
```

- 区块使用 uuid 作为画布 blockId；数字模块所需 `hypermedia_content_id` 是区块数据库 id，二者不能混用。
- 运行时模板数据以 `template_data_content` 为准；服务端存档字段可能保留旧结构。
- 元素常用字段为 `id/type/templateId/groupId/left/top/width/height/rotate/child_list`。
- 文本元素、表格单元格和思维导图节点的富文本内容统一由 `super-editor-text` 读取。
- Tab 只保留为兼容元素类型，普通课件任务不主动分析或创建。

## 最小读取 recipe

- 已知文本 target：直接 `editor_text_document`，不先调用 `editor_get_state` 或 `editor_get_slide`。
- 已知元素 id：`editor_get_element`；只有布局受兄弟元素影响时再读所属区块/画布树。
- 调整一个区块：`editor_list_blocks` → 目标相关元素；需要嵌套关系才读 `editor_get_canvas_tree`。
- 制作当前页：加载 `super-editor-page-authoring`，按其 recipe 读取当前页。
- 多目录：加载 `super-editor-book-authoring`，不要循环 `editor_get_slide` 穷举。

查重时同名不等于重复。比较 id、文本、图片 URL、元素集合和几何后再把候选交给写入技能。
磁盘备份不是本技能默认动作；高风险跨会话恢复需求按公共策略选择 `exportSlide` 或宿主文件能力。
