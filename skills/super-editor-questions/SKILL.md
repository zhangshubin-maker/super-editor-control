---
name: super-editor-questions
description: 超媒编辑器（super-editor-control 插件）的题目检索、诊断、选题、课件排版、目录题目管理与题目 AI 讲解技能。用户要求按 currentCatalog/currentBookResources/learningPath/global 范围分页搜题，读取题目与题解，把 1..50 个 GUID 规划为课件并按每批最多 30 题渲染到真实区块，校验题目型数字模块，管理目录题目，或生成和维护题目 AI 讲解时使用。区分纯画布排版与需要 targetModuleType 的数字模块校验。
---

# Super Editor Questions

从编辑器真实题目资源中完成“找题 → 核对 → 选题 → 计划/排版 → 可选写入目录或配置交互”的闭环。

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。画布题目渲染与目录题目关系属于
不同持久化域：前者保存当前页，后者立即写后端且不能由页面 rollback 撤销。

## 按需读取参考资料

- 选择题目范围、路径和筛选项前读取 [references/search-contracts.md](references/search-contracts.md)。
- 核对父子题、详情诊断、题解与标识符时读取 [references/question-shapes.md](references/question-shapes.md)。
- 为题目型数字模块选题时读取 [references/selection-rules.md](references/selection-rules.md)。
- 向目录添加、移除或排序题目时读取 [references/catalog-workflows.md](references/catalog-workflows.md)。
- 配置 type 94 或维护题目 AI 讲解时读取
  [references/explanation-workflows.md](references/explanation-workflows.md)。

## 标准工作流

1. 需要目录定位时先调用 `editor_list_question_paths`；需要合法筛选值时调用
   `editor_get_question_search_options`，不要猜路径 ID、题型 ID 或筛选枚举。
2. 用 `editor_search_questions` 从最窄范围开始召回候选，使用真实 `pageNo >= 0`、`pageSize: 1..100` 小页翻页；不要空条件遍历总题库。`book` 只是 learningPath 的兼容别名，不是整书扫描开关。
3. 对少量候选调用 `editor_get_questions({ guids, includeDiagnostics: true })`，核对父题、子题、内容诊断及缺失 GUID；需要独立题解时再调用 `editor_get_question_solutions`。
4. 纯画布排版根据详情诊断、父子关系和渲染预检核对题目；只有用户要创建/更新题目型数字模块且已知真实 `targetModuleType` 时，才调用 `editor_validate_question_selection`。不要为排版任务猜模块类型。
5. 用户要求把题目排版进当前课页时加载 `super-editor-page-authoring`；多个目录才加载
   `super-editor-book-authoring`。每个 `editor_plan_question_lesson` 传 1..50 个 GUID；简单题组用
   summary，复杂题组才用 deep；讲解与练习需要不同 layout 时分别规划。
6. 需要模板结构时先读取候选详情并实际应用 `kind=block` 区块模板，以返回的真实 `blockId` 承载题目。`styleReference` 只记录参考，不会应用模板；`kind=chapter` 会新增目录并立即写库，不能用来补现有课页。
7. `editor_render_questions_to_block` 每批最多 30 题，超过时按区块拆分。每批先传 `validateOnly=true` 核对目标区块、slideId、expectedSlideId 和计划，再正式渲染；默认 append，replace 需明确授权。
8. 渲染后读取元素映射，检查公式、题图、选项、作答空间和答案/解析策略；用 `editor_save_verified(scope=current)` 保存当前页，不使用 book 保存代替逐页保存。
9. 用户要求把题变成本目录资源时，先读当前目录映射，再使用目录题目工具；写后重新读取验证。
10. type 94 先查询或异步生成讲解，取得真实讲解记录 ID 后再加载 `super-editor-digital-modules` 配置；其他纯排版任务不加载数字模块技能。

当前工具能召回、读取和校验题目结构，但没有自动证明知识覆盖、难度梯度、预计用时、教学适配度或
语义近重复的评分器。AI 的选编必须基于题目详情和用户目标做显式判断，报告所用筛选条件和仍属启发式
判断的部分，不把搜索排序当成教学质量评分。

## 不变量

- 题目 GUID、子题 GUID、目录资源映射 `resourceMappingId`、题目讲解记录 ID 是不同标识，不得混用。
- 目录添加使用题目 GUID；目录移除和排序使用真实 `resourceMappingId`，不能传 GUID 代替。
- 目录题目添加、移除、排序和讲解保存/删除均直接写后端，不依赖 `editor_save`，也不能由画布
  `checkpoint/rollback` 撤销。
- type 82 中 `timeMode=0` 是正计时，`timeMode=1` 是倒计时；倒计时必须提供
  `timeLimit`。测评/竞速模式 `questionMode=2` 不允许正计时；提交前必须通过选题校验。
- 题目 AI 讲解采用“启动生成 → 查询状态 → 获取结果”的异步流程；启动工具不在内部长轮询。
- 题目排版要求存在 PC 题目组件和数据模型；缺失时停止写入并报告诊断，不生成半成品。
- `scope=book` 的题目计划只表示显式 GUID 的整书编排意图，不自动扫描整本书。需要整书上下文时由
  `super-editor-book-authoring` 单独读取 manifest；当前页编排由 `super-editor-page-authoring` 收尾。
- plan 最多接受 50 个 GUID，render 无论直接传 GUID 还是传 plan 都单批最多 30 题；不要把成功规划误报为已全部渲染。
- `styleReference` 不会应用任何模板；只有成功应用的区块模板返回的真实 `blockId` 才是可写目标。
- 当前能力仍不涵盖完整题目编辑、OCR/AI 录题。加入目录资源与插入课页是两个独立写操作，不得混称。

## 收尾

说明搜索范围、路径、选中题数、缺失或不兼容项，以及最终使用的少量 GUID。发生画布渲染时报告目标目录/区块、布局模式、元素映射和保存结果；发生目录或讲解写入时报告 `resourceMappingId`/讲解记录 ID 和即时持久化结果。不要批量输出原始题目 HTML、答案或解析。
