# Super Editor Control

让 Codex 在普通 Chrome / Edge 浏览器中控制超媒编辑器（`super-editor`）的 Codex 插件。插件同时承担：

- stdio MCP 适配器：向 Codex 提供结构化 `editor_*` 工具。
- 本机浏览器 RPC 中继：在 `127.0.0.1:8765` 维护页面实例、命令队列和结果回传。
- 编辑工作流技能：覆盖书本、模板、素材、页面、区块、元素、大纲、保存和回滚。

整个正式链路不依赖 Electron、CDP、浏览器调试端口或正式环境后端 RPC 路由。

## 工作方式

```text
Codex ──stdio──> 插件 MCP 进程 ──本机 RPC──> 普通浏览器页面
                                      <── 页面长轮询并调用 window.__superEditor
```

1. Codex 新任务加载插件时自动启动 MCP 进程。
2. 首个 MCP 进程监听 `127.0.0.1:8765`；其他任务复用它，并在 owner 退出后自动接管。
3. 用户在浏览器中打开课件并点击顶部“AI 控制”。页面随即轮询本机中继并注册。
4. 任意 `editor_*` 工具首次调用时自动租用一个可用页面；不需要传 URL，也不需要先调用
   `editor_connect`。
5. 多个 Codex 任务同时运行时会租用不同页面，避免串台；空闲租约会自动过期。

## 前置条件

- 安装 Codex 桌面端和本插件。
- 正式网页包含 `src/modules/contentEditor/aiControl/` 的浏览器 RPC 客户端，并通过 HTTPS 发布。
- 使用支持本地网络访问授权的新版 Chrome / Edge。首次开启时若浏览器询问本地网络权限，选择“允许”。

Windows 用户不需要安装 Electron，也不需要另装 Node.js。插件启动器优先使用 Codex 自带的
Node 运行时，仅在找不到时才回退到系统 Node.js 20+。macOS 用户见下方“安装”章节：由于
Codex 的插件 MCP 配置目前不支持按操作系统选择命令，需要从本仓库克隆安装并先运行一次
`scripts/setup-mcp.sh`。

若正式站点设置 CSP，`connect-src` 必须包含 `http://127.0.0.1:8765`。页面位于跨域 iframe 时，
宿主页还需要向该 iframe 委派 `loopback-network` 权限。

## 使用

1. 安装或更新插件后新开一个 Codex 任务。
2. 在普通浏览器中登录并打开目标课件。
3. 点击顶部“AI 控制”；提示本地网络权限时允许。
4. 直接让 Codex 制作或修改课件。页面按钮提示“AI 控制已连接”后即可执行。

`editor_status` 是只读检查，不会长期占用页面。`editor_connect` 仅用于主动重新选择页面。

## 安装

### Windows：Git Marketplace（推荐）

```powershell
codex plugin marketplace add zhangshubin-maker/super-editor-control
codex plugin add super-editor-control@super-editor-control
```

安装完成后重启 Codex，并新建任务使用插件。

### macOS：本地 Marketplace

插件的 MCP/RPC 主体是纯 Node.js，可在 macOS 运行；但仓库默认 `.mcp.json` 使用 Windows
启动器。Mac 用户需要克隆仓库，让安装脚本探测 Codex 自带或系统 Node.js 20+，并生成本机
绝对路径配置：

```bash
git clone https://github.com/zhangshubin-maker/super-editor-control.git
cd super-editor-control
bash scripts/setup-mcp.sh
codex plugin marketplace add .
codex plugin add super-editor-control@super-editor-control
```

完成后重启 Codex，并新建任务。若脚本找不到 Codex 自带运行时，请安装 Node.js 20+，或通过
`SUPER_EDITOR_NODE=/absolute/path/to/node bash scripts/setup-mcp.sh` 指定 Node 路径。

### 本机开发安装

开发机已配置 personal marketplace 时：

```powershell
codex plugin add super-editor-control@personal
```

### 更新

Windows Git Marketplace 安装：

```powershell
codex plugin marketplace upgrade super-editor-control
codex plugin add super-editor-control@super-editor-control
```

macOS 本地 Marketplace 安装：

```bash
git pull
bash scripts/setup-mcp.sh
codex plugin add super-editor-control@super-editor-control
```

更新后都需要重启 Codex 并新建任务，才能加载新的技能和 MCP 工具。

## 组成

- `.mcp.json`：启动插件自带的 stdio MCP。
- `scripts/mcp-server/start.ps1`：Windows 自动定位 Codex 捆绑或系统 Node 运行时。
- `scripts/setup-mcp.sh`：macOS/Linux 探测 Node 并生成本机 MCP 配置。
- `scripts/mcp-server/index.js`：MCP 工具适配器。
- `scripts/mcp-server/rpc-broker.js`：本机 RPC 中继、选主接管、页面租约和故障语义。
- `skills/`：总控及书本、素材、状态、区块、元素、画布、大纲子技能。
- `assets/bridge-api-spec.md`：`window.__superEditor` 桥接契约。
- `assets/production-integration-spec.md`：浏览器与插件本地 RPC 协议及部署要求。

## 开发与验证

```powershell
cd scripts/mcp-server
npm test
```

测试覆盖 CORS/LNA 响应头、长轮询、结果幂等、页面租约、客户端中断与 MCP 取消、
queued/in-flight 故障语义、串行工具、两个 MCP 进程选主、owner 强制退出后的接管、
截断响应和有界关闭。

直接调试可运行 `node scripts/mcp-server/index.js`；需要 mock 时设置
`SUPER_EDITOR_MOCK=1`。默认端口可用 `SUPER_EDITOR_RPC_PORT` 覆盖，但网页端必须通过
`window.__SUPER_EDITOR_RPC_URL` 指向同一端口。

修改插件后按开发流程更新 cachebuster、校验并重新安装。`scripts/setup-mcp.ps1` 仅作为
Windows 旧版手动配置/诊断兜底；`scripts/setup-mcp.sh` 是 macOS 当前的安装步骤。
