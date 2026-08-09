# 题目搜索契约

## 范围

`editor_search_questions` 只使用以下 `scope`：

| scope | 含义 | 使用时机 |
|---|---|---|
| `currentCatalog` | 当前编辑目录已关联的题目资源 | 为当前课页选题或管理目录题目 |
| `currentBookResources` | 当前书内容资源容器中的题目 | 查找已进入本书、但不一定属于当前目录的题 |
| `learningPath` | 当前书学习路径节点下的题目 | 按章、节或学习路径找本书题 |
| `book` | `learningPath` 的兼容别名 | 兼容旧调用；新调用优先用 `learningPath` |
| `global` | 总题库 | 明确要求全库，或本书范围无合适结果时 |

不存在 `all` 范围。需要逐步扩大范围时依次调用，保留每条结果的来源，不要一次无界合并全库。

## 路径与筛选字典

- 用 `editor_list_question_paths({ bookId? })` 取得真实学习路径树/扁平节点及 `pathId`。树可能多层嵌套，禁止只取根节点或凭目录名猜 ID。
- 用 `editor_get_question_search_options` 取得实时可用的学段、学科、年级、册别、难度、题型、题目特征、来源与“有答案/解析”等筛选值。
- 以 MCP 工具的实时 JSON Schema 和搜索字典为最终字段约束。筛选使用语义化 camelCase 参数；不要透传未知蛇形后端字段，也不要让筛选对象覆盖 query 或分页。

## 搜索策略

1. 当前课页配题从 `currentCatalog` 开始；本书已有资源用 `currentBookResources`；按目录找题用
   `learningPath + pathId`；最后才扩大到 `global`。
2. 关键词来自题干、知识点或用户目标。先用较小 `pageSize` 比较摘要，再决定翻页或放宽条件。
3. `learningPath` 未指定 `pathId` 时注意返回的路径覆盖信息；若响应标记 `isPartial`、`truncatedPaths` 或包含警告，不能把空结果解释为整本书无题。
4. 多次结果按完整 GUID 去重；同一 GUID 优先保留更靠近当前目录/当前书的上下文。
5. 搜索摘要只用于召回。答案、题解、父子结构和模块兼容性必须通过详情、题解和选题校验工具确认。

## 常用参数

- `query`：题干、知识点、来源或 GUID 关键词。
- `bookId`、`catalogId`：通常由 Bridge 从当前页面补齐；仅查询其他明确上下文时覆盖。
- `pathId`：来自 `editor_list_question_paths`。
- `quesScope`：学习路径题目范围；`1` 常规题，`2` 定制题。
- `pageNo` 是从 0 开始的整数；`pageSize` 范围 1..100，默认 20，先用小页比较候选再按响应分页继续。
- 高级筛选包括 `period/subjectId/gradeId/volume/difficulty/features/guidList`、
  `haveResolution/haveReview/haveSolution/haveSolutionVideo`、`subModelIds/searchAreaTypes`、
  `sourceInfos/businessTypes/haveTag/tagNodeIds`；值必须来自
  `editor_get_question_search_options`。
- 高级筛选主要由总题库接口执行；当前目录、当前书资源和学习路径以自身接口可用字段为准。工具未声明已应用的条件，不得假定生效。
- 兼容旧调用的 `filters` 也只接受上述白名单，且不能覆盖 query 或分页；新调用优先使用显式顶层字段。

## 响应完整性

- 读取 `scope`、分页、`total`、`isPartial`、路径覆盖和 warnings；不同 scope 的 total 含义可能不同。
- 对本地过滤或局部路径结果，不得宣称搜索穷尽。
- 搜索项至少保留 GUID、题干摘要、题型、难度、父子题信息和来源上下文；详细形状见
  [question-shapes.md](question-shapes.md)。
