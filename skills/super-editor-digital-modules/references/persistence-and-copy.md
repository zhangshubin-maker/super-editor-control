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
- `editor_create_digital_module` 在空目标上新增；若已有模块则默认失败，只有用户明确授权
  `replaceExisting: true` 才允许替换。Bridge 复用已有 `id/model_id`，通过一次后端请求提交，不先删除。
- `editor_update_digital_module` 先读取现有关系，再由桥接复用 `id/model_id`。更换 type 必须显式传
  `replaceType: true`，同样通过一次后端请求提交，不先删除。
- 创建或更新现有模块前保存旧模块的规范化数据；不得把类型替换改写成“删除旧关系后再创建”。
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
- 复制只接受未关联模块的目标。目标已有模块时一定拒绝；即使传 `replaceExisting: true` 也不会先删后
  关联，不存在受支持的复制覆盖策略。成熟 UI 也只在目标无模块时提供粘贴。
- 复制后查询目标，确认其 `modelId` 与源模块相同。
- 后续修改共享模块可能影响所有关联元素；在修改前告知用户并盘点相关关系。

当前版本不要虚构 `clone`、`deepCopy` 或“独立副本”模式。

### 用户明确要求替换复制目标

如果目标已有模块，先区分用户想要的是“改变目标自身的类型/配置”，还是“让目标共享源模块的
`model_id`”。前者优先使用 `editor_update_digital_module` 的单请求更新，不需要先删；只有后者才说明
这是人工编排的高风险流程并取得明确意图，然后严格按顺序执行：

1. `editor_get_digital_module` 读取并保存目标旧模块的规范化状态。
2. `editor_delete_digital_module` 显式删除目标旧模块。
3. `editor_copy_digital_module` 把源模块关联到已经为空的目标。

第 2、3 步是两个立即写库且非事务的独立操作，不是复制工具的一次“覆盖”。若删除成功而复制失败，
目标会保持未关联状态；画布 checkpoint/rollback 和 `editor_save` 都不能恢复。出现失败或
`OUTCOME_UNKNOWN` 时先查询实际状态，禁止自动重放删除或复制。不要在没有逐个说明风险和记录结果时，
把该流程隐藏进批量复制。

## 故障处理

- 接口明确失败：修正输入后再试。
- `OUTCOME_UNKNOWN`：先查询源元素和全部目标元素；根据实际关系决定是否继续，禁止自动重放。
- 批量复制部分成功：保留成功清单，只补未关联的目标。
- 删除后查询仍存在：比较 `modelId` 和关系 ID，避免把其他人的新关系误判为删除失败。
