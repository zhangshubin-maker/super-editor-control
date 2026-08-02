---
name: super-editor-control
description: 超媒内容编辑器（super-editor）总控技能。用户要求 Codex 控制超媒编辑器完成课页/课件的创建、编辑、修改、优化、审查询课内容时使用。负责建立与编辑器页面的连接（同源 RPC/浏览器探测）、编排整体工作流，并按子任务加载 super-editor-state / super-editor-blocks / super-editor-elements / super-editor-canvas 子技能，处理保存与安全。
---
# Super Editor Control（总控）

让 Codex 像控制 Figma 一样控制超媒编辑器：实时查看画布、操作元素与区块、调整属性、保存与回退。核心是页面内挂载的桥接对象 `window.__superEditor`（页面以 `ai_control=1` 打开时挂载）。

## 0. 子技能地图（按子任务加载对应技能）

| 子技能 | 场景 | 关键能力 |
|--------|------|---------|
| `super-editor-state` | 读取/理解现状：页面列表、区块树、元素树、元素类型、找重复、备份 | getState / getSlide / getBlock / listElements / getCanvasTree / searchElements / isDirty |
| `super-editor-blocks` | 区块增删改查、复制、移动、重命名、调尺寸、批量插入/替换/跨页复制 | addBlock / updateBlock / deleteBlock / moveBlock / cloneBlock / insertBlocks / replaceBlock / copyBlockToSlide |
| `super-editor-elements` | 元素增删改查、属性与样式、批量、对齐/分布、选中、打组/解组、层级、**表格（读网格/改单元格/行列增删/合并拆分）**、选项卡 | addElement / updateElements / alignElements / setElementSpacing / setTextStyle / getTableGrid / setTableCellContent / mergeTableCells / groupElements 等 |
| `super-editor-canvas` | 页面切换/增删/排序/重命名/复制、滚动定位/缩放、截图、**快照回滚（checkpoint/rollback，替代撤销重做）**、保存、整页备份导入 | scrollToBlock / setZoom / fitCanvas / renameSlide / duplicateSlide / exportSlide / screenshot / checkpoint / rollback / save |

完整桥接契约见插件 `assets/bridge-api-spec.md`，接入步骤见 `assets/editor-integration-guide.md`。

## 1. 架构

- **桥接层**（super-editor 仓库内实现）：`src/modules/contentEditor/aiControl/`，页面挂载 `window.__superEditor`，所有写操作走 Vuex action（保留撤销/重做与操作日志）。已实现 126 个方法（v0.4 表格 8 个 + batch；v0.5 思维导图 9 个；v0.6 文本读取/内容/自适应/重测 4 个；v0.7 表格行高自适应 fitTableHeights）：查询（getBlock/getElement/listElements/getCanvasTree/getSlideStats/searchElements）、选中（selectElement(s)/getSelection）、视图（getViewport/setViewport/scrollCanvas/scrollToElement/scrollToBlock）、区块/元素/页面增删改查、快照回滚、保存截图。
- **同源 RPC 通道**（推荐）：页面默认轮询 `{origin}/ai-control/rpc`（dev server 已实现，生产由后端按 `assets/production-integration-spec.md` 提供），外部进程 POST `/ai-control/rpc/request` 长轮询等结果即可调用任意方法。无需 CDP、无需本地服务、无需认领标签。可用 `window.__SUPER_EDITOR_RPC_URL` 覆盖为独立本地服务（如 `http://127.0.0.1:8765`）。详见 `assets/bridge-api-spec.md` 6.5。
- **插件 MCP**：`editor_*` 工具（50 个，v0.5 思维导图 4 个：editor_mind_*；v0.6 文本 4 个：editor_text_info / editor_text_set_content / editor_text_adaptive / editor_text_fit），统一走同源 RPC 通道，`editor_connect({ pageUrl })` 传课件 URL 即可，不依赖 CDP / 浏览器调试端口。
- **浏览器控制**：`browser:control-in-app-browser` / `chrome:control-chrome` 提供页面读取与截图；注意其 evaluate 是**只读沙箱**，看不到 `window.__superEditor`，只用于探测 DOM 标记与截图。

## 1.5 批量执行（强烈推荐，减少等待）

连续小步骤不要逐条调用，用 `batch` 合并成**一次调用、一次返回**：

```js
// 读取合并：一次拿全
await b.batch({ steps: [
  { method: 'getState' },
  { method: 'getSlide', args: ['3562'] },
  { method: 'listBlocks' }
] })

// 编辑合并：快照 + 多步改动 + 核对 一次往返
await b.batch({ steps: [
  { method: 'checkpoint', args: [{ label: '调整前基线' }] },
  { method: 'updateElements', args: [{ elementIds: ['a', 'b'], patch: { defaultColor: '#333333' } }] },
  { method: 'scrollToBlock', args: ['blockId'] },
  { method: 'getSlide', args: ['3562'] }
] })

// 收尾合并
await b.batch({ steps: [
  { method: 'rollback', args: [{ checkpointId: 'xxx' }] },
  { method: 'save' }
] })
```

