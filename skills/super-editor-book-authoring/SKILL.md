---
name: super-editor-book-authoring
description: 超媒编辑器整书课件创作与跨目录编排技能。用户要求从零创建或扩充一本书、批量制作多个目录、统一整书内容与风格、只读参考样章并实际复用区块模板，或从题库选题并排版为讲解、练习、测评课件时使用。按 micro/current/book 规模限制读取、写入、保存和审计范围，覆盖 editor_get_book_manifest、editor_search_book_content、editor_plan_question_lesson、editor_render_questions_to_block，并编排素材、题目、目录、区块、文本和质量子技能。
---
# Super Editor 整书创作

把 AI 的教学设计转换为可保存、可验证的整书课件。先判断任务规模；不要让一个局部修改承担整书扫描成本。

## 1. 按 micro / current / book 路由

| 任务 | 默认读取 | 执行方式 | 收尾 |
|---|---|---|---|
| **micro**：一个明确元素/文本 target/样式 | 只读该目标 | 用对应元素、文本或数字模块工具修改并复读 | `editor_save_verified(scope=current)`；不做目录或整书审计 |
| **current**：一个区块或当前目录 | `editor_get_book_manifest(scope=current, detail=standard)` | 结构写入前建立当前页 checkpoint，按需加载区块/文本/素材工具 | current 审计相关 checks，再 `editor_save_verified(scope=current)` |
| **book**：多个目录或整书 | `editor_get_book_manifest(scope=book, detail=summary, pageNo, pageSize)` | 先列目标目录和复用规则，再逐页 checkpoint、执行、核对、保存 | 每页 current 审计与保存；明确整书交付时再分页 book 审计 |

仅当用户明确要求整书、多目录、统一风格或完整做书时使用 `scope=book`。manifest 与整书内容搜索都用 `pageNo >= 0`、`pageSize: 1..200` 分页；搜索还要求非空 query，且每批 `limit: 1..500`。不要传审计工具的 cursor，也不要把单批 limit 当成完整全书结果。仅当确实需要元素级证据时使用 `detail=deep`。详细准则见 [scale-routing.md](references/scale-routing.md)。

保存时优先传 `expectedSlideId`。仅在刚从当前页 manifest/页面清单取得**页级** `contentHash` 时才把它传给 `editor_save_verified.expectedContentHash`；文本 target 的 `contentHash` 和审计问题的 `sourceHash` 都不是页级保存 hash。

## 2. 模板与素材复用

1. book 任务先读分页摘要，确认目标目录、页面规格和已有风格；不要把父目录、空容器或附录自动当成要制作的章节。
2. 加载 `super-editor-assets`，先用小页搜索少量高相关样章和区块模板，再读取候选详情核对真实区块、槽位和元素类型。
3. 样章模板用于**只读参考**整页结构和设计规则。`editor_apply_template({ kind: 'chapter' })` 会新增目录并立即写库；只有用户明确要求新建目录时才调用，不能用它覆盖或补写现有目录。
4. 现有目录的讲解、练习等环节使用 `editor_apply_template({ kind: 'block', ... })` 实际插入区块模板，并以返回的真实 `blockId` 继续写入和渲染。
5. `styleReference` 只把已核对模板记录为规划参考，**不会应用模板或创建目标区块**。正式渲染前必须已有真实 `blockId`；需要模板结构时先应用区块模板。
6. 只有区块模板仍缺少独立视觉单元或必要媒体时才搜索组件/图片；不要因 book 任务自动遍历组件库和图片库。图片只从素材库或已上传资源中选取。
7. 不机械套用模板。按教学目标删减“导入/目标—讲解—示例—互动—练习—总结”，每完成一个目录立即核对并保存。

## 3. 整书内容一致性

- 只有任务确实涉及术语、知识点、占位文本或重复段落时才调用 `editor_search_book_content`；默认 current，明确跨目录时才 book。整书搜索按 `pageNo/pageSize` 读取目录批次，并根据 `pagination.hasMore/nextPageNo` 续页；每批命中仍受 limit 限制。
- 从代表性样章提取标题层级、正文字号、配色、间距和区块密度，作为后续目录的参考，不逐页重新发明风格。
- 保留目录间必要的教学递进；不要仅因为文字相似就删除例题、回顾或巩固环节。
- 使用题目 GUID、模板 ID、区块 UUID 记录来源，使后续可追溯。

## 4. 题库到课件

加载 `super-editor-questions` 搜题和读取详情，再按以下顺序执行：

1. 从最窄题库 scope 搜索，使用真实 `pageNo >= 0`、`pageSize: 1..100` 分页；读取少量候选详情并检查缺失、重复和父子题冲突。只有已知真实数字模块类型时才调用 `editor_validate_question_selection`，不要为纯画布排版猜 `targetModuleType`。
2. `editor_plan_question_lesson` 每次接受 1..50 个 GUID；简单选题用 `detail=summary`，复杂题组才用 deep。讲解与练习需要不同布局时分别生成 `layout=explain` 与 `layout=practice` 的计划。
3. 需要参考风格时传入已核对的 `styleReference`，但它不会自动应用模板；先应用区块模板并取得真实 `blockId`。
4. `editor_render_questions_to_block` 单批最多 30 题；超过 30 题按目标区块拆分。每批先用 `validateOnly=true` 核对 `blockId`、`slideId`、`expectedSlideId` 和计划，再以相同目标正式渲染；默认使用 append，replace 需明确授权。
5. 渲染后读取元素映射，检查题干、选项、公式、图片、答案/解析显示策略和布局，再保存当前页。
6. 需要点击答题、核对答案或 AI 讲解时，再加载 `super-editor-digital-modules` 绑定交互。

完整选题与版式准则见 [question-layout.md](references/question-layout.md)。

## 5. 执行纪律

- 小改动直接读写明确目标，不先生成整书清单、搜索全部模板或进行全局风格推演。
- 大改动先做 summary 清单和素材选型；只有命中疑点的目录再 deep 读取。
- 跨页前若有 dirty 状态，先调用 `editor_save_verified(scope=current)`；只有用户明确要求放弃改动时才走受支持的丢弃流程。随后再调用 `editor_select_slide`，不要假设 MCP 的切页调用会自动保存。
- 批量调用只合并同一意图、可顺序验证的步骤。跨目录操作按页保存，失败后能从最近页面继续。
- 新增内容完成后加载 `super-editor-quality` 做对应范围的审计；不要用整书审计替代局部核对。
- `editor_save_verified(scope=book)` 仍只保存当前 dirty 页，不会逐页保存整书，但会分页校验完整整书摘要；只在明确的整书收尾使用。book 任务过程必须逐页调用 current 保存。
