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
- 首次连接后会固定页面的 `windowId`。Bridge v1.9.0+ 热切书时继续使用原 `instanceId` 和租约；旧 Bridge 安排完整刷新后，驱动立即建立新实例屏障，排除旧 `instanceId`（即使它在 50ms 延迟期已上报目标书状态），最多等待 30 秒并只认领同一浏览器窗口的新实例，其他已打开书本不会成为回退目标。

- `editor_export_semantic_snapshot` 通过 Bridge v1.10.0+ 的只读 `getSemanticSnapshot` 冻结当前
  书本内当前或指定普通目录的完整可编辑语义快照。它包含原始区块/元素、元素路径与几何索引、
  大纲、normalized+raw 数字模块、字体、富文本结构及 working/persisted/dirty 身份；结果按内容
  寻址写入系统临时目录并返回绝对路径、独立文件 SHA-256、Bridge 稳定 hash 和完整度。
  `richText` 支持 `none/summary/deep`，默认 `deep`；书级字体清单来源明确为 `book-store-empty`、且唯一
  缺项/告警为 `fonts/FONT_MAPPING_EMPTY` 时会保留诊断但仍返回 `fullFidelity=true`，因为富文本内联字体
  与其他语义分节仍然完整。其他 `fullFidelity=false` 结果必须停止或补齐。旧 Bridge 缺少该原子方法时明确返回
  `SEMANTIC_SNAPSHOT_UNSUPPORTED`，不会用摘要拼装伪降级。
  MCP 会重算 Bridge `stableHash`，并把 envelope 以仅当前用户可读写的受控临时目录/文件权限
  （POSIX `0700/0600`，Windows 使用系统 ACL 语义）落盘；拒绝符号链接和非普通目标。返回的
  `snapshotStableHashVerified=true` 表示权威内容哈希已经复算通过，`snapshotFileSha256` 则校验实际文件。
