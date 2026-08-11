# Super Editor Control

让 Codex 在普通 Chrome / Edge 浏览器中控制超媒编辑器（`super-editor`）的 Codex 插件。插件同时承担：

- stdio MCP 适配器：向 Codex 提供结构化 `editor_*` 工具。
- 本机浏览器 RPC 中继：在 `127.0.0.1:8765` 维护页面实例、命令队列和结果回传。
- 编辑工作流技能：覆盖整书结构理解与搜索、持久版本、内容审计、书本、模板、素材、题目检索/编排/诊断/目录管理/AI 讲解、数字模块、结构化富文本、页面、区块、元素、大纲、保存和回滚。

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
4. 直接让 Codex 制作或修改课件、搜索并管理题目资源、准备题目 AI 讲解，或为元素配置网页跳转、定位、计时、图文、音视频等数字模块。页面按钮提示“AI 控制已连接”后即可执行。

`editor_status` 是只读检查，不会长期占用页面。`editor_connect` 仅用于主动重新选择页面。

`editor_jump_to_book(target=current)` 在 Bridge v1.9.0 中优先原页面热切书：RPC 的
`instanceId/windowId` 保持不变，MCP 等待目标 `bookId`、`contextEpoch` 和内容状态一致后再返回；
普通目录要求 `contentReady=true`，空书和 PDF 占位目录通过显式状态安全放行。
插件仍兼容 v1.8.2 的完整刷新式 Bridge；刷新兜底会排除旧 `instanceId`，只接回同一 `windowId` 下真正的新实例，不会误连旧页或其他已打开书本。

## 整书创作与调用粒度

整书工具遵循“小改动小调用、大任务大调用”：

- `editor_get_book_manifest` 默认 `scope=current, detail=summary`，只读当前目录轻量摘要；只有明确
  需要整书规划时才传 `scope=book`，只有需要正文/区块等较大数据时才显式传
  `detail=standard/deep`。整书结果通过 `pageNo/pageSize` 分页。
- `editor_search_book_content` 默认只搜索当前目录的普通文本、表格单元格和思维导图节点；跨目录
  搜索必须显式传 `scope=book`。
- `editor_save_verified` 默认保存并回读校验当前目录。`scope=book` 仍只保存当前 dirty 页，再做
  整书摘要校验，不会为一次小改动逐页切换和重写全书。
- `editor_list_book_versions`、`editor_get_book_version` 和 `editor_restore_book_version` 使用后端
  持久版本；整书列表用 `pageNo/pageSize` 分页目录，再用
  `versionPageNo/versionPageSize` 分页每个目录的版本。恢复前优先 `validateOnly=true` 预览影响范围。
- `editor_audit_content` 默认只检查当前目录；整书审计必须显式 `scope=book`，并通过
  `cursor/limit` 分批检查结构、文本、资源和布局。

设计新目录时，先搜索本书样章模板和区块模板，从成熟内容中参考版式、字体、色彩、间距和区块结构，
再填充当前教学内容。不要因为一次文字或元素小修改而先构建整书 manifest。

## MCP 写入边界与高频编辑入口

每个 `tools/list` 工具描述都以前缀标明主要副作用：

- `[只读]` 只读取数据或截图，不改课件内容和编辑器上下文。
- `[工作副本写入|需 saveVerified|可 checkpoint]` 只改当前画布工作副本。大改前可
  `editor_checkpoint`，完成后用 `editor_save_verified(scope=current)` 保存并回读。
- `[立即写库|checkpoint不可恢复]` 会调用后端持久接口，当前页 checkpoint 不能撤销它。
- 连接、导航、会话快照和视图状态虽不写库，但会改变当前任务上下文或内存状态，分别使用
  `[连接状态|不写库]`、`[导航|改变编辑器上下文|不写库]`、`[会话内快照|不写库]`、
  `[仅视图状态|不写库]`，不与纯数据读取混为一谈。
- 模板、切页、上传并放图以及通用 RPC 等混合工具会在标签中直接写明分支语义。

高频操作优先使用 typed 工具：`editor_move/resize/rotate_element`、`editor_move_elements`、
`editor_set_element_spacing`、`editor_center_element_in_block`、`editor_scroll_to_block/element`、
`editor_set_zoom`、`editor_fit_canvas`、`editor_add/delete/move_slide`、
`editor_move/replace/copy_block_to_slide`。`editor_rpc_call` 只用于尚未封装且已经核对 Bridge 签名的
低频方法。

元素 `left/top` 永远是其 owner 区块内的 block-local 坐标，不能把整页 `pageY` 直接传给
`editor_move_element`。跨区块布局先用
`editor_get_elements_bounds({ coordinateSpace: 'page' })` 读取整页包围盒；
`editor_align_elements` 将对齐参照 `target=selection/block/page` 与计算坐标
`coordinateSpace=block/page` 分开表达，Bridge 通过区块 topMap 做 page/local 转换，并在任何元素会越出
owner 区块时零写入拒绝。精确间距和区块坐标 bounds 只接受同一 owner 区块。

