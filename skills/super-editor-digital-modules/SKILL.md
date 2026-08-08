---
name: super-editor-digital-modules
description: 超媒编辑器（super-editor-control 插件）的元素数字模块技能。用户要求查询、创建、修改、删除或复制绑定在元素上的数字模块，或为按钮、图片、文字等元素配置网页跳转、页面链接、定位、计时器、图文、音频、视频、智能课件、思维导图、AI问、题目练习等点击交互时使用。覆盖 editor_list_digital_module_types、editor_get_digital_module、editor_list_digital_modules、editor_create_digital_module、editor_update_digital_module、editor_delete_digital_module、editor_copy_digital_module；题目型模块配合 super-editor-questions。
---

# Super Editor Digital Modules

为画布元素配置学生端点击后触发的数字模块。始终通过结构化 `editor_*` 工具操作，不打开数字模块配置页模拟点击。

## 按需读取参考资料

- 选择模块类型时读取 [references/module-catalog.md](references/module-catalog.md)。
- 创建或修改前读取 [references/config-schemas.md](references/config-schemas.md)，并以
  `editor_list_digital_module_types` 返回的实时 Schema 为最终依据。
- 删除、覆盖、复制或处理并发冲突前读取
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
6. 根据意图调用创建、修改、删除或复制工具。不同类型替换必须显式授权，不要把创建误当更新。
7. 再次调用 `editor_get_digital_module`，核对 `elementId`、类型、名称、`modelId` 和关键配置。

## 增删改查与复制

| 意图 | 工具 | 规则 |
|---|---|---|
| 查看类型 | `editor_list_digital_module_types` | 优先读取实时 Schema，不硬猜配置字段 |
| 查询单个 | `editor_get_digital_module` | 默认返回规范化结果；仅排障时请求原始数据 |
| 批量查询 | `editor_list_digital_modules` | 用于一个区块、当前页或指定元素集合的盘点 |
| 新增 | `editor_create_digital_module` | 目标已有模块时默认失败；只有明确要求才替换 |
| 修改 | `editor_update_digital_module` | 保持原 `id/model_id`；改类型必须显式 `replaceType: true` |
| 删除 | `editor_delete_digital_module` | 删除前记录当前模块，删除后确认返回空 |
| 复制 | `editor_copy_digital_module` | 当前版本复用同一 `model_id` 建立新关联，不是独立深克隆 |

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
- `OUTCOME_UNKNOWN` 时先重新查询目标元素，禁止直接重放创建、删除、替换或复制。

## 收尾

报告关联到哪个元素、模块类型和名称，以及是否复用了题目或媒体资源。数字模块操作本身不需要调用
`editor_save`；若同一任务还改了画布内容，画布部分仍按总控技能的保存流程收尾。