- `editor_jump_to_book(target=current)` 会先检查 dirty 状态；需要保存时传 `saveBeforeSwitch=true`。工具优先等待原实例的目标 `bookId`、`contextEpoch` 和 `bookSwitching=false` 在 `ping/getState` 中收敛，并确认普通书存在当前目录且 `contentReady=true`；`emptyBook=true` 和 `currentSlidePlaceholder=true` 是显式可就绪例外。刷新兜底不沿用旧页 epoch，只等待同一 `windowId` 的新实例。成功统一返回 `ready=true`，不把 `scheduled=true` 当成切书完成；v1.8 无内容就绪字段时保持兼容。
- 新标签页/新窗口使用不同 `windowId`；如果检测到同一窗口身份对应多个页面，会以 `WINDOW_AMBIGUOUS` 安全失败，禁止猜测和串页。
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
| `editor_list_slides` / `editor_select_slide` | 列出并安全切换目录；dirty 时显式保存或丢弃改动 |
| `editor_search_books` / `editor_get_book` / `editor_create_book` | 搜索、核对并创建书本 |
| `editor_jump_to_book` | 生成书本 URL，或在当前窗口原实例热切书并等待目标上下文就绪；兼容完整刷新兜底 |
| `editor_get_book_manifest` / `editor_search_book_content` | 按当前目录或显式整书范围理解、搜索课件内容 |
| `editor_save_verified` | 保存当前 dirty 页并回读校验；可显式执行整书摘要校验 |
| `editor_list_book_versions` / `editor_get_book_version` / `editor_restore_book_version` | 查询、预检和恢复后端持久版本 |
| `editor_search_templates` / `editor_get_template` / `editor_apply_template` | 搜索本书或模板中心、按 id 读取并应用模板；模板中心必须指定超媒/界面交互型 |
| `editor_search_components` / `editor_apply_component` | 搜索并应用组件 |
| `editor_search_images` / `editor_apply_image` | 搜索并应用图片素材 |
| `editor_upload_file` | 上传本地/base64 图片、音频、视频、PDF 或课件文件 |
| `editor_list_digital_module_types` | 查询可自动配置的数字模块类型和语义配置 schema |
| `editor_get_digital_module` / `editor_list_digital_modules` | 查询元素关联的数字模块 |
| `editor_create_digital_module` / `editor_update_digital_module` | 新增或修改元素数字模块（即时写库） |
| `editor_delete_digital_module` / `editor_copy_digital_module` | 删除模块或复用同一 model_id 复制关联 |
| `editor_list_question_paths` / `editor_get_question_search_options` | 读取本书学习路径和题目筛选字典 |
| `editor_search_questions` / `editor_get_questions` | 查询当前目录、本书资源、学习路径或总题库，并按 GUID 读取详情 |
| `editor_validate_question_selection` / `editor_get_question_solutions` | 校验数字模块选题并读取答案、解答和解析 |
| `editor_plan_question_lesson` / `editor_render_questions_to_block` | 按题库题目规划并排版讲解、练习或测评课件 |
| `editor_add_questions_to_catalog` / `editor_remove_catalog_question` / `editor_move_catalog_question` | 管理目录题目资源及顺序（即时写库） |
| `editor_get_question_explanations` / `editor_start_question_explanation_generation` / `editor_get_question_explanation_status` | 读取、启动生成和查询 AI 讲解 |
| `editor_save_question_explanation` / `editor_delete_question_explanation` | 保存或删除 AI 讲解记录（即时写库） |
| `editor_add_block` / `editor_update_block` / `editor_delete_block` | 区块编辑 |
| `editor_add_element` / `editor_update_element` / `editor_delete_element` | 元素编辑 |
| `editor_replace_block_safe` / `editor_replace_element_safe` | 完整 JSON 两阶段原位替换；保持递归 ID 与层级，保护数字模块锚点 |
| `editor_text_info` / `editor_text_document` | 读取文本框摘要或带稳定索引的结构化富文本文档 |
| `editor_text_set_style` / `editor_text_format` | 设置默认样式，或按全文/范围/匹配/段落应用可见格式 |
| `editor_text_edit` | 局部插入、替换、删除或查找替换富文本 |
| `editor_text_set_link` / `editor_text_remove_link` | 原子设置/移除文字超链接并同步元数据 |
| `editor_text_edit_embed` | 原子插入、更新或删除公式、拼音和内嵌图片 |
| `editor_text_set_layout` / `editor_text_inspect_layout` | 设置文本框布局并诊断溢出、裁切和字体问题 |
| `editor_text_fit` / `editor_text_fit_to_box` | 让文本框适应内容 / 保持框大小并缩小字号 |
| `editor_text_search` / `editor_text_copy_style` / `editor_text_fonts` | 搜索文本、复制样式和查询可用字体 |
| `editor_checkpoint` / `editor_rollback` | 整页快照与回滚 |
| `editor_audit_content` | 按当前目录或显式整书范围审计结构、文本、资源和布局 |
| `editor_save` / `editor_screenshot` | 保存与渲染核对 |
| `editor_batch` | 一次往返串行执行多个桥接步骤 |

完整工具以 `tools/list` 为准，桥接契约见 `../../assets/bridge-api-spec.md`。

## 整书工具的调用粒度

- 所有整书相关读取默认 `scope=current`；manifest 和题目规划同时默认 `detail=summary`。一次文字、
  元素或当前区块修改不应先扫描整书。
- 只有任务明确涉及跨目录规划、统一或验收时才传 `scope=book`。`editor_get_book_manifest` 使用
  `pageNo/pageSize` 分页；`editor_search_book_content(scope=book)` 同样可用 `pageNo/pageSize`
  限定本次搜索的目录页。
- `editor_audit_content(scope=book)` 使用非负整数 `cursor` 和最大 100 的 `limit` 分批返回；继续
  审计时把上次结果的 `nextCursor` 原样传回，直到它为 `null`。
- `detail=deep` 只用于确实需要正文、区块和关联数据的宏观任务。普通定位先调用
  `editor_search_book_content`，再针对命中目录读取，不要直接深读所有目录。