`editor_apply_template(kind=chapter)` 新增目录并立即写库；`kind=block` 只写当前页工作副本，完成后
必须使用 `editor_save_verified`，不再引导旧版 `editor_save`。跨页导入会先走带
`saveBeforeSwitch/discardChanges` 的安全切页；跨页复制 dirty 源区块只允许
`saveBeforeSwitch=true`，不会复制未保存内容后再丢弃源页。
所有会离开 dirty 当前页的 typed 工具在 `saveBeforeSwitch=true` 时，都会先通过
`saveVerified(scope=current, verify=true, expectedSlideId)` 保存并回读，再执行具体 Bridge 操作。

`editor_batch` 只是顺序批量调用，不是事务；后一步失败不会自动回滚前面已成功的步骤。写入批次前按需
单独 checkpoint。截图禁止放入 batch 或通用 RPC，必须单独调用 `editor_screenshot`，避免 PNG base64
混入文本结果。`editor_save` 仅保留为 legacy 入口，新流程使用 `editor_save_verified`。

数字模块复制只允许关联到尚无模块的目标元素。`editor_copy_digital_module` 不提供
`replaceExisting`；目标已有模块时会安全拒绝。确需替换时必须显式
`editor_delete_digital_module` 后再 copy，二者都是立即写库且不是原子事务。
`editor_create_digital_module(replaceExisting=true)` 仍是受支持的创建/替换入口，由 Bridge 携带已有关系
标识一次提交，不先删除旧模块。

## 题目能力

- 用 `editor_list_question_paths` 和 `editor_get_question_search_options` 获取真实路径与筛选字典。
- `editor_search_questions` 支持当前目录、当前书资源、学习路径和总题库；`book` 是
  `learningPath` 兼容别名，不提供无界 `all` 搜索。
- 用 `editor_get_questions`、`editor_get_question_solutions` 和
  `editor_validate_question_selection` 核对详情、缺失 GUID、父子题冲突及答题模块兼容性。
- 用 `editor_plan_question_lesson` 根据已选 GUID 形成讲解、练习或测评编排；它只处理明确题目，
  即使 `scope=book` 也不会扫描整本书。
- 用 `editor_render_questions_to_block` 预检并把题目排版到指定区块；默认追加，替换已有内容时
  必须显式 `mode=replace`。需要复用成熟风格时，先应用样章/区块模板，再把生成的区块作为
  `blockId`；`styleReference` 用于记录和核对参考来源，不会自行下载模板。
- 用 `editor_add_questions_to_catalog`、`editor_remove_catalog_question`、
  `editor_move_catalog_question` 管理目录题目。添加使用题目 GUID，移除/排序使用目录关系
  `resourceMappingId`。
- 用 `editor_get_question_explanations`、`editor_start_question_explanation_generation`、
  `editor_get_question_explanation_status`、`editor_save_question_explanation` 和
  `editor_delete_question_explanation` 准备 type 94 所需讲解记录 ID。生成是异步任务，start
  会立即返回，不在一次 MCP 调用中长轮询。

目录题目和讲解写操作立即持久化，不依赖 `editor_save_verified`，也不能由画布快照回滚。题目排版写入画布后
仍需保存当前页，并可在写入前使用 `validateOnly=true`。当前版本不包含完整题目编辑或 OCR/AI 录题。

## 文本能力

Bridge 1.6.0 起，结构化文本能力不只覆盖独立 `text` 元素，也覆盖表格单元格和思维导图节点。内容类工具
统一接受以下目标之一，同时继续兼容原有 `elementId`：

```json
{ "target": { "kind": "element", "elementId": "text-1" } }
{ "target": { "kind": "tableCell", "tableId": "table-1", "cellId": "cell-1" } }
{ "target": { "kind": "tableCell", "tableId": "table-1", "row": 0, "col": 1 } }
{ "target": { "kind": "mindNode", "mindId": "mind-1", "nodeId": "node-1" } }
```

`editor_text_info/document/set_content/set_style/edit/set_link/remove_link/edit_embed/format` 使用上述统一
`target`；`editor_text_adaptive/fit/set_layout/inspect_layout/fit_to_box` 涉及独立文本框几何，只接受
legacy `elementId`。

文本能力不再局限于整段 HTML 替换：

- `editor_text_document` 返回可见 `plainText/displayText`（拼音框展开为 word）、Quill `indexText`、
  `displayIndexMap`、UTF-16 稳定索引、段落、格式 runs、内嵌对象、超链接、默认样式、布局和
  `contentHash/htmlHash/hyperlinkMetadataHash`。`contentHash` 联合覆盖 canonical HTML 与稳定排序后的
  超链接元数据，因此仅链接参数变化也会触发并发保护；另两个 hash 只用于分项诊断。可见文本位置不能
  直接当写入 index，局部编辑前先读取结构范围。
- `editor_text_edit` 用 UTF-16 索引插入、替换、删除，或用 `findReplace` 按文字匹配；省略
  `findReplace` 的 `text/html` 即删除匹配，并保留未修改区域的富文本格式；
  `expectedContentHash` 可阻止正文或链接元数据的并发覆盖，`dryRun` 可先预览命中范围。
