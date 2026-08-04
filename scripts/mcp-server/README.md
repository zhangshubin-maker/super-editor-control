# super-editor-control MCP 服务端

零 npm 依赖的 stdio MCP + 本机浏览器 RPC 中继。它把普通浏览器页面中的
`window.__superEditor` 包装为结构化 `editor_*` 工具，不依赖 Electron、CDP、浏览器调试端口或
正式环境后端 RPC。

## 运行要求

- 直接开发运行需要 Node.js 20+。
- Windows Marketplace 安装通过 `start.ps1` 优先使用 Codex 自带 Node，用户无需单独安装。
- macOS 先在仓库根目录运行 `bash scripts/setup-mcp.sh`，生成指向 Codex 自带或系统 Node 20+
  的本机 `.mcp.json`，再从该本地仓库安装 Marketplace。
- 浏览器打开课件后，由用户点击顶部“AI 控制”按钮注册页面。

## 自动连接

- MCP 进程启动时争用 `127.0.0.1:8765`。首个进程成为 broker owner，其他进程作为 follower
  复用；owner 退出后 follower 通常在约 2 秒内自动接管。
- `editor_*` 工具第一次调用时自动选择并租用可用页面，无需 `pageUrl` / `httpUrl`。
- `editor_status` 只报告可用页面；没有活动连接时不会占用租约。
- 多任务会租用不同页面；工具执行期间续租，空闲 30 秒后可被其他任务使用。
- 同一 MCP 进程的工具串行执行；已取消且尚未开始的工具不会再发往浏览器。

## 环境变量

| 变量 | 说明 |
|------|------|
| `SUPER_EDITOR_MOCK` | `1` 时进入 mock 模式，不连接编辑器 |
| `SUPER_EDITOR_RPC_PORT` | 本机 broker 端口，默认 `8765` |
| `SUPER_EDITOR_NODE` | Windows/macOS 安装脚本优先使用的 Node 可执行文件 |

## 启动与测试

```powershell
node index.js
npm test
```

Mock：

```powershell
$env:SUPER_EDITOR_MOCK = '1'
node index.js
```

## 主要工具

| 工具 | 作用 |
|------|------|
| `editor_status` / `editor_connect` | 查看可用页面 / 主动重新选择页面 |
| `editor_get_state` / `editor_get_slide` | 读取课件与页面 |
| `editor_search_books` / `editor_get_book` / `editor_create_book` | 搜索、核对并创建书本 |
| `editor_search_templates` / `editor_apply_template` | 搜索并应用模板 |
| `editor_search_components` / `editor_apply_component` | 搜索并应用组件 |
| `editor_search_images` / `editor_apply_image` | 搜索并应用图片素材 |
| `editor_add_block` / `editor_update_block` / `editor_delete_block` | 区块编辑 |
| `editor_add_element` / `editor_update_element` / `editor_delete_element` | 元素编辑 |
| `editor_checkpoint` / `editor_rollback` | 整页快照与回滚 |
| `editor_save` / `editor_screenshot` | 保存与渲染核对 |
| `editor_batch` | 一次往返串行执行多个桥接步骤 |

完整工具以 `tools/list` 为准，桥接契约见 `../../assets/bridge-api-spec.md`。

## 故障语义

- 命令仍在队列时超时或 broker 关闭：明确返回未派发，可安全重试。
- MCP 取消通知只跳过尚未开始的工具；请求连接中断或客户端释放时，broker 会移除尚未派发的命令。
- 命令已发送到页面后连接中断、超时或 owner 退出：返回 `OUTCOME_UNKNOWN`，不得自动重放写操作；
  应先读取页面状态再决定是否重试。
- 页面关闭/关闭 AI 控制时，队列命令失败；在途命令同样按结果未知处理。
- stdout 只输出 MCP JSON；运行日志和启动错误只能写 stderr。
