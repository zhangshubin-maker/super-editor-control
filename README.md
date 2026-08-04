# Super Editor Control

让 Codex 像控制 Figma 一样控制超媒编辑器（`super-editor`）的 Codex 插件：skill + MCP + 浏览器画布控制。

## 组成

- `skills/super-editor-control/SKILL.md` — 核心技能：连接编辑器、调用桥接 API 的工作流与规则。
- `skills/super-editor-outline/SKILL.md` — 大纲（图层面板左侧「大纲」树）技能：增删改查、移动排序、关联区块、锚点操控（v0.8）。
- `skills/super-editor-assets/SKILL.md` — 用户与设计素材技能：搜索并应用本书样章/区块模板、系统/个人组件和本书/总图片素材库（v1.0）。
- `skills/super-editor-books/SKILL.md` — 书本管理技能：搜索、读取源书、克隆创建新书和编辑器跳转（v1.1）。
- 图片上传与使用（v0.9）：`editor_upload_image` / `editor_add_image_element` / `editor_set_image_src`，把本地生成图片上传到课件媒体库并放入画布（配合模型生图能力）。
- 模板与素材复用（v1.0）：获取用户信息，搜索并应用样章模板、区块模板、组件库与图片素材，让 AI 先盘点本书资源再自主设计新目录。
- 书本管理（v1.2）：搜索当前用户可访问书本；默认轻量继承源书外部属性创建空内容新书，明确需要时才完整复制目录和内容；支持覆盖名称、教辅类型、封面及编辑器跳转。
- `.mcp.json` — 直接连接 Electron 内置的 `http://127.0.0.1:8765/mcp`，无需插件自行启动 Node 进程。
- Electron MCP 适配层 — 自动发现 Electron 中已开启“AI 控制”的编辑器页面，并把 `window.__superEditor` 包装成结构化工具（`editor_*`）。
- `assets/bridge-api-spec.md` — `window.__superEditor` 桥接 API 契约（编辑器侧需要实现的接口）。
- `assets/editor-integration-guide.md` — 在 super-editor 仓库内实现桥接层的逐步指南。

## 前置条件

- 已安装并运行包含 AI Control MCP 的善版优荣 Electron 桌面端。
- Electron 中已打开 super-editor 课件页面，并点击编辑器顶部“AI 控制”开关。
- 已安装 Codex 桌面端和本插件；插件本身不再要求用户安装 Node.js。


## 自动连接

插件固定连接 Electron 本机 MCP 地址 `http://127.0.0.1:8765/mcp`。用户只需先启动 Electron、打开课件并开启顶部“AI 控制”；Codex 调用任意 `editor_*` 工具时会自动选择最近活跃的页面。`editor_connect` 仅用于主动检查/重新选择，不再接收 `pageUrl` 或 `httpUrl`。

开发环境也兼容：只要开发页面在 Electron 内打开，preload 会将页面 RPC 指向 Electron；`vue.config.js` 的 dev RPC 可以继续作为普通浏览器开发的兜底。
## 安装

**本机个人使用**（personal marketplace 已生成）：

1. `codex plugin add super-editor-control@personal`
2. 启动善版优荣 Electron，再新开一个 Codex 会话（技能与 MCP 工具在新会话中生效）。
3. 在 Electron 中打开课件并点击顶部“AI 控制”。
4. 直接让 Codex 制作或修改课件；工具会自动连接，无需提供课件 URL。

若 Codex 会话打开时 Electron 尚未运行，该会话可能没有加载 MCP 工具；启动 Electron 后新开一个 Codex 会话即可。

**Git 市场发布版**（本仓库即插件市场，`.agents/plugins/marketplace.json`）：

1. 注册市场：`codex plugin marketplace add <owner>/super-editor-control`（私有仓库填 Git URL 也可）
2. 安装插件：`codex plugin add super-editor-control@super-editor-control`
3. 桌面 App 用户：打开「插件目录」→ 选择对应 marketplace → 安装。
4. 新开会话后即可使用，用法同上。

更新插件：推送新版本到仓库后，使用者执行 `codex plugin update`（或重新安装）。

## 开发

- 修改插件配置或技能后重装插件：
  `python C:/Users/shubin/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py C:/Users/shubin/plugins/super-editor-control`
  然后 `codex plugin add super-editor-control@personal`。
- `scripts/mcp-server/` 保留为旧版独立 stdio 调试实现，正式插件不再引用；正式链路在 Electron 项目中测试。
