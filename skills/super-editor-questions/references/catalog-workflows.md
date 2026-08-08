# 目录题目管理

目录题目是题目 GUID 与书本目录之间的关系记录。添加、移除和排序均直接请求后端并立即持久化，不进入画布 JSON、`editor_save` 或 `checkpoint/rollback`。

## 添加

1. 用 `editor_get_questions`/`editor_validate_question_selection` 确认 GUID 有效。
2. 用 `editor_search_questions({ scope: "currentCatalog" })` 读取当前关系并按 GUID 去重。
3. 先调用 `editor_add_questions_to_catalog({ ..., validateOnly: true })` 核对可添加、已存在和缺失 GUID；确认后去掉 `validateOnly` 执行。
4. `catalogId` 省略时使用当前目录。写后重新读取 `currentCatalog`，记录新增题目的 `resourceMappingId`。

添加使用题目 GUID。它只建立目录资源关系，不创建新题，也不会把题目排版元素插入画布区块。

## 移除

1. 从 `currentCatalog` 结果取得目标关系的真实 `resourceMappingId`，同时记录 GUID 和题干用于核对。
2. 调用 `editor_remove_catalog_question({ resourceMappingId })`。
3. 重新读取当前目录，确认该映射已不存在。

不得向移除工具传题目 GUID、题目数字 ID 或目录 ID 冒充映射 ID。移除关系不等同于删除总题库中的题目。

## 排序

1. 读取当前目录完整映射顺序。
2. 用目标题目的 `resourceMappingId` 调用 `editor_move_catalog_question`，按实时 Schema 指定目标位置。
3. 重新读取并核对全部映射顺序，避免只凭调用成功判断。

排序使用关系 ID，不使用 GUID。数组展示序号和后端 sort 起点可能不同，始终以工具 Schema 与写后结果为准。

## 故障与安全

- 删除和排序前必须先读；`OUTCOME_UNKNOWN` 时只重读，禁止直接重放。
- 写操作无法由画布回滚恢复。需要恢复时依据写前记录重新添加或移动。
- 当前能力不涵盖题目本体删除、完整题目编辑、OCR/AI 录题或把题目插入画布区块。