- `editor_save_verified(scope=book)` 只保存当前 dirty 页，随后做整书摘要校验；它不会逐页切换和
  重写全书。
- `editor_list_book_versions(scope=book)` 用 `pageNo/pageSize` 分页目录，再用
  `versionPageNo/versionPageSize` 分页每个目录的版本，避免隐式请求所有目录的全部历史。
- 新目录设计优先用 `editor_search_templates` / `editor_get_template` 搜索样章和区块模板；默认
  `scope=book`，需要模板中心时用 `scope=center` 并明确
  `interactionType=hypermedia/interface`，再参考其
  成熟结构与风格。先应用模板得到真实目标区块，再向该 `blockId` 排版题目；题目编排的
  `styleReference` 只记录/核对参考来源，不会自行下载模板或替换真实题目内容。
- 版本恢复和题目区块写入先使用 `validateOnly=true`；确认影响范围后再实际写入。
- `editor_select_slide` 仅传 `slideId` 时兼容原调用；当前页 dirty 时必须额外传
  `saveBeforeSwitch=true` 或 `discardChanges=true`，两者不能同时为 true。

## 数字模块与媒体文件

- 数字模块工具只接收元素 `elementId`；页面桥接负责从元素所属区块解析数据库数值 `id`
  作为 `hypermedia_content_id`，不会把区块 uuid 当成后端 id。
- 安全 JSON 替换先保持 `dryRun=true` 读取 `changedPaths/expectedHash`，确认后用同一候选对象传
  `dryRun=false + expectedHash`。任何 block/element id、类型、父子关系、顺序、templateId 或 groupId
  变化都会零写入拒绝；`allowedPaths` 可进一步限制允许修改的字段前缀。
- 新增、修改、删除和复制数字模块都直接请求后端并即时生效，不依赖 `editor_save`。
- `editor_copy_digital_module` 与编辑器现有复制/粘贴行为一致：目标元素建立新关联，但复用同一个
  `model_id`，不是独立深克隆。
- 创建或修改音视频模块时，可先用 `editor_upload_file` 获得 `url/fileId`；也可直接传
  `mediaPath`，MCP 会先上传并把结果放入 `config.uploadedFile`。
- `validateOnly=true` 不允许与 `mediaPath` 同传，确保校验模式没有上传副作用；需要校验媒体配置时，
  先显式调用 `editor_upload_file`，再把已有 URL/metadata 放入 `config`。
- 本地文件经 base64 进入 RPC，当前主动限制为 70MB。更大的音视频应先压缩，或使用素材库/
  AI 生成服务返回的远程 URL，避免 100MB broker 请求上限和 90 秒 RPC 超时。

## 题目检索、课件编排、目录资源与 AI 讲解

- `editor_search_questions.scope` 支持：
  - `currentCatalog`：当前目录已添加的题目资源；
  - `currentBookResources`：当前书全部目录已添加的题目资源；
  - `learningPath`：按本书学习路径节点检索，先用 `editor_list_question_paths` 获取 `pathId`；
  - `book`：`learningPath` 的兼容别名；
  - `global`：总题库。
- 复杂筛选前先调用 `editor_get_question_search_options` 获取真实 id。搜索工具提供显式的学段、学科、
  年级、册次、难度、题型、资源可用性、来源和标签筛选；旧 `filters` 对象只做白名单兼容，不能覆盖
  关键词和分页参数。
- `editor_get_questions` 默认保持数组返回；`includeDiagnostics=true`（或兼容参数
  `returnEnvelope=true`）返回 `items/requestedGuids/foundGuids/missingGuids`，避免静默丢失 GUID。
- 创建答题类数字模块前调用 `editor_validate_question_selection`，检查缺失、重复、父子题冲突以及
  目标模块类型的数量和资源要求。最终关联使用题目/子题 `guid`，不要使用列表记录的数值 id。
- `editor_plan_question_lesson` 只读：根据题目 GUID、教学目标和 `layout=auto/practice/explain/assessment`
  形成编排计划。它只处理显式 GUID，即使 `scope=book` 也不会扫描整书；`detail=summary` 只读取
  题目详情，`detail=deep` 才预检题目组件和数据。`styleReference` 记录预先选定的样章/区块模板来源。
