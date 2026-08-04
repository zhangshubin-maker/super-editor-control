---
name: super-editor-control
description: 超媒内容编辑器（super-editor）总控技能。用户要求 Codex 控制超媒编辑器完成课页/课件的创建、编辑、修改、优化、审查询课内容，搜索/克隆创建/跳转书本，或自主利用样章模板、区块模板、组件库和图片库设计新目录时使用。负责建立连接、编排工作流，并按子任务加载书本、状态、素材、区块、元素、画布和大纲子技能。
---
# Super Editor Control（总控）

让 Codex 像控制 Figma 一样控制超媒编辑器：实时查看画布、操作元素与区块、调整属性、保存与回退。核心是用户通过编辑器顶部“AI 控制”开关挂载的页面桥接对象 `window.__superEditor`。

## 0. 子技能地图（按子任务加载对应技能）

| 子技能 | 场景 | 关键能力 |
|--------|------|---------|
| `super-editor-state` | 读取/理解现状：页面列表、区块树、元素树、元素类型、找重复、备份 | getState / getSlide / getBlock / listElements / getCanvasTree / searchElements / isDirty |
| `super-editor-assets` | 获取用户信息；搜索、理解并应用本书样章/区块模板、组件库和图片素材；自主新增目录前的素材选型 | getUserInfo / searchTemplates / applyTemplate / searchComponents / applyComponent / searchImageLibrary / applyLibraryImage |
| `super-editor-books` | 搜索和核对源书；继承源书属性与内容创建新书；覆盖名称、教辅类型和封面；生成或执行书本跳转 | searchBooks / getBookInfo / createBookFromSource / jumpToBook |
| `super-editor-blocks` | 区块增删改查、复制、移动、重命名、调尺寸、批量插入/替换/跨页复制 | addBlock / updateBlock / deleteBlock / moveBlock / cloneBlock / insertBlocks / replaceBlock / copyBlockToSlide |
| `super-editor-elements` | 元素增删改查、属性与样式、批量、对齐/分布、选中、打组/解组、层级、**表格（读网格/改单元格/行列增删/合并拆分）**、选项卡 | addElement / updateElements / alignElements / setElementSpacing / setTextStyle / getTableGrid / setTableCellContent / mergeTableCells / groupElements 等 |
| `super-editor-canvas` | 页面切换/增删/排序/重命名/复制、滚动定位/缩放、截图、**快照回滚（checkpoint/rollback，替代撤销重做）**、保存、整页备份导入 | scrollToBlock / setZoom / fitCanvas / renameSlide / duplicateSlide / exportSlide / screenshot / checkpoint / rollback / save |
| `super-editor-outline` | 大纲（图层面板左侧「大纲」树）：读树、增删改查、移动排序、关联区块、锚点增删改查；支持读取任意目录大纲，为自动生成其他目录大纲打基础 | getOutline / addOutline / renameOutline / deleteOutline / moveOutline / linkOutlineBlocks / getOutlineAnchors / addOutlineAnchor 等（v0.8） |

完整桥接契约见插件 `assets/bridge-api-spec.md`，接入步骤见 `assets/editor-integration-guide.md`。

## 1. 架构

- **桥接层**（super-editor 仓库内实现）：`src/modules/contentEditor/aiControl/`，页面挂载 `window.__superEditor`。覆盖状态、用户与素材库查询，书本搜索/克隆创建/跳转，页面/区块/元素/大纲编辑，表格、思维导图、文本自适应、图片上传、快照回滚、保存与截图；v1.1 增加书本管理。
- **插件本地 RPC broker**（正式推荐）：插件 MCP 进程在 `127.0.0.1:8765` 提供浏览器 RPC。页面开启“AI 控制”后自动注册，无需 Electron 或正式站点后端 RPC。
- **插件 stdio MCP**：`.mcp.json` 启动插件自带适配器；`editor_*` 工具首次调用时自动选择可用页面。多 Codex 任务通过页面租约隔离，owner 退出后 follower 自动接管。
- **开发 RPC 兜底**：开发页面默认也使用插件本地 broker。只有显式设置 `window.__SUPER_EDITOR_RPC_URL = window.location.origin + '/ai-control'` 时，才使用 `vue.config.js` 的同源 dev RPC。
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

