# super-editor-control MCP 服务端

零依赖 Node MCP 服务端（stdio）。通过**同源 RPC 通道**（`/ai-control/rpc`）连接编辑器页面，把 `window.__superEditor` 桥接 API 包装成结构化工具。不依赖 CDP、不依赖浏览器调试端口。

## 运行要求

- Node.js >= 22（依赖全局 `fetch`）。
- 编辑器页面以 `ai_control=1` 打开，且 dev server / 后端已挂载 `/ai-control/rpc` 路由（协议见 `../../assets/production-integration-spec.md`）。
- 连接时只需课件 URL（`pageUrl`）或编辑器 origin（`httpUrl`），插件自动解析并探测端点。

## 环境变量

| 变量 | 说明 |
|------|------|
| `SUPER_EDITOR_MOCK` | `1` 时进入 mock 模式，不连接编辑器（用于测试 MCP 协议本身） |

## 启动

```bash
node index.js
```

或测试 MOCK 模式：

```bash
set SUPER_EDITOR_MOCK=1
node index.js
```

## 工具列表

| 工具 | 作用 |
|------|------|
| `editor_status` | 连接状态 / 桥接就绪检测 |
| `editor_connect` | 连接编辑器页面（同源 RPC）：`pageUrl` 课件完整 URL 或 `httpUrl` origin，二选一；返回固定路由的 `instanceId` |
| `editor_get_state` / `editor_list_slides` / `editor_get_slide` / `editor_select_slide` | 课件与页面查询 |
| `editor_add_block` / `editor_update_block` / `editor_delete_block` | 区块增改删 |
| `editor_add_element` / `editor_update_element` / `editor_delete_element` / `editor_order_element` | 元素增改删与层级 |
| `editor_group_elements` / `editor_ungroup` | 打组/拆组 |
| `editor_undo` / `editor_redo` | 撤销/重做（ai_control 已禁用，返回 disabled 提示） |
| `editor_checkpoint` / `editor_rollback` / `editor_list_checkpoints` / `editor_clear_checkpoints` | 整页快照：创建 / 回滚 / 列出 / 清理（ai_control 替代撤销重做） |
| `editor_save` | 保存 |
| `editor_table_info` / `editor_table_set_cell` / `editor_table_update` / `editor_table_structure` / `editor_table_fit_heights` | 表格：读取结构/网格、改单元格、整表更新、行列增删与合并拆分、行高自适应收紧 |
| `editor_mind_info` / `editor_mind_set_node` / `editor_mind_structure` / `editor_mind_update` | 思维导图：读节点树、改节点文本/样式、增删节点、整图替换与模板主题 |
| `editor_text_info` / `editor_text_set_content` / `editor_text_adaptive` / `editor_text_fit` | 文本：读结构/自适应模式、改内容并触发宽高自适应、切 extendType、强制重测（含组内联动位移返回） |
| `editor_outline_info` / `editor_outline_refresh` / `editor_outline_add` / `editor_outline_rename` / `editor_outline_delete` / `editor_outline_move` / `editor_outline_link_blocks` / `editor_outline_select` | 大纲：读当前/任意目录大纲树、刷新、增删改查、移动排序、关联区块、选中节点（v0.8） |
| `editor_outline_anchor_list` / `editor_outline_anchor_add` / `editor_outline_anchor_update` / `editor_outline_anchor_delete` | 大纲锚点：查询 / 新增 / 修改 / 删除（type 1=位置锚点，2=检索锚点） |
| `editor_batch` | 批量执行多步骤（一次往返串行执行 `steps: [{ method, args }]`，一次返回全部结果；`stopOnError` 默认遇错即停） |
| `editor_screenshot` | 画布截图（走桥接 `screenshot()`，data URL） |

所有 `editor_*` 工具内部调用 `window.__superEditor`，桥接契约见 `../../assets/bridge-api-spec.md`；编辑器侧实现步骤见 `../../assets/editor-integration-guide.md`。

## 与浏览器技能的配合

- 数据读写一律走 MCP（RPC 通道）；浏览器技能只用于**打开页面、只读探测与截图**（其 evaluate 是只读沙箱，看不到 `window.__superEditor`）。
- 打开新页面标签用浏览器技能（RPC 模式无法开新标签），页面打开后再 `editor_connect`。
- 截图注意：无 CDP 整页截图，`editor_screenshot` 依赖桥接 `screenshot()`（html2canvas，只含已渲染区块）；需要整页效果时先滚动分段截图或用浏览器技能截取页面视口。
