# Super Editor AI 控制通道：同源 RPC 集成规范（后端 / 网关）

> 本文档定义「Codex 插件 ↔ 编辑器页面」的生产级控制通道协议，供后端/网关团队在正式环境按此实现。
> 目标：用户把课件链接交给 Codex 后，插件无需 CDP、无需本地服务、无需控制浏览器，直接通过本通道读写画布。

## 1. 总体架构

```
Codex 插件 MCP（node 进程）                    编辑器页面（浏览器，ai_control=1）
        │  POST /ai-control/rpc/request              │  GET /ai-control/rpc/poll?instance=xxx（每 400ms）
        │  （长轮询，最多 90s 等结果）                 │  （队列有命令 → 执行 window.__superEditor 方法）
        ▼                                            ▼
  ┌───────────────────────┐                  ┌───────────────────────┐
  │  后端 / 网关（服务端）  │◄────────────────►│  页面桥接（页面进程内） │
  │  命令队列 + 结果暂存    │   POST /result    │  window.__superEditor │
  └───────────────────────┘                  └───────────────────────┘
```

- 服务端只需维护：`按 instance 的命令队列` + `按 requestId 的结果暂存`，无状态、可水平扩展。
- 页面只轮询自己的同源地址，无跨域、无额外端口、无独立服务进程。
- 插件通过页面 URL 自动解析 `origin`，因此插件侧输入只有一个参数：**课件链接**。

## 2. 路由规范

挂载前缀：`/ai-control/rpc`（与页面 `window.__superEditor` 轮询代码中的 `RPC_POLL_URL` 一致；页面默认 `window.location.origin + '/ai-control'`，再拼 `/rpc/*`）。

### 2.1 GET `/ai-control/rpc/poll?instance=<页面实例ID>`

- 页面每 400ms 调用一次；`instance` 是页面实例 ID（见 §3），首次出现即视为注册。
- 有该实例的待执行命令：返回 `200`，body 为命令：
  ```json
  { "id": "req-xxx", "method": "getSlide", "args": [3562] }
  ```
- 无命令：返回 `204 No Content`。
- 页面取到命令后执行 `window.__superEditor[method](...args)`，随后 POST 结果（见 2.2）。
- 建议超时：命令执行完成前页面不并发拉取下一条（单飞），因此同一实例同时最多 1 条在途命令。

### 2.2 POST `/ai-control/rpc/result`

- 页面回传执行结果：
  ```json
  { "id": "req-xxx", "ok": true, "value": { ... }, "error": "" }
  ```
  失败时：`{ "id": "req-xxx", "ok": false, "value": null, "error": "可读错误文本" }`
- 服务端收到后，把结果交给等待该 `id` 的调用方（2.3 的长轮询请求），并返回 `200 {"ok":true}`。
- 结果可暂存 30s（防止调用方连接中断后取不到），超出丢弃。

### 2.3 POST `/ai-control/rpc/request`（响应含 `instance` 字段）

插件/外部调用方下发命令并**等待结果**（服务端长轮询，最长 90s）：

```json
{
  "method": "addSlide",
  "args": [{ "name": "Module 1 Unit 2 预习" }],
  "timeoutMs": 60000,
  "targetInstance": "inst-xxx"   // 可选：多标签页时精确路由；省略时用最近注册的实例
}
```

响应：

```json
{ "ok": true, "value": { "slideId": 36526 }, "error": "", "instance": "inst-xxx" }
```
```json
{ "ok": false, "value": null, "error": "template_id 最小不能小于1;", "instance": "inst-xxx" }
```

- `instance` 字段：服务端实际路由到的页面实例 ID；调用方可先发一次不带 `targetInstance` 的 `ping()` 获取，之后固定携带 `targetInstance` 避免多标签页串台。
- 实例生命周期：以 poll 心跳为准，建议服务端清理 30s 以上无 poll 的实例；`targetInstance` 指定的实例已失活时应立即返回错误（不要挂起等超时）。

- `timeoutMs` 缺省 60000，上限 120000；超时返回 `{"ok":false,"error":"RPC 超时（...ms）：<method>"}`。
- 无注册实例时立即返回 `{"ok":false,"error":"暂无已注册的编辑器页面，请先打开带 ai_control=1 的课件页"}`。
- `id` 可选，缺省服务端生成；结果以该 id 关联。

### 2.4 GET `/ai-control/rpc/instances`

- 返回当前注册的实例 ID 列表（调试/多开排查用）：`["inst-xxx", "inst-yyy"]`，最近注册的在前。

### 2.5 OPTIONS / CORS

- 同源调用无需 CORS；若网关配置了跨域（如插件从其他域名调试），需允许：
  `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Methods: GET, POST, OPTIONS`、`Access-Control-Allow-Headers: Content-Type`，并应答 OPTIONS 预检 204。

## 3. 页面实例 ID

- 页面模块加载时生成：`inst-<时间戳36进制>-<随机6位>`，并写入：
  - `window.__superEditorRpcInstance`
  - `<html data-se-rpc-instance="...">`（DOM 标记，隔离世界也可读）
- URL 参数 `__SUPER_EDITOR_RPC_URL`（页面全局变量）可覆盖轮询基地址；生产不建议开放。

## 4. 后端实现要点（参考）

- 数据结构（单机内存版即可，多实例可用 Redis）：
  ```
  queues: Map<instance, Array<{id, method, args}>>
  results: Map<requestId, {ok, value, error, expireAt}>
  waiters: Map<requestId, Response>   // 长轮询挂起的调用方
  instances: Array<string>            // 最近注册在前
  ```
- 请求体解析：不依赖框架 bodyParser 也可，手读流后 `JSON.parse`。
- 命令入队即开始计时，页面 400ms 轮询周期内取走；`/request` 的响应由 `/result` 或超时触发。
- 网关注意：`/ai-control/rpc/request` 是长连接（最长 120s），需要关闭代理层空闲超时（如 Nginx `proxy_read_timeout 130s`），否则会被网关提前断开。

## 5. 部署形态建议

- **最低成本**：后端主服务里加一个 controller（约 100 行），内存队列即可（单机、有状态可接受，命令在途时间 < 2s）。
- **网关透传**：若主服务不便改动，可做独立轻服务（同域名下 `/ai-control/*` 反代到它），复用统一鉴权。
- **页面侧开关**：页面只有在 `ai_control=1` 且用户/租户允许时启动轮询（权限位建议后端下发，见 §6）。

## 6. 安全（后续 P2 落地，先记录）

- `ai_control` 应改为后端权限位，不能只看 URL 参数。
- `/ai-control/rpc/*` 需与课件接口同一鉴权体系（token/会话），并做频率限制（如每实例 10 req/s）。
- 建议页面轮询地址由后端动态下发（`/ai-control/config`），避免前端硬编码。

## 7. 本地 dev 参考实现

- 仓库 `vue.config.js` 的 `devServer.before` 已实现上述全部端点（内存版，约 80 行），可直接对照。
- 页面侧实现：`src/modules/contentEditor/aiControl/index.js`（`startRpcPolling`）。
- 插件侧调用：`scripts/mcp-server/driver.js` 的 `connect(pageUrl, { mode: 'rpc' })` + `bridgeCall(method, args)`。