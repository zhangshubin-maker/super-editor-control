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
- `.mcp.json` + `scripts/mcp-server/` — 零依赖 Node MCP 服务端，通过同源 RPC 通道连接编辑器页面，把 `window.__superEditor` 包装成结构化工具（`editor_*`）。
- `assets/bridge-api-spec.md` — `window.__superEditor` 桥接 API 契约（编辑器侧需要实现的接口）。
- `assets/editor-integration-guide.md` — 在 super-editor 仓库内实现桥接层的逐步指南。

## 前置条件

- Node.js >= 22（MCP 服务端依赖原生 WebSocket）。
- super-editor 已在本机运行，且已按 `assets/editor-integration-guide.md` 实现桥接层（`ai_control=1` 时挂载 `window.__superEditor`）。
- 编辑器页面已带 `ai_control=1` 打开（dev server 内置同源 RPC 路由；生产按 `assets/production-integration-spec.md` 提供）。


## Node 运行时（免安装）

MCP 服务端需要 Node >= 22。Codex 桌面应用自带 Node 运行时，`.mcp.json` 默认使用官方写法（`command: "node"` + `cwd: "."`），由 Codex 用捆绑运行时解析，使用者无需单独安装 Node。

若目标环境无法解析 `node`（未使用捆绑运行时），运行兜底脚本生成带绝对路径的配置：

- Windows：`powershell -ExecutionPolicy Bypass -File scripts/setup-mcp.ps1`
- macOS / Linux：`bash scripts/setup-mcp.sh`

脚本会按顺序探测：环境变量 `SUPER_EDITOR_NODE` > Codex 捆绑的 Node > 系统 PATH 中的 Node，校验主版本 >= 22 后生成 `.mcp.json`（原文件自动备份为 `.mcp.json.bak`）。生成后需重启 Codex 生效。
## 安装

**本机个人使用**（personal marketplace 已生成）：

1. `codex plugin add super-editor-control@personal`
2. 新开一个 Codex 会话（技能与 MCP 工具在新会话中生效）。
3. 让 Codex 打开课件链接（带 `ai_control=1`），或直接让它使用 `editor_connect({ pageUrl })`。

**Git 市场发布版**（本仓库即插件市场，`.agents/plugins/marketplace.json`）：

1. 注册市场：`codex plugin marketplace add <owner>/super-editor-control`（私有仓库填 Git URL 也可）
2. 安装插件：`codex plugin add super-editor-control@super-editor-control`
3. 桌面 App 用户：打开「插件目录」→ 选择对应 marketplace → 安装。
4. 新开会话后即可使用，用法同上。

更新插件：推送新版本到仓库后，使用者执行 `codex plugin update`（或重新安装）。

## 开发

- 修改 MCP 服务端后重装插件：
  `python C:/Users/shubin/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py C:/Users/shubin/plugins/super-editor-control`
  然后 `codex plugin add super-editor-control@personal`。
- 无浏览器时可用 MOCK 模式测试 MCP 服务端：`SUPER_EDITOR_MOCK=1 node scripts/mcp-server/index.js`。
