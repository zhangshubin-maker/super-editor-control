---
name: super-editor-digital-modules
description: 超媒编辑器（super-editor-control 插件）的元素数字模块技能。用户要求查询、创建、修改、删除或复制绑定在元素上的数字模块，或为按钮、图片、文字等元素配置网页跳转、页面链接、定位、计时器、图文、音频、视频、智能课件、思维导图、AI问、题目练习等点击交互时使用。覆盖 editor_list_digital_module_types、editor_get_digital_module、editor_list_digital_modules、editor_create_digital_module、editor_update_digital_module、editor_delete_digital_module、editor_copy_digital_module；题目型模块配合 super-editor-questions。
---

# Super Editor Digital Modules

为画布元素配置学生端点击后触发的数字模块。始终通过结构化 `editor_*` 工具操作，不打开数字模块配置页模拟点击。

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。数字模块属于立即持久化域；
页面 checkpoint、rollback 和保存都不能恢复它。

## 按需读取参考资料

- 选择模块类型时读取 [references/module-catalog.md](references/module-catalog.md)。
- 创建或修改前读取 [references/config-schemas.md](references/config-schemas.md)，并以
  `editor_list_digital_module_types` 返回的实时 Schema 为最终依据。
- 删除、替换、复制或处理并发冲突前读取
  [references/persistence-and-copy.md](references/persistence-and-copy.md)。
- 配置音频、视频、智能课件等资源型模块时读取
  [references/media-workflows.md](references/media-workflows.md)。
- 配置在线答题、核对答案、逻辑组件或题目 AI 讲解时，同时加载
  `super-editor-questions`；需要完整目录管理或讲解生成契约时按其 SKILL 路由读取 references。

## 标准工作流

1. 用 `editor_get_element` 核对目标元素；未指定元素时读取当前选择，不凭名称猜测重名元素。
2. 调用 `editor_get_digital_module({ elementId })` 读取当前关联。批量盘点时使用
   `editor_list_digital_modules`。
3. 调用 `editor_list_digital_module_types` 确认类型是否受支持、配置字段和外部依赖。
4. 准备依赖：题目先读取详情并调用 `editor_validate_question_selection`；type 94 先取得真实讲解记录 ID；本地媒体先上传；素材库资源直接复用其文件信息。
5. 生成能说明点击结果的名称，例如“打开古诗赏析”“播放课文朗读”“5 分钟倒计时”。省略名称时让桥接按数字模块类型名称兜底。
6. 根据意图调用创建、修改、删除或复制工具。创建/更新时更换现有模块类型必须显式授权，并由 Bridge
   复用现有 `id/model_id` 单请求提交，不要先删除。复制只接受空目标；目标已有模块时不得把
   `replaceExisting` 当作覆盖能力。
7. 再次调用 `editor_get_digital_module`，核对 `elementId`、类型、名称、`modelId` 和关键配置。

上述回读只能证明配置和绑定已持久化。当前没有通用的学生端交互执行/冒烟测试工具；网页跳转、媒体
播放、题目交互和 AI 讲解的重要链路仍需学生端或预览页面验证，交付时不得表述为已自动运行成功。

## 增删改查与复制

| 意图 | 工具 | 规则 |
|---|---|---|
| 查看类型 | `editor_list_digital_module_types` | 优先读取实时 Schema，不硬猜配置字段 |
| 查询单个 | `editor_get_digital_module` | 默认返回规范化结果；仅排障时请求原始数据 |
| 批量查询 | `editor_list_digital_modules` | 用于一个区块、当前页或指定元素集合的盘点 |
| 新增 | `editor_create_digital_module` | 空目标直接新增；已有模块时只有明确授权 `replaceExisting: true` 才复用原 `id/model_id` 单请求替换，不先删除 |
| 修改 | `editor_update_digital_module` | 保持原 `id/model_id`；改类型必须显式 `replaceType: true`，仍是单请求替换 |
| 删除 | `editor_delete_digital_module` | 删除前记录当前模块，删除后确认返回空 |
| 复制 | `editor_copy_digital_module` | 只关联到空目标并复用同一 `model_id`；目标已有模块时即使传 `replaceExisting: true` 也拒绝，不支持覆盖策略 |

## 不变量与安全边界

- 一个元素最多关联一个数字模块。目标已有模块时先读后决策，禁止静默覆盖。
- 调用方只传 `elementId`。桥接必须从元素所属区块对象读取数据库 `id` 作为
  `hypermedia_content_id`；画布区块 `uuid`、元素 `templateId` 都不能替代它。
- type 82 的测评模式 `questionMode=2` 不允许 `timeMode=0`；type 94 的题目/子题 GUID 与讲解记录 ID 必须分别核对，不能互换。
- 创建和修改由桥接维护后端关系 `id`、`model_id`、当前 `book_id` 和 `catalog_id`；不要让模型拼装
  `add_model_req_en` 或 `add_model_content_req_en`。
- 数字模块写操作调用后端后立即持久化，不依赖 `editor_save`；画布 checkpoint/rollback 不能撤销。
  删除、替换前必须先查询并保留可恢复信息。
- 复制与人工界面的“粘贴数字模块”一致：源元素与目标元素共享一个 `model_id`。后续修改共享模型可能影响所有关联，执行前说明这一点。
- 复制目标已有模块时没有原子覆盖契约。若只需改变目标自身的类型或配置，优先使用
  `editor_update_digital_module` 单请求更新；只有用户明确要求目标共享源模块的 `model_id` 时，才先说明
  风险并取得明确意图，再按“读取旧状态 → 显式删除 → 复制”执行。删除和复制是两个立即写库、非事务的独立步骤；
  复制失败时目标可能保持空状态，checkpoint/rollback 不能恢复。不要把这条人工流程包装成复制工具的
  “覆盖策略”。
- 创建或更新时的类型替换不走上述删除流程：Bridge 使用现有 `id/model_id` 单请求提交。
- `OUTCOME_UNKNOWN` 时先重新查询目标元素，禁止直接重放创建、删除、替换或复制。

## 收尾

报告关联到哪个元素、模块类型和名称，以及是否复用了题目或媒体资源。数字模块操作本身不需要保存
当前页；若同一任务还改了画布内容，画布部分仍按公共策略调用 `editor_save_verified(scope=current)`。