- `editor_text_set_content` 只用于明确的整段重写，也支持 `expectedContentHash + dryRun`，避免把并发修改
  或不能安全往返的内嵌结构直接覆盖。
- 正文读取与写入使用生产 Quill/`convertHTML` 做有界稳定化：最多 5 轮，直到相邻两轮 HTML 完全一致，
  且每轮保留安全往返检查；超限会返回 `TEXT_CANONICALIZATION_UNSTABLE`，不会落库。
- `editor_text_set_link` / `editor_text_remove_link` 原子维护文字范围和超链接元数据；
  新链接的 `hyperlink_id` 可省略并由 Bridge 生成，后续以返回的 id 为准；`editor_text_edit_embed`
  原子增删改公式、拼音和内嵌图片。自定义 blot 未注册时会拒绝写入。
- `editor_text_format` 按默认样式、全文、范围、文字匹配或 0-based 段落下标应用字符/段落/列表格式，
  支持 `expectedContentHash + dryRun`；`editor_text_set_layout` 类型安全地修改自适应、内边距、横竖排、
  对齐、背景、描边和阴影，但不接受 hash 或 dry-run 参数。
- `editor_text_set_style` 只接受默认字体、字号、颜色、粗斜体、行距和字距等字段；段落对齐、列表、
  下划线或背景等可见格式使用
  `editor_text_format` 的 `all/range/match/paragraph` scope。
- `editor_text_inspect_layout` 诊断溢出、裁切、尺寸上限和字体；`editor_text_fit` 让文本框适应内容，
  且不改内容、不接受 hash 或 dry-run；`editor_text_fit_to_box` 则保持文本框大小并缩小字号，接受
  `expectedContentHash` 但不接受 `dryRun`。混合或不可解析字号默认零写入，只有用户明确同意后才传
  `allowUniformizeMixedSizes=true` 统一字号。
- `editor_text_search` 默认搜索 `element/tableCell/mindNode` 三类目标，可用 `targetKinds` 缩小范围，并返回区块、目标、片段、可写入的
  `index/length` 及仅供展示的 `displayIndex/displayLength`；
  `editor_text_copy_style` 支持 `sourceTarget/targetTargets`（也可与 legacy source/target 参数混用）复制默认、
  字符或段落样式；`layout/all` 仅支持独立文本元素，嵌套目标会返回
  `TEXT_LAYOUT_TARGET_UNSUPPORTED`。`editor_text_fonts` 列出可用字体。

推荐工作流是 `editor_text_document` → `editor_checkpoint({ label? })` → 局部编辑/格式化 →
`editor_text_inspect_layout` → 截图核对 → `editor_save_verified(scope=current)`。文本写操作仍属于当前页本地状态，保存前可由
`editor_rollback({ checkpointId })` 回滚。通用 `editor_update_element` 会拒绝文本 content、链接元数据和字数统计旁路更新；
位置、尺寸和默认样式等通用字段不受影响。

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

- `.mcp.json`：启动插件自带的 stdio MCP。文件本身保持官方支持的直接 server map；
  `.codex-plugin/plugin.json` 再通过 `mcpServers: "./.mcp.json"` 引用它，不要在文件内重复包
  `mcpServers`。
- `scripts/mcp-server/start.ps1`：Windows 自动定位 Codex 捆绑或系统 Node 运行时。
- `scripts/setup-mcp.sh`：macOS/Linux 探测 Node 并生成本机 MCP 配置。
- `scripts/mcp-server/index.js`：MCP 工具适配器。
- `scripts/mcp-server/bookAuthoring.js`：整书结构、搜索、版本、题目编排和内容审计工具定义与轻重调用约束。
- `scripts/mcp-server/rpc-broker.js`：本机 RPC 中继、选主接管、页面租约和故障语义。
- `skills/`：总控及书本、素材、题目、数字模块、状态、区块、元素、画布、大纲子技能。
- `assets/bridge-api-spec.md`：`window.__superEditor` 桥接契约。
- `assets/production-integration-spec.md`：浏览器与插件本地 RPC 协议及部署要求。

## 开发与验证

```powershell
cd scripts/mcp-server
npm test
```

测试覆盖插件 MCP 配置结构、实际 `tools/list` 的 Codex 扁平 schema 兼容性、高频 typed 工具与运行时参数校验、题目/数字模块工具契约、CORS/LNA 响应头、长轮询、结果幂等、页面租约、客户端中断与 MCP 取消、queued/in-flight 故障语义、串行工具、两个 MCP 进程选主、owner 强制退出后的接管、截断响应和有界关闭。

直接调试可运行 `node scripts/mcp-server/index.js`；需要 mock 时设置
`SUPER_EDITOR_MOCK=1`。默认端口可用 `SUPER_EDITOR_RPC_PORT` 覆盖，但网页端必须通过
`window.__SUPER_EDITOR_RPC_URL` 指向同一端口。

修改插件后按开发流程更新 cachebuster、校验并重新安装。`scripts/setup-mcp.ps1` 仅作为
Windows 旧版手动配置/诊断兜底；`scripts/setup-mcp.sh` 是 macOS 当前的安装步骤。
