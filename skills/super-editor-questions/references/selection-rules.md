# 题目型数字模块选题规则

先读取详情和必要题解，再调用：

```json
{
  "guids": ["question-guid"],
  "targetModuleType": 82,
  "config": {}
}
```

以 `editor_validate_question_selection` 的实时 Schema 和返回诊断为准。存在 `missingGuids`、父子题冲突、缺少目标模块所需的答案/题解资源或配置冲突时先修正，不把无效 GUID 交给数字模块。

## 在线答题（type 82）

- 至少一题；保留用户指定顺序，随机展示通过模块规则声明，不预先打乱 GUID。
- 明确 `questionMode`、`timeMode`、时限和计时器显示规则；`timeMode=0` 是正计时，
  `timeMode=1` 是倒计时。
- 倒计时 `timeMode=1` 必须提供 `timeLimit`。测评/竞速模式 `questionMode=2` 不允许正计时
  `timeMode=0`。不要依赖后端报错才发现这些冲突。
- 组合题按模块实际支持范围选择父题或子题，避免父子重复。

## 核对答案（type 83）

- 至少一题；实现的兼容条件是题目存在答案或独立题解（`hasAnswer || hasSolution`）。
- 题目顺序默认与页面展示顺序一致，只有明确要求才启用随机规则。
- 同时缺少答案和独立题解的题目不能加入；有独立题解但无内嵌答案时可以通过校验。

## 逻辑组件（type 93）

- 只传一个实际判断对象的 GUID。
- 普通题使用父题 GUID；组合题必须明确判断整题还是某一个子题。
- 多候选时不得擅自取第一题、最后一题或第一道子题。

## 题目 AI 讲解（type 94）

- 先核对题目/子题范围，再按 [explanation-workflows.md](explanation-workflows.md) 查询或生成讲解。
- `questions[{ guid, explainIds }]` 中 `guid` 是实际讲解对象的题目或子题 GUID；`explainIds` 是该对象已保存讲解记录的数字 ID 列表。
- 逐题保持 GUID 与讲解记录一一对应；部分生成失败时不得把其他题的讲解 ID 补到该题。

## 去重、顺序与验证

1. 按完整 GUID 去重并保留用户点名顺序。
2. 检查父子题冲突和缺失 GUID。
3. 调用 `editor_validate_question_selection`；不要只依赖搜索摘要。
4. 创建数字模块后调用 `editor_get_digital_module`，逐项核对实际 `resource_id` 和顺序。

若当前目录无合适题，依次扩大到当前书资源、学习路径、总题库，并说明最终来源。扩大搜索范围不会自动把题加入当前目录；需要目录资源时显式执行目录题目工作流。
