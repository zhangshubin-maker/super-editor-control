---
name: super-editor-control
description: 超媒内容编辑器（super-editor）总控技能。用户要求 Codex 控制编辑器完成局部课页修改、整书课件创建与跨目录编排、富文本编辑、书本搜索/克隆/跳转、模板与素材复用、题库选题和画布排版、数字模块配置或内容质量验收时使用。负责按任务规模选择局部或整书调用，并编排整书创作、质量、书本、状态、素材、文本、题目、数字模块、区块、元素、画布和大纲子技能。
---
# Super Editor Control（总控）

让 Codex 像控制 Figma 一样控制超媒编辑器：实时查看画布、操作元素与区块、调整属性、保存与回退。核心是用户通过编辑器顶部“AI 控制”开关挂载的页面桥接对象 `window.__superEditor`。

## 0. 子技能地图（按子任务加载对应技能）

| 子技能 | 场景 | 关键能力 |
|--------|------|---------|
| `super-editor-state` | 读取/理解现状：页面列表、区块树、元素树、元素类型、找重复、备份 | getState / getSlide / getBlock / listElements / getCanvasTree / searchElements / isDirty |
| `super-editor-assets` | 获取用户信息；搜索、理解并应用本书样章/区块模板、组件库和图片素材；自主新增目录前的素材选型 | getUserInfo / searchTemplates / applyTemplate / searchComponents / applyComponent / searchImageLibrary / applyLibraryImage |
| `super-editor-books` | 搜索和核对源书；继承源书属性与内容创建新书；覆盖名称、教辅类型和封面；生成或执行书本跳转 | searchBooks / getBookInfo / createBookFromSource / jumpToBook |
| `super-editor-book-authoring` | 创建或扩充整本书、跨目录编排、只读参考样章并实际应用区块模板、从题库选题排版 | getBookManifest / searchBookContent / planQuestionLesson / renderQuestionsToBlock |
| `super-editor-quality` | micro/current/book 分层核对、当前页保存回读、Bridge 实际审计、持久版本查看与恢复 | auditContent / saveVerified / listBookVersions / getBookVersion / restoreBookVersion |
| `super-editor-questions` | 浏览题目路径/筛选字典；搜索当前目录、当前书资源、学习路径或总题库；读取详情/题解并校验选题；管理目录题目和题目 AI 讲解 | listQuestionPaths / getQuestionSearchOptions / searchQuestions / getQuestions / validateQuestionSelection / getQuestionSolutions / 目录与讲解方法 |
| `super-editor-digital-modules` | 查询、创建、修改、删除和复制元素绑定的数字模块；配置跳转、定位、计时、图文、音视频、课件、题目等点击交互 | listDigitalModuleTypes / getDigitalModule / listDigitalModules / createDigitalModule / updateDigitalModule / deleteDigitalModule / copyDigitalModule |
| `super-editor-text` | 结构化读取和安全编辑普通文本、表格单元格、思维导图节点；局部替换、字符/段落/列表格式、独立文本框布局、字体、搜索、样式复制和适配检查 | getTextDocument / editText / formatText / setTextLayout / inspectTextLayout / fitTextToBox / searchTextElements |
| `super-editor-blocks` | 区块增删改查、复制、移动、重命名、调尺寸、批量插入/替换/跨页复制 | addBlock / updateBlock / deleteBlock / moveBlock / cloneBlock / insertBlocks / replaceBlock / copyBlockToSlide |
| `super-editor-elements` | 元素增删改查、属性与样式、批量、对齐/分布、选中、打组/解组、层级、**表格（读网格/改单元格/行列增删/合并拆分）**、选项卡 | addElement / updateElements / alignElements / setElementSpacing / setTextStyle / getTableGrid / setTableCellContent / mergeTableCells / groupElements 等 |
| `super-editor-canvas` | 页面切换/增删/排序/重命名/复制、滚动定位/缩放、截图、**快照回滚（checkpoint/rollback，替代撤销重做）**、保存、整页备份导入 | scrollToBlock / setZoom / fitCanvas / renameSlide / duplicateSlide / exportSlide / screenshot / checkpoint / rollback / save |
| `super-editor-outline` | 大纲（图层面板左侧「大纲」树）：读树、增删改查、移动排序、关联区块、锚点增删改查；支持读取任意目录大纲，为自动生成其他目录大纲打基础 | getOutline / addOutline / renameOutline / deleteOutline / moveOutline / linkOutlineBlocks / getOutlineAnchors / addOutlineAnchor 等（v0.8） |

完整桥接契约见插件 `assets/bridge-api-spec.md`，接入步骤见 `assets/editor-integration-guide.md`。

## 1. 架构

- **桥接层**（super-editor 仓库内实现）：`src/modules/contentEditor/aiControl/`，页面挂载 `window.__superEditor`。覆盖整书清单与跨目录检索、安全保存/切页、持久版本、内容审计、题库到区块排版，以及状态、素材、书本、题目、数字模块、页面、区块、元素、大纲、文本、上传、回滚和截图。
- **插件本地 RPC broker**（正式推荐）：插件 MCP 进程在 `127.0.0.1:8765` 提供浏览器 RPC。页面开启“AI 控制”后自动注册，无需 Electron 或正式站点后端 RPC。
- **插件 stdio MCP**：`.mcp.json` 启动插件自带适配器；`editor_*` 工具首次调用时自动选择可用页面。多 Codex 任务通过页面租约隔离，owner 退出后 follower 自动接管。
- **开发 RPC 兜底**：开发页面默认也使用插件本地 broker。只有显式设置 `window.__SUPER_EDITOR_RPC_URL = window.location.origin + '/ai-control'` 时，才使用 `vue.config.js` 的同源 dev RPC。
- **浏览器控制**：`browser:control-in-app-browser` / `chrome:control-chrome` 提供页面读取与截图；注意其 evaluate 是**只读沙箱**，看不到 `window.__superEditor`，只用于探测 DOM 标记与截图。

