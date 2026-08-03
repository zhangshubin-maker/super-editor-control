---
name: super-editor-assets
description: 超媒编辑器（super-editor-control 插件）的用户与设计素材技能。用户要求获取当前登录用户信息、搜索或使用本书样章模板/区块模板、组件库、图片（素材）库，或要求 AI 自主设计并新增目录、从现有素材中选型和应用时使用。覆盖 editor_get_user_info、editor_search_templates、editor_get_template、editor_apply_template、editor_search_components、editor_apply_component、editor_search_images、editor_apply_image。
---

# Super Editor Assets

优先复用本书已有设计语言，再补充系统素材；不要在未检索素材库时直接从空白页重造常见版式。

## 自主新增目录工作流

1. 连接编辑器后，并行读取 `editor_get_state`、`editor_get_user_info` 和样章模板：
   `editor_search_templates({ kind: 'chapter', query })`。
2. 根据用户目标、模板名称与封面筛选少量候选；只对候选调用
   `editor_get_template({ templateId })`，检查区块结构和内容。
3. 有合适样章时调用
   `editor_apply_template({ kind: 'chapter', templateId, name, parentId })` 新增目录。
   没有合适样章时才使用 `addSlide` 创建空白目录。
4. 读取新目录结构，再按需要搜索：
   - 区块：`editor_search_templates({ kind: 'block', query })`
   - 组件：`editor_search_components({ query, scope: 'all', classifyType: 1 })`
   - 图片：先 `editor_search_images({ query, scope: 'book' })`，无结果再查 `global`
5. 应用素材：
   - 区块模板：`editor_apply_template({ kind: 'block', templateId, index })`
   - 组件：`editor_apply_component({ componentId, blockId, left?, top? })`
   - 图片：`editor_apply_image({ imageId, blockId, left?, top?, width?, height? })`
6. 用元素工具替换文案、调整布局；截图核对后 `editor_save`。

## 选择规则

- 优先级：本书样章/区块模板 > 本书图片 > 系统组件 > 总图片库 > 新建基础元素。
- 模板承担整体结构，组件承担局部组合，图片承担视觉内容；不要把整张模板封面当成可编辑页面。
- 搜索词同时尝试主题词、教学环节词和版式词，例如“导入 / 知识点 / 练习 / 总结 / 双栏 / 时间轴”。
- 组件默认搜索 `classifyType: 1`（排版组件）；只有需要数据绑定时使用 `2`。
- `editor_search_components` 默认不返回体积较大的 `content`；通常直接按 id 应用，只有分析原始结构时才传 `includeContent: true`。
- 图片工具中的“图片库”对应编辑器素材库；结果 URL 可直接用于图片元素或背景图。
- 对多个候选先比较元数据和封面，避免一次读取大量模板详情。

## 写入边界

- `kind: 'chapter'` 会调用目录接口并立即写库，整页 checkpoint 不能删除这个新目录；仅在用户要求新增目录或明确授权设计时执行。
- 区块、组件、图片先写当前编辑状态；完成后统一 `editor_save`。
- 大幅应用模板前先 `editor_checkpoint`。若结果不合适，用 `editor_rollback` 回退当前页内容。
- 应用后必须重新读取页面或画布树，确认返回的 `slideId`、`blockId`、`elementIds` 实际存在。

## 工具速查

| MCP 工具 | 用途 |
|---|---|
| `editor_get_user_info` | 获取当前登录用户信息 |
| `editor_search_templates` | 搜索样章/区块模板 |
| `editor_get_template` | 读取模板详情与可解析内容 |
| `editor_apply_template` | 按样章新增目录或插入区块模板 |
| `editor_search_components` | 搜索系统/个人组件库 |
| `editor_apply_component` | 将组件放入指定区块 |
| `editor_search_images` | 搜索本书/总图片素材库 |
| `editor_apply_image` | 新增图片或替换已有图片 |

通用桥接对应方法依次为 `getUserInfo`、`searchTemplates`、`getTemplateDetail`、
`applyTemplate`、`searchComponents`、`applyComponent`、`searchImageLibrary`、
`applyLibraryImage`。
