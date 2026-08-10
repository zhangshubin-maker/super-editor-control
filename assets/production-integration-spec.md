# Super Editor 浏览器本地 RPC 集成规范

## 1. 正式架构

```text
Codex
  │ stdio MCP
  ▼
super-editor-control 插件进程
  ├─ MCP 工具适配器
  └─ http://127.0.0.1:8765/ai-control/rpc
                         ▲
                         │ CORS + Local Network Access
                         │ 长轮询 poll / result
                         ▼
HTTPS 正式网页中的 window.__superEditor
```

- 插件同时承担 MCP 适配器和浏览器 RPC broker。
- 正式环境后端、网关和 Electron 都不需要实现 RPC 路由。
- 页面只在用户点击顶部“AI 控制”后连接本机 broker；关闭按钮或离开页面时注销。
- 不使用 CDP、远程调试端口或鼠标键盘模拟。

## 2. 网页端要求

页面默认基地址：

```js
window.__SUPER_EDITOR_RPC_URL || 'http://127.0.0.1:8765/ai-control'
```

生产部署必须满足：

1. 页面本身使用 HTTPS。
2. 若设置 CSP，`connect-src` 包含 `http://127.0.0.1:8765`。
3. Chrome / Edge 首次询问本地网络访问权限时，用户选择允许。
4. 页面位于跨域 iframe 时，宿主页向 iframe 委派 `loopback-network` 权限。
5. 用户首次开启 AI 控制仍以顶部按钮为准；已开启 AI 控制后的书本跳转可以继承 `ai_control=1`，但该参数必须放在 `#/content-editor` 后的路由查询串中，禁止拼在 hash 前的外层查询串。

`window.__SUPER_EDITOR_RPC_URL` 只用于开发或改变 broker 端口。正式默认无需注入。

## 3. 传输协议

固定前缀：`/ai-control/rpc`。

### 3.1 页面长轮询

`GET /poll?instance=<页面实例ID>`

- 首次 poll 即注册页面实例。
- 有命令时返回 `200`：

  ```json
  { "id": "req-uuid", "method": "getSlide", "args": [3562] }
  ```

- 暂无命令时请求最多挂起 20 秒，然后返回 `204`；页面收到后立即发起下一次 poll。
- 同一页面一次只执行一个命令。

每次开启按钮必须生成新的 instance ID，并同时写入：

- `window.__superEditorRpcInstance`
- `<html data-se-rpc-instance="...">`

这样旧会话的延迟注销不会删除新会话。

### 3.2 页面回传结果

`POST /result`

```json
{
  "id": "req-uuid",
  "instance": "inst-xxx",
  "ok": true,
  "value": {},
  "error": "",
  "errorCode": ""
}
```

- 页面方法只执行一次；网络失败时只重发同一个结果，不重新执行方法。
- broker 只接受已经派发且 instance 匹配的 ID。
- 重复或迟到结果返回 `200 {"ok":true,"accepted":false}`，不会影响后续命令。

### 3.3 MCP 下发命令

`POST /request`

```json
{
  "method": "addSlide",
  "args": [{ "name": "Module 1 Unit 2 预习" }],
  "timeoutMs": 90000,
  "targetInstance": "inst-xxx",
  "clientId": "mcp-uuid"
}
```

响应：

```json
{
  "ok": true,
  "value": { "slideId": 36526 },
  "error": "",
  "errorCode": "",
  "instance": "inst-xxx"
}
```

`clientId` 和页面租约由插件驱动层维护，网页业务代码不需要处理。

### 3.4 页面发现与租约

- `GET /instances`：返回仍在心跳的页面 ID。
- `POST /claim`：MCP 进程用 `clientId` 租用页面。
- `POST /release`：取消当前客户端尚未派发的命令并释放租约；若存在已派发命令，租约延迟到结果返回后释放。
- 页面心跳 TTL 为 120 秒；客户端租约空闲 TTL 为 30 秒。已派发命令在途时不会被空闲 TTL 抢占。
- 多个 Codex 任务优先获得不同页面；全部页面占用时返回 `INSTANCE_BUSY`。

### 3.5 注销与健康检查

- `POST /unregister`：`{ "instance": "inst-xxx" }`，用于按钮关闭或页面销毁。
- `GET /health`：返回严格身份：

  ```json
  {
    "ok": true,
    "service": "super-editor-control-rpc",
    "protocolVersion": 1,
    "ownerPid": 1234,
    "instances": 1,
    "leases": 0
  }
  ```

插件只复用身份与协议版本完全匹配的服务。若 8765 被其他程序占用，会在 MCP 启动超时前明确失败。

## 4. CORS 与 Local Network Access

broker 对正常、错误、204 和 OPTIONS 响应统一返回：

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Private-Network: true
Cross-Origin-Resource-Policy: cross-origin
Cache-Control: no-store
```

页面 fetch 使用 `mode: 'cors'` 和 `targetAddressSpace: 'loopback'`。轮询超时为 45 秒，以给首次权限
提示留出时间；失败后指数退避，最大约 5 秒。结果 POST 每次有独立超时并使用相同 ID 重试。

## 5. 多 MCP 进程和故障接管

- 首个插件 MCP 进程绑定 8765，角色为 owner。
- 后续进程通过严格 `/health` 探测加入，角色为 follower。
- follower 每 1.5 秒检查 owner；owner 退出后多个 follower 竞争端口，仅一个成为新 owner。
- 浏览器长轮询断开后自动退避重连，无需刷新页面或重新点按钮。

故障时必须区分：

| 状态 | 错误码 | 是否可直接重试 |
|------|--------|----------------|
| 命令仍在 broker 队列 | `RPC_TIMEOUT_NOT_DISPATCHED` / `BROKER_SHUTDOWN_NOT_DISPATCHED` | 可以 |
| 客户端释放且命令未派发 | `CLIENT_RELEASED_NOT_DISPATCHED` | 可以 |
| 空闲租约过期且命令未派发 | `CLIENT_LEASE_EXPIRED_NOT_DISPATCHED` | 可以 |
| 命令已经发往页面 | `OUTCOME_UNKNOWN` | 不可以；先读状态 |
| 页面已失活且命令未派发 | `INSTANCE_STALE` / `INSTANCE_UNREGISTERED` | 重新连接后可以 |
| 页面被另一任务租用 | `INSTANCE_BUSY` | 等待、切换页面或显式重连 |

请求 HTTP 连接在命令未派发时断开，broker 会立即从队列移除命令；如已派发则不强行
中断页面执行。MCP `notifications/cancelled` 只取消尚未开始的工具调用（返回
JSON-RPC `-32800`）；已开始的写工具必须完成原有结果边界，避免误报“未执行”导致重复写入。

驱动层只会自动重试明确未派发的连接选择，不会自动重放结果未知的写操作。同一 MCP
进程中的工具调用串行执行，`editor_connect` / `editor_status` 不会与写命令交错释放租约。

## 6. 开发模式兼容

开发时推荐仍使用插件本机 broker，和正式环境保持同一路径。

仓库 `vue.config.js` 中的同源 dev RPC 可继续作为单独调试兜底；若要使用它，需在应用加载前设置：

```js
window.__SUPER_EDITOR_RPC_URL = window.location.origin + '/ai-control'
```

同源 dev broker 不参与插件 owner/follower、页面租约和故障接管验证，不能代表正式链路。

## 7. 当前边界

本规范优先保证连接稳定性、请求幂等语义和多任务隔离。鉴权、Origin 白名单、端口令牌等安全收口
暂未纳入本轮实现，发布到不受控环境前应另行设计。