## 1.5 按 micro / current / book 调用

- **micro**：一个明确元素、文本 target、样式或数字模块。只读写并复读目标；例如文本错字使用 `editor_text_document` → `editor_text_edit` → 同 target 复读。画布 dirty 时调用 `editor_save_verified(scope=current)`。不读取 manifest、不搜模板、不启动目录/整书审计。
- **current**：一个区块或一个目录。按需读取 current/standard manifest；结构写入前做当前页 checkpoint；只搜索与目标直接相关的少量素材；完成后 current 审计相关 checks 并保存。
- **book**：多个目录或整书。加载 `super-editor-book-authoring`，用 `scope=book, detail=summary, pageNo, pageSize` 分页建立清单；逐页 current 执行、审计、保存，只有明确整书交付才用 book 审计。
- `editor_get_book_manifest` 与 `editor_search_book_content(scope=book)` 都用 `pageNo/pageSize` 读取目录批次，搜索还要求非空 query 并受单批 limit 限制；只有 `editor_audit_content(scope=book)` 使用 cursor/limit。

连续且相互依赖的小步骤可用 `batch` 合并成**一次调用、一次返回**：

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
4. 多标签页/多窗口时每个 Codex 任务租用一个页面并固定其 `windowId`；刷新和当前窗口切书会自动等待同一窗口重新注册，绝不回退认领其他书本页面。只有主动切换目标窗口时才调用 `editor_connect()` 重新选择。
5. 所有画布写操作必须通过 MCP/桥接方法完成，禁止用鼠标键盘模拟。浏览器技能仅用于只读探测或辅助打开页面。

## 3. 标准工作流

1. **连接确认**：桥接 DOM 标记 + `ping()`（经 RPC 通道）。
2. **定级与侦察**：先判断 micro/current/book。micro 只读取明确目标；book 加载 `super-editor-book-authoring` 并分页读取轻量 manifest。书本搜索/创建/跳转加载 `super-editor-books`；题目任务先确认 scope、路径和当前目录映射；涉及点击交互时读取目标元素当前数字模块。
3. **规划**：新增目录或重做版式时加载 `super-editor-assets`；样章只读参考，`kind=chapter` 只在明确新增目录时应用，现有目录用 `kind=block` 实际插入区块模板。组件/图片只在区块结构或资源有缺口时搜索。文本修改加载 `super-editor-text`；题目排版加载 `super-editor-questions` 搜索/读取，再用 `super-editor-book-authoring` 计划和分批渲染；type 94 才准备讲解记录并加载 `super-editor-digital-modules`。
4. **执行**：每步一类操作（`super-editor-blocks` / `super-editor-elements` / `super-editor-text` / `super-editor-questions` / `super-editor-digital-modules`），完成后用对应读取工具核对；渲染核对用 `scrollToBlock` / `scrollToElement` + 页面截图（`super-editor-canvas` 3.2）。数字模块、目录题目和讲解写操作即时持久化，不依赖画布 `save()`。
5. **保存**：micro/current 写入均优先 `editor_save_verified(scope=current)` 回读校验；跨目录任务每完成一页就保存。若传 `expectedContentHash`，它必须是写后保存前取得的页级 hash，不能是文本 target hash 或审计 sourceHash。
6. **收尾**：micro 只复读目标；current 用相关 checks；整书交付才分页 book 审计。说明复用模板/素材、题目 GUID、保存结果、专用工具/预览仍需验证的项目和遗留问题。

## 4. 安全与纪律

- 编辑前备份原始 JSON；删除前比对内容（同名 ≠ 重复）。
- `addSlide`/`deleteSlide`/`moveSlide` 立即写库；`save()` 写当前页；涉及真实课件的大改动先告知。
- 有未保存改动时先 `editor_save_verified(scope=current)` 再 `editor_select_slide`；只有用户明确要求放弃改动时才走受支持的丢弃流程，不假设切页工具会自动保存。
- 每页大范围或结构性写入前使用当前页 checkpoint。`editor_list_book_versions` 只列出现有持久版本，不会创建恢复点，也不因 book 任务自动全书调用。
- 目录题目移除/排序必须使用目录关系 `resourceMappingId`，不是题目 GUID；题目 AI 讲解启动后用状态工具查询，不在一次调用内长轮询。
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
| RPC 调用超时 | 调用 `editor_status` 检查实例和 `windowId`；刷新后最多等待 30 秒自动恢复同一窗口。只有确认要主动换窗口时才重新开启目标页按钮并调用 `editor_connect()` |
| `getSlide` 报 int 反序列化错误 | id 参数传了对象 → 改传标量 |
| 截图缺内容 | 画布虚拟滚动 → 先用 `scrollToBlock` / `scrollToElement` 滚动到位再截图 |
| 保存后看不到 | 刷新页面后重新 `getSlide`；确认 `save()` 返回成功 |