## 2. 连接

1. 在普通 Chrome / Edge 中打开目标课件；不需要 Electron 或调试模式。
2. 请用户点击编辑器顶部“AI 控制”开关；DOM 标记 `data-super-editor-bridge="1"` 表示桥接已挂载。首次出现本地网络权限提示时选择允许。
3. 可调用 `editor_status` 检查，或直接调用任务所需的 `editor_*` 工具；首次调用会自动连接，不要求先执行 `editor_connect`。
4. 多标签页/多窗口时每个 Codex 任务租用一个页面；需要切换时先在目标页面关闭再开启按钮，然后调用 `editor_connect()` 重新选择。
5. 所有画布写操作必须通过 MCP/桥接方法完成，禁止用鼠标键盘模拟。浏览器技能仅用于只读探测或辅助打开页面。

## 3. 标准工作流

1. **连接确认**：桥接 DOM 标记 + `ping()`（经 RPC 通道）。
2. **侦察**：书本搜索/创建/跳转先加载 `super-editor-books`；课件编辑用 `getState()` → `getSlide(currentSlideId)` → 全量 JSON 备份到磁盘（`super-editor-state`）。
3. **规划**：列出改动清单（增/删/改/移）；新增目录或重做版式时先加载 `super-editor-assets`，盘点可复用模板、组件和图片，再确定从模板起步还是从空白页起步。
4. **执行**：每步一类操作（`super-editor-blocks` / `super-editor-elements`），完成后用 `getBlock` / `listElements` 核对；渲染核对用 `scrollToBlock` / `scrollToElement` + 页面截图（`super-editor-canvas` 3.2）。
5. **保存**：`save()` → 刷新页面（F5 / reload）→ `getSlide` 验证持久化（`super-editor-canvas` 4）。
6. **收尾**：告知用户刷新浏览器页面查看；更新备份目录。

## 4. 安全与纪律

- 编辑前备份原始 JSON；删除前比对内容（同名 ≠ 重复）。
- `addSlide`/`deleteSlide`/`moveSlide` 立即写库；`save()` 写当前页；涉及真实课件的大改动先告知。
- 桥接只在用户开启顶部“AI 控制”按钮后挂载，关闭按钮或离开页面时卸载。
- 写操作必须走桥接（Vuex action），不要直接改 store，否则破坏撤销/重做。
- **自动保存已禁用**：AI 控制开启时编辑器自动保存（10s 定时）已禁用，AI 的改动只有显式调用 `save()` 才会写回后端；测试性改动结束后仍需删除/还原，`getState().dirty` 可判断是否有未保存改动。
- **禁止用鼠标/键盘模拟画布操作**（拖拽、输入坐标等）；效率低且不准，一律用 `moveElement` / `resizeElement` / `scrollToBlock` 等桥接方法。

## 5. 故障排查速查

| 现象 | 处理 |
|------|------|
| BRIDGE_MISSING | 确认普通浏览器中的课件已开启顶部“AI 控制”；必要时关闭后重新开启 |
| MCP 无法连接 | 更新/安装插件后新开 Codex 任务；检查 `http://127.0.0.1:8765/ai-control/rpc/health`，并确认 8765 未被其他程序占用 |
| 页面一直 waiting | 允许浏览器本地网络访问；正式站点 CSP 的 `connect-src` 加入 `http://127.0.0.1:8765` |
| OUTCOME_UNKNOWN | 命令可能已经执行，禁止直接重放写操作；先读取页面/元素状态再决定 |
| RPC 调用超时 | 调用 `editor_status` 检查实例；确认目标页面没有关闭/刷新，必要时重新开启顶部按钮并 `editor_connect()` |
| `getSlide` 报 int 反序列化错误 | id 参数传了对象 → 改传标量 |
| 截图缺内容 | 画布虚拟滚动 → 先用 `scrollToBlock` / `scrollToElement` 滚动到位再截图 |
| 保存后看不到 | 刷新页面后重新 `getSlide`；确认 `save()` 返回成功 |
