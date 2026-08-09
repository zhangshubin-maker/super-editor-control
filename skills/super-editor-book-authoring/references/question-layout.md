# 题库题目课件编排

## 选题原则

- 先确定学习目标，再按题型、难度和知识点取题。
- `editor_search_questions` 使用 `pageNo >= 0`、`pageSize: 1..100` 真实分页，从 currentCatalog/currentBookResources/learningPath 等最窄范围开始；不要空条件遍历 global。
- 父题与其子题不能重复选择；复合题默认保留父题结构。
- 同一练习区避免重复 GUID；记录题目来源和 GUID。
- 讲解型内容优先选择有答案和解析的题目；AI 讲解数字模块还必须存在有效讲解记录。
- `editor_validate_question_selection` 需要真实 `targetModuleType`，只用于明确的数字模块目标。纯画布排版根据详情诊断、父子关系和计划预检核对，不猜模块类型。

## 布局模式

### practice

- 题干与作答区优先，答案/解析默认不直接展示。
- 选择题保持选项顺序；主观题预留书写空间。
- 多题时保持题号、间距和视觉层级一致。

### explain

- 题干、关键条件、解题步骤、答案/解析形成清晰层级。
- 公式和题图不得转成不可靠的纯文本。
- 可把答案/解析放入后续区块或数字模块，避免首屏信息过载。

### assessment

- 题目密度可提高，但仍保留清晰题号和作答空间。
- 答案与解析默认隐藏或放在独立反馈环节。
- 检查难度梯度和题型覆盖，不把搜索结果顺序直接当教学顺序。

### auto

根据目标和题目形态选择上述模式；计划结果必须说明选择原因。

## 模板复用

- `styleReference.templateId` 只记录整页教学结构参考；不会应用样章。
- `styleReference.blockTemplateIds` 只记录题干、讲解、练习等局部区块参考；不会应用区块模板。
- 参考模板前先读取详情，确认真实槽位与元素类型。
- 向现有目录排版时，先用 `editor_apply_template({ kind: 'block', ... })` 实际插入区块模板，再把返回的 `blockId` 交给渲染工具。
- `editor_apply_template({ kind: 'chapter' })` 会新增目录并立即写库，只在用户明确要求新建目录时使用；不能用它改造现有目录。
- 模板不适配题目数量或题型时，保留成熟的标题、题号和间距规则，调整内容承载结构。

## 执行顺序

1. 搜索并读取题目详情。
2. 校验题目选择。
3. 每个 plan 传 1..50 个 GUID；讲解和练习使用不同 layout 时分别规划。复杂题组才用 deep。
4. 每个渲染批次最多 30 题；超过 30 题按目标区块拆分。
5. 对真实 `blockId` 先用 `validateOnly=true` 校验目标页、区块和 `expectedSlideId`。
6. 正式渲染并读取结果元素映射；默认 append，replace 需明确授权。
7. 检查公式、图片、富文本、答案策略和布局，随后 saveVerified current。
8. 需要交互时再绑定数字模块。
