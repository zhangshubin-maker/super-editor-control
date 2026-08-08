# 题目 AI 讲解工作流

题目 AI 讲解是独立资源。type 94 只引用已经保存的讲解记录 ID，不会因为创建数字模块而自动生成讲解。

## 标识符

- 父题 GUID：组合题整体标识。
- 子题 GUID：某一道真实小题标识。
- 讲解记录 `id`：一条已保存讲解的数字 ID。
- `explainIds` / 后端 `explain_ids`：某个题目或子题选中的讲解记录 ID 列表。

不得把 GUID 放进 `explainIds`，也不得把讲解记录 ID 当作题目 `resource_id`。

## 查询既有讲解

调用 `editor_get_question_explanations`，按题目/子题 GUID 分组读取讲解。选择前核对每条记录的
`questionGuid`、`id`、内容和可用状态；同一题可选择一个或多个真实记录 ID。

## 异步生成

1. 调用 `editor_start_question_explanation_generation` 启动任务并保存返回的任务/题目状态。
2. 结束本次调用；启动工具不得在内部持续长轮询。
3. 稍后调用 `editor_get_question_explanation_status` 查询。状态仍在进行时等待后再查；不要并发重复启动相同题目。
4. 成功后重新调用 `editor_get_question_explanations` 取得最终讲解记录 ID；失败时报告失败题目，不提交错位列表。

状态查询是只读操作。网络超时不等于生成失败；先查现状，禁止盲目重启任务。

## 保存与删除

- 用 `editor_save_question_explanation` 新增或更新讲解；`content` 必须是非空 HTML、Markdown 或纯文本字符串。更新时传真实讲解记录 ID，并在返回后重新查询。
- 用 `editor_delete_question_explanation` 删除真实讲解记录 ID。删除是即时持久化且可能影响已引用它的 type 94 模块，必须显式确认并先盘点引用。
- 讲解内容保留题目公式所需结构；不要把未经处理的 Markdown 当作最终可渲染 HTML。

## 配置 type 94

对每个实际讲解对象构造：

```json
{
  "guid": "question-or-child-guid",
  "explainIds": [12345]
}
```

先用 `editor_validate_question_selection` 核对题目范围，再创建/更新数字模块。写后重新读取模块，逐题核对
GUID 与讲解记录 ID 的对应关系。