- `editor_render_questions_to_block` 把计划或 GUID 排版到画布区块；默认 `append`，`replace` 会替换
  目标区块内容。先传 `validateOnly=true` 检查题目、目录和区块，再执行并保存当前页。
- 删除和移动目录题目使用 `resourceMappingId`，不是题目 GUID。目录题目的新增、删除、排序都会立即
  写入后端，不依赖 `editor_save`；新增支持 `validateOnly=true`。
- AI 讲解生成采用启动/状态分离：先调用 `editor_start_question_explanation_generation`，再按需调用
  `editor_get_question_explanation_status`。MCP 不在单次调用里长轮询。数字模块 94 使用讲解记录的 `id`
  作为 `explain_ids`，不要把题目 GUID、子题 GUID 和讲解记录 id 混用。

## 结构化富文本

- Bridge 1.6.0 起，内容类工具统一支持三类目标：普通文本
  `{ target:{ kind:'element', elementId } }`、表格单元格
  `{ target:{ kind:'tableCell', tableId, cellId } }`（也可用 `row+col`）和思维导图节点
  `{ target:{ kind:'mindNode', mindId, nodeId } }`。原有 `{ elementId }` 调用保持兼容，但一次调用只能传
  `elementId` 或 `target` 之一。适用于 `info/document/set_content/set_style/edit/set_link/remove_link/edit_embed/format`。
- 用 `editor_text_document` 取得可见 `plainText/displayText`、Quill `indexText`、
  `displayIndexMap`、HTML、段落、格式 runs、内嵌对象、超链接、默认样式、布局，以及联合覆盖
  canonical HTML 与稳定排序超链接元数据的 `contentHash`；`htmlHash`、`hyperlinkMetadataHash`
  用于分项诊断。仅链接参数变化也会改变 `contentHash`。
  拼音框在可见文本中展开 word，但在 Quill 索引中仍长度 1；不能把 plainText 下标直接用于写入。
- `editor_text_edit.action` 支持 `insert/replace/delete/findReplace`。`insert` 使用 `index`，
  `replace/delete` 使用 `index+length`；只有 `findReplace` 使用 `match+occurrence`，省略 `text/html`
  表示删除匹配。写入内容时 `text` 与 `html` 二选一。高风险批量替换先用 `dryRun=true`，写入时带上
  最近读取到的 `expectedContentHash`，它同时保护正文与超链接参数。
- 只有明确要整段重写时使用 `editor_text_set_content`，并同样带最新 `expectedContentHash`、先
  `dryRun=true`；它会检查未知链接和不能安全往返的内嵌结构。
- 正文读取与写入最多执行 5 轮生产 `parse → convertHTML`。相邻结果完全一致，或其 Quill 文档的
  文本顺序、有效样式、内嵌对象和超链接语义一致，均可通过；仅标签嵌套、属性顺序或连续 run 切分
  不同不再阻塞。每轮仍检查受保护结构；真实语义变化或超限都不写入。
- 超链接不要塞进 `editor_text_format`：用 `editor_text_set_link` 原子设置范围并同步
  `hyperlinkParamList`，用 `editor_text_remove_link` 按 id 或范围移除。新链接必须提供真实元数据，不能猜测；
  `hyperlink_id` 可省略并由 Bridge 生成，后续以返回的 `hyperlinkId` 为准。
- 公式、拼音和内嵌图片用 `editor_text_edit_embed` 增删改；插入拼音必须给 pinyin+单汉字 word。
  图片支持 url、宽高/原始宽高、旋转、透明度、翻转、描边、垂直对齐和偏移等 ImageBot 结构字段；
  更新会与当前 embed value 合并，可只改部分字段，不能用 CSS style 代替结构字段；
  删除不传 `value`。页面未注册对应自定义 blot 时会明确拒绝写入。