- 步骤按顺序**串行**执行，每步完成后自动等渲染，写操作安全；失败默认即停（`stopOnError: false` 可收集全部结果）。
- 返回 `{ results: [{ index, method, ok, value/error }], stopped, stoppedAt }`，逐条核对 `ok`。
- MCP 工具：`editor_batch({ steps, stopOnError })`。

## 2. 连接（按优先级）

### 方式 A：同源 RPC 通道（推荐，无需 CDP / 本地服务 / 标签认领）
1. 确认页面 URL 带 `ai_control=1` 且 `document.documentElement.getAttribute('data-super-editor-bridge') === '1'`（只读探测即可）。
2. 页面默认轮询 `{origin}/ai-control/rpc/poll?instance=<id>`（dev server 已内置该路由；生产由后端按 `assets/production-integration-spec.md` 提供）。
3. 调用方（插件 MCP 或脚本）直接 `POST {origin}/ai-control/rpc/request`：`{ method, args, timeoutMs?, targetInstance? }`，服务端入队并在页面回传结果后响应（长轮询，最多 90s）：
   ```json
   { "ok": true, "value": { ... }, "error": "" }
   ```
4. 调用任何桥接方法都走这个通道（如 `ping()`、`getSlide`、`moveElement`、`save()`）。**所有画布操控一律通过桥接方法，禁止用鼠标/键盘模拟**。
5. 多标签页/多窗口时，先 `ping()` 拿响应里的 `instance` 字段（或 `editor_status` 的 `instanceId`），后续请求固定带 `targetInstance`，避免路由到旧页面。
5. 兜底：若目标环境没有 `/ai-control/rpc` 路由，可在页面加载前注入 `window.__SUPER_EDITOR_RPC_URL` 指向本地 8765 独立服务（协议同 §6.5）。

### 方式 B：MCP 工具（首选入口）
1. `editor_connect({ pageUrl: '<课件完整URL>' })` → 自动解析 origin 并连接同源 RPC 通道；
2. `editor_status` 确认 `bridgeReady=true`；
3. 用 `editor_*` 工具操作（与方式 A 同一条链路）。
页面没开时：先用浏览器技能打开课件 URL（`ai_control=1`），再 `editor_connect`。

### 方式 C：浏览器技能（只读）
打开带 `ai_control=1` 的 URL；只读探测可用（DOM 标记、innerText、页面截图）；**一切写操作与画布滚动必须走方式 D / A / B 的桥接调用**。

## 3. 标准工作流

1. **连接确认**：桥接 DOM 标记 + `ping()`（经 RPC 通道）。
2. **侦察**：`getState()` → `getSlide(currentSlideId)` → 全量 JSON 备份到磁盘（`super-editor-state`）。
3. **规划**：列出改动清单（增/删/改/移），先小步验证桥接能力，大改动先告知用户。
4. **执行**：每步一类操作（`super-editor-blocks` / `super-editor-elements`），完成后用 `getBlock` / `listElements` 核对；渲染核对用 `scrollToBlock` / `scrollToElement` + 页面截图（`super-editor-canvas` 3.2）。
5. **保存**：`save()` → 刷新页面（F5 / reload）→ `getSlide` 验证持久化（`super-editor-canvas` 4）。
6. **收尾**：告知用户刷新浏览器页面查看；更新备份目录。

## 4. 安全与纪律

- 编辑前备份原始 JSON；删除前比对内容（同名 ≠ 重复）。
- `addSlide`/`deleteSlide`/`moveSlide` 立即写库；`save()` 写当前页；涉及真实课件的大改动先告知。
- 桥接只在 `ai_control=1` 的开发/测试环境挂载；生产环境默认关闭。
- 写操作必须走桥接（Vuex action），不要直接改 store，否则破坏撤销/重做。
- **自动保存已禁用**：`ai_control=1` 模式下编辑器自动保存（10s 定时）已禁用，AI 的改动只有显式调用 `save()` 才会写回后端；测试性改动结束后仍需删除/还原（避免留下脏数据），`getState().dirty` 可判断是否有未保存改动。
- **禁止用鼠标/键盘模拟画布操作**（拖拽、输入坐标等）；效率低且不准，一律用 `moveElement` / `resizeElement` / `scrollToBlock` 等桥接方法。

## 5. 故障排查速查

| 现象 | 处理 |
|------|------|
| BRIDGE_MISSING | URL 是否带 `ai_control=1`；刷新页面；确认桥接层已实现（`assets/editor-integration-guide.md`） |
| 读不到 `window.__superEditor` | 沙箱隔离正常现象 → 用 DOM 标记探测，调用一律走同源 RPC 通道（方式 A / B） |
| RPC 调用超时 | 检查 `GET {origin}/ai-control/rpc/instances` 是否有注册实例（无则页面未开/未带 ai_control=1）；`ping()` 先行验证；同源路由缺失时注入 `window.__SUPER_EDITOR_RPC_URL` 走本地 8765 |
| `getSlide` 报 int 反序列化错误 | id 参数传了对象 → 改传标量 |
| 截图缺内容 | 画布虚拟滚动 → 先用 `scrollToBlock` / `scrollToElement` 滚动到位再截图 |
| 保存后看不到 | 刷新页面后重新 `getSlide`；确认 `save()` 返回成功 |
