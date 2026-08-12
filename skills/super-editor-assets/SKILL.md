---
name: super-editor-assets
description: 超媒编辑器用户与设计素材技能。用户要求获取当前登录用户、搜索/读取/应用本书或模板中心的样章与区块模板、区分超媒交互型和界面交互型模板、使用组件库与图片素材库、替换单一图片，或为当前页/新目录进行素材选型时使用。按 micro 素材操作、当前页编排和新增目录三种 recipe 限制调用范围。
---

# Super Editor Assets

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。优先复用本书已有设计语言，
再补系统素材；不要在未检查高相关模板时从空白重造常见教学版式。

## Micro：单一素材操作

只调用完成用户意图所需的素材类别，不读取样章或遍历其他库。

- 获取用户：`editor_get_user_info({ refresh? })`。
- 搜索/替换一张图：先 `editor_search_images({ query, scope: 'book' })`，无合适结果才查 global；
  再 `editor_apply_image`。
- 搜索/应用一个组件：`editor_search_components` → `editor_apply_component`。
- 查询一个本书模板：`editor_search_templates({ scope: 'book', ... })` → 只对少量候选调用
  `editor_get_template({ templateId })`。
- 查询模板中心样章：必须使用
  `editor_search_templates({ scope: 'center', kind: 'chapter', interactionType, query? })`；
  `interactionType='hypermedia'` 对应模板中心 `suit_type=1`，`interface` 对应 `suit_type=2`。

应用图片或组件后复读返回的 elementId；影响布局时加载 `super-editor-layout`。当前页 dirty 时按公共策略
调用 `editor_save_verified(scope=current)`，不升级为整页素材规划。

## Current：制作当前页或教学环节

1. 从当前书的现有页和 1–3 个高相关候选中理解设计语言。
2. 默认先搜索 `scope=book, kind=block`；用户明确要求模板中心或本书无候选时，再指定
   `scope=center` 和准确的 `interactionType` 搜索。读取候选详情，检查真实区块、元素类型和可替换内容。
3. 使用 `editor_apply_template({ kind: 'block', templateId, index? })` 插入，记录真实 blockId。
4. 用 `super-editor-page-authoring` 理解槽位并填充内容。
5. 只有区块仍缺独立视觉单元或必要媒体时才搜索组件/图片，不自动遍历全部素材库。

`styleReference` 仅表示已核对的风格参考，不会应用模板或创建区块。

## Chapter：明确新增目录

1. 读取当前书和必要的父目录信息；默认先搜索少量本书 `kind=chapter` 样章候选。用户指定模板中心时，
   使用 `scope=center` 并明确指定 `interactionType=hypermedia/interface`。
2. 调用 `editor_get_template` 核对区块结构和页面设计，不凭封面判断。
3. 用户明确要求新增目录或已授权完整做书时，调用
   `editor_apply_template({ kind: 'chapter', templateId, name, parentId })`。
4. 工具返回后读取新 slideId 和结构，再按 Current recipe 补充缺口。

`kind=chapter` 会立即创建目录并写库，当前页 checkpoint 不能删除它；不能用它覆盖或补写现有目录。
没有合适样章时才考虑空白目录，并遵守立即持久化边界。

## 选择规则

- 优先级：本书成熟结构与样式 > 本书素材 > 合适系统组件/图片 > 新建基础元素。
- 模板中心的 `suit_type=1/2` 是样章适配类型，不是书本的 `smart_book_type=3/4`；工具层只接受
  `interactionType=hypermedia/interface`，禁止直接猜数值或把两套枚举混用。
- 模板承担整体结构，组件承担局部组合，图片承担视觉内容。
- 搜索词组合主题、教学环节和版式，例如“分数 导入 双栏”；不要一次读取大量模板 content。
- 组件默认查排版类；只有任务确有数据绑定需求时再查数据类。
- 先比较元数据和封面，再读取少量详情；应用后必须复读真实 slideId/blockId/elementIds。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `editor_get_user_info` | 当前登录用户与素材权限 |
| `editor_search_templates` / `editor_get_template` | 搜索本书或模板中心并按 id 理解样章/区块模板 |
| `editor_apply_template` | 新增样章目录或插入区块模板 |
| `editor_search_components` / `editor_apply_component` | 搜索并应用组件 |
| `editor_search_images` / `editor_apply_image` | 搜索并应用素材库图片 |

以上均直接调用 MCP 工具；Bridge 方法名只用于实现映射，不作为浏览器脚本示例。
