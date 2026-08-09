# 题目数据、诊断与题解

## 标识符

| 标识 | 含义 | 可用于 |
|---|---|---|
| `guid` | 父题或普通题 GUID | 搜索详情、目录添加、题目型模块资源 |
| 子题 `guid` | 某一道真实子题 GUID | 明确以该子题为作答/讲解对象 |
| `resourceMappingId` | 题目与某目录的关系记录 ID | 当前目录题目移除、排序 |
| 讲解记录 `id` | 一条已保存的题目 AI 讲解 ID | type 94 的 `explainIds`/后端 `explain_ids` |

所有 GUID 均作为字符串原样传递，不做数值、大小写或格式转换。展示序号、数组下标、题目数字 ID、目录 ID
都不能代替 GUID。

## 搜索摘要

典型摘要包含：

```json
{
  "guid": "question-guid",
  "title": "纯文本题干摘要",
  "modelId": 5,
  "subModelId": 5,
  "difficulty": null,
  "source": "currentCatalog",
  "sources": [],
  "pathId": 4128,
  "resourceMappingId": 9137,
  "hasAnswer": true,
  "hasSolution": false,
  "hasFormula": false,
  "hasImage": false,
  "children": []
}
```

字段存在性以实时结果为准。`modelId/subModelId` 是题型标识，不是数字模块 `model_id`；
`resourceMappingId` 只在具有目录关系的结果中可用。

## 详情与诊断

`editor_get_questions` 用于读取少量候选的完整父子结构，并尽可能规范化：

- `stemHtml/stemText`、选项和答案；
- 题型、难度、来源、标签和特征；
- 子题及各自 GUID；
- `hasAnswer/hasSolution/hasAnalysis`、`hasFormula/containsFormula`、
  `hasImage/hasImages/containsImage` 等诊断；
- 诊断信封中的 `requestedGuids/uniqueGuids/foundGuids/missingGuids/duplicateGuids`；该工具不返回
  `warnings`。

不要仅因纯文本题干为空就判定题目无内容；图片题和公式题必须结合 HTML、媒体诊断或预览判断。只有排查字段映射时才请求 raw，避免把大段 HTML 和原始对象放入对话。

## 题解

详情接口不保证携带独立题解。需要核对解析、解答步骤或 type 83 可核对性时调用
`editor_get_question_solutions({ guids })`，并按 GUID 对齐结果和 `missingGuids`。题解缺失与请求失败必须区分，不要用空字符串伪装为“无解析”。

## 父题与子题

- 记录 `parentGuid` 与实际选中子题 GUID；禁止根据“第 1 小题”拼 GUID。
- 不要同时选择父题和已被该父题整体包含的子题，除非实时模块语义明确要求。
- 查询单个子题时仍检查返回的父题关系；同名题不能按题干文本去重。
- 已有真实数字模块目标时，`editor_validate_question_selection` 的诊断结果优先于模型凭题干做出的兼容性猜测；纯画布排版没有 `targetModuleType` 时不要为调用该工具虚构类型。