- `editor_text_format.scope` 支持 `default/all/range/match/paragraph`，覆盖中英数字字体、字号、颜色、
  粗斜体、上下标、下划线/删除线/波浪线/着重号，以及对齐、行距、段距、缩进和列表；
  `paragraphIndexes` 是来自文档段落的 0-based 下标。该工具支持 `expectedContentHash + dryRun`。
- `editor_text_set_style` 是 `scope=default` 的便捷安全入口，只接受默认字体、字号、颜色、粗斜体、
  行距和字距等默认字段；它不会覆盖已有内联 run。对齐、列表、下划线、背景等可见格式请使用
  `editor_text_format(scope=all/range/match/paragraph)`。
- `editor_text_set_layout` 修改的是文本框：自适应模式、最大宽高、溢出、内边距、横竖排、对齐、背景、
  描边、阴影和圆角；嵌套对象由页面桥接深合并，不会因只改一个字段而清空其余配置。
  `overflowType` 使用 `auto/overWithBreak/overSizeScroll` 数组；填充使用
  `{ enabled?, color? }` 或 null（禁用并清空），不接受会被静默忽略的颜色字符串。该工具不修改正文，
  不接受 `expectedContentHash/dryRun`。布局/几何类
  `editor_text_adaptive/fit/set_layout/inspect_layout/fit_to_box` 仅支持独立文本元素的 legacy `elementId`，
  不支持表格单元格或思维导图节点。
- `editor_text_inspect_layout` 用于写后诊断。`editor_text_fit` 会按当前 `extendType` 改变文本框尺寸；
  它不修改正文，也不接受 `expectedContentHash/dryRun`。`editor_text_fit_to_box` 保持宽高并在
  `minFontSize/maxFontSize/step` 范围内缩小字号，接受 `expectedContentHash` 但不接受 `dryRun`；元素未渲染时会
  明确返回 `applied=false/reason=element-not-rendered`。混合或不可解析字号默认返回
  `applied=false/reason=mixed-font-sizes/requiresExplicitUniformization=true` 且零写入；只有用户明确同意统一
  原字号后才传 `allowUniformizeMixedSizes=true`，并核对 `uniformizedMixedSizes=true`。
- `editor_text_search` 当前搜索已加载目录三类目标的可见文本，`targetKinds` 默认
  `element/tableCell/mindNode`，返回可直接写入的 `index/length`，并另给仅供展示的
  `displayIndex/displayLength`、`target/targetKind/elementId/blockId/snippet`；
  `editor_text_copy_style` 可用 `sourceTarget/targetTargets` 或 legacy id（两侧可混用）把样式复制到最多
  200 个目标。嵌套目标仅支持 `default/character/paragraph`；`layout/all` 会返回
  `TEXT_LAYOUT_TARGET_UNSUPPORTED`。设置字体前先用
  `editor_text_fonts` 按 `all/chinese/english/number` 查询可用项。

文本写操作修改当前页本地状态，完成后仍需 `editor_save`。推荐先
`editor_checkpoint({ label? })`，读取文档并携带 hash 局部修改，随后检查布局和截图；失败时调用
`editor_rollback({ checkpointId })`。包含超链接、公式等内嵌结构时尤其不要用通用
`editor_update_element` 直接拼接 HTML；Bridge 会对 content/hyperlinkParamList/字数统计字段返回
`TEXT_SPECIALIZED_UPDATE_REQUIRED`。几何和默认样式仍可通用更新；正文应使用结构化文本工具并复读核对。

## 故障语义

- 命令仍在队列时超时或 broker 关闭：明确返回未派发，可安全重试。
- MCP 取消通知只跳过尚未开始的工具；请求连接中断或客户端释放时，broker 会移除尚未派发的命令。
- 命令已发送到页面后连接中断、超时或 owner 退出：返回 `OUTCOME_UNKNOWN`，不得自动重放写操作；
  应先读取页面状态再决定是否重试。
- 页面关闭/关闭 AI 控制时，队列命令失败；在途命令同样按结果未知处理。
- stdout 只输出 MCP JSON；运行日志和启动错误只能写 stderr。
