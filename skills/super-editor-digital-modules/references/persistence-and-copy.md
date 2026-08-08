# 持久化、并发与复制

## ID 不变量

一个数字模块关系由当前书本、当前目录、目标元素和元素所在后端区块共同定位。桥接负责组装：

- `book_id`：当前书本数据库 ID。
- `catalog_id`：当前目录数据库 ID。
- `control_id`：目标元素 `elementId`。
- `hypermedia_content_id`：元素所在区块对象的数据库 `id`。
- `id`：元素与数字模块的关系 ID，更新时保留。
- `model_id`：数字模块实体 ID，更新和关系复制时保留。

调用方不得传 `hypermedia_content_id`。当前画布工具中的 `blockId`、区块 `uuid` 和元素
`templateId` 都是画布标识，不是后端区块数据库 `id`。

## 创建与更新

- 一个元素最多关联一个数字模块。
- `editor_create_digital_module` 只用于空目标；若已有模块，默认失败。
- `editor_update_digital_module` 先读取现有关系，再由桥接复用 `id/model_id`。
- 不同 type 的替换属于删除旧关系并创建新模块，必须显式请求替换，并在操作前保存旧模块的规范化数据。
- 复杂配置先用 `validateOnly: true` 预检，再执行真实写入。`validateOnly` 与 `mediaPath` 不能同时使用；需要媒体校验时先调用 `editor_upload_file`，再把真实上传结果放进 `config`。

## 删除

删除调用后端数字模块关系接口并立即生效。执行顺序：

1. `editor_get_digital_module` 保存类型、名称、配置和 `modelId`。
2. `editor_delete_digital_module` 删除。
3. 再次查询，确认返回未关联状态。

画布 `checkpoint/rollback` 不能恢复删除；`editor_save` 也不会重新写回数字模块。

## 复制

`editor_copy_digital_module` 与编辑器人工“复制/粘贴数字模块”语义一致：调用
`addcontrolmodelrelation`，让目标元素复用源模块的同一 `model_id`。

- 这是共享关系，不是独立深克隆。
- 每次调用关联一个 `targetElementId`；多个目标可用 `editor_batch` 串行执行，但每个目标都必须真实存在。
- 目标已有模块时默认报错；只在用户明确要求时使用覆盖策略，或按跳过策略保留原模块。
- 复制后查询目标，确认其 `modelId` 与源模块相同。
- 后续修改共享模块可能影响所有关联元素；在修改前告知用户并盘点相关关系。

当前版本不要虚构 `clone`、`deepCopy` 或“独立副本”模式。

## 故障处理

- 接口明确失败：修正输入后再试。
- `OUTCOME_UNKNOWN`：先查询源元素和全部目标元素；根据实际关系决定是否继续，禁止自动重放。
- 批量复制部分成功：保留成功清单，只补未关联的目标。
- 删除后查询仍存在：比较 `modelId` 和关系 ID，避免把其他人的新关系误判为删除失败。
