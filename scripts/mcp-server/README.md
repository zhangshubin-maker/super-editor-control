# super-editor-control MCP 服务端

零依赖 Node MCP 服务端（stdio）。通过 CDP 连接浏览器页面，把 `window.__superEditor` 桥接 API 包装成结构化工具。

## 运行要求

- Node.js >= 22（依赖全局 `WebSocket` / `fetch`）。
- 目标浏览器已启用 remote debugging：`chrome.exe --remote-debugging-port=9222`（Chrome 需先完全退出再以该参数启动）。

## 环境变量

| 变量 | 说明 |
|------|------|
| `SUPER_EDITOR_CDP_URL` | CDP HTTP 地址，默认 `http://127.0.0.1:9222` |
| `SUPER_EDITOR_MOCK` | `1` 时进入 mock 模式，不连接浏览器（用于测试 MCP 协议本身） |

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
| `editor_connect` | 连接已打开的页面（可按 URL 片段匹配） |
| `editor_open` | 新开标签页并连接 |
| `editor_get_state` / `editor_list_slides` / `editor_get_slide` / `editor_select_slide` | 课件与页面查询 |
| `editor_add_block` / `editor_update_block` / `editor_delete_block` | 区块增改删 |
| `editor_add_element` / `editor_update_element` / `editor_delete_element` / `editor_order_element` | 元素增改删与层级 |
| `editor_group_elements` / `editor_ungroup` | 打组/拆组 |
| `editor_undo` / `editor_redo` | 撤销/重做 |
| `editor_save` | 保存 |
| `editor_screenshot` | 画布截图（data URL） |
| `editor_eval` | 低层逃生通道（页面执行任意 JS） |

所有 `editor_*` 工具内部调用 `window.__superEditor`，桥接契约见 `../../assets/bridge-api-spec.md`；编辑器侧实现步骤见 `../../assets/editor-integration-guide.md`。

## 与浏览器技能的配合

- 若 Codex 会话中 MCP 工具不可用，可直接用 `browser:control-in-app-browser` / `chrome:control-chrome` 在页面里执行 JS 调用 `window.__superEditor.*`，效果等价。
- 推荐自动化浏览器与人工登录浏览器一致（共用登录态），避免额外登录流程。