# Super Editor Control

让 Codex 像控制 Figma 一样控制超媒编辑器（`super-editor`）的 Codex 插件：skill + MCP + 浏览器画布控制。

## 组成

- `skills/super-editor-control/SKILL.md` — 核心技能：连接编辑器、调用桥接 API 的工作流与规则。
- `.mcp.json` + `scripts/mcp-server/` — 零依赖 Node MCP 服务端，通过 CDP 连接浏览器页面，把 `window.__superEditor` 包装成结构化工具（`editor_*`）。
- `assets/bridge-api-spec.md` — `window.__superEditor` 桥接 API 契约（编辑器侧需要实现的接口）。
- `assets/editor-integration-guide.md` — 在 super-editor 仓库内实现桥接层的逐步指南。

## 前置条件

- Node.js >= 22（MCP 服务端依赖原生 WebSocket）。
- super-editor 已在本机运行，且已按 `assets/editor-integration-guide.md` 实现桥接层（`ai_control=1` 时挂载 `window.__superEditor`）。
- 一个已登录的浏览器（推荐带调试端口启动的 Chrome）：`chrome.exe --remote-debugging-port=9222`。

## 使用

1. 安装插件（personal marketplace 已生成）：`codex plugin add super-editor-control@personal`
2. 新开一个 Codex 会话（技能与 MCP 工具在新会话中生效）。
3. 让 Codex 打开课件链接（带 `ai_control=1`），或直接让它使用 `editor_connect` / `editor_open`。
4. 用自然语言下达任务，例如“把这页的标题改成蓝色并居中”。

## 开发

- 修改 MCP 服务端后重装插件：
  `python C:/Users/17909/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py C:/Users/17909/plugins/super-editor-control`
  然后 `codex plugin add super-editor-control@personal`。
- 无浏览器时可用 MOCK 模式测试 MCP 服务端：`SUPER_EDITOR_MOCK=1 node scripts/mcp-server/index.js`。