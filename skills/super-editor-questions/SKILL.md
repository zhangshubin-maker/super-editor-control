---
name: super-editor-questions
description: 超媒编辑器（super-editor-control 插件）的题目检索、诊断、选题、目录题目管理与题目 AI 讲解技能。用户要求浏览题目路径和筛选字典，搜索当前目录、当前书资源、学习路径或总题库，读取题目/子题/题解，校验题目型数字模块选题，向目录添加、移除或排序题目，或获取、生成、保存、删除题目 AI 讲解时使用。覆盖 editor_list_question_paths、editor_get_question_search_options、editor_search_questions、editor_get_questions、editor_validate_question_selection、editor_get_question_solutions、editor_add_questions_to_catalog、editor_remove_catalog_question、editor_move_catalog_question、editor_get_question_explanations、editor_start_question_explanation_generation、editor_get_question_explanation_status、editor_save_question_explanation、editor_delete_question_explanation。
---

# Super Editor Questions

从编辑器真实题目资源中完成“找题 → 核对 → 选题 → 可选写入目录/准备讲解 → 配置数字模块”的闭环。

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
2. 用 `editor_search_questions` 从最窄范围开始召回候选，先取小页；不要空条件遍历总题库。
3. 对少量候选调用 `editor_get_questions({ guids, includeDiagnostics: true })`，核对父题、子题、内容诊断及缺失 GUID；需要独立题解时再调用 `editor_get_question_solutions`。
4. 调用 `editor_validate_question_selection`，按目标数字模块类型检查题数、父子题冲突、答案/题解和配置约束。
5. 用户要求把题变成本目录资源时，先读当前目录映射，再使用目录题目工具；写后重新读取验证。
6. type 94 先查询或异步生成讲解，取得真实讲解记录 ID 后再配置数字模块。
7. 加载 `super-editor-digital-modules`，把验证通过的 GUID 和必要资源交给对应模块；创建后重新读取模块核对。

## 不变量

- 题目 GUID、子题 GUID、目录资源映射 `resourceMappingId`、题目讲解记录 ID 是不同标识，不得混用。
- 目录添加使用题目 GUID；目录移除和排序使用真实 `resourceMappingId`，不能传 GUID 代替。
- 目录题目添加、移除、排序和讲解保存/删除均直接写后端，不依赖 `editor_save`，也不能由画布
  `checkpoint/rollback` 撤销。
- type 82 中 `timeMode=0` 是正计时，`timeMode=1` 是倒计时；倒计时必须提供
  `timeLimit`。测评/竞速模式 `questionMode=2` 不允许正计时；提交前必须通过选题校验。
- 题目 AI 讲解采用“启动生成 → 查询状态 → 获取结果”的异步流程；启动工具不在内部长轮询。
- 当前能力不涵盖完整题目编辑、OCR/AI 录题，也不把题目排版插入画布区块。不要把“加入目录资源”描述为“已插入课页”。

## 收尾

说明搜索范围、路径、选中题数、缺失或不兼容项，以及最终使用的少量 GUID。发生目录或讲解写入时，报告
`resourceMappingId`/讲解记录 ID 和即时持久化结果；不要批量输出原始题目 HTML、答案或解析。
