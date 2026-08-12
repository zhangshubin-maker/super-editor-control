---
name: super-editor-control
description: 超媒内容编辑器总控技能。用户要求 AI 编写或修改课件、制作当前课页或整书、调整布局、编辑富文本、复用模板与素材、管理书本和大纲、题库选题、配置数字模块或验收内容时使用。负责按 micro/current/book 和风险级别路由到页面创作、布局、状态、素材、书本、整书、质量、文本、题目、数字模块、区块、元素、画布和大纲子技能。
---

# Super Editor Control

所有子技能共同遵守[任务规模、持久化与验证策略](references/task-policy.md)。它是跨技能规则的唯一来源；
发生冲突时，用户当前要求优先，其次是公共策略，再其次是领域技能和示例。

## 子技能地图

| 子技能 | 何时加载 |
|---|---|
| `super-editor-state` | 目标或当前页状态不明确，需要最小范围读取、搜索或理解层级 |
| `super-editor-page-authoring` | 制作、扩充或重写一个当前课页/目录；完整编排教学环节 |
| `super-editor-layout` | 移动、缩放、对齐、重排、修复裁切/越界/遮挡及内容变化后的视觉整理 |
| `super-editor-book-authoring` | 多目录、整书、跨目录一致性或批量课页制作；逐页调用 page-authoring |
| `super-editor-assets` | 用户信息、样章/区块模板、组件和图片素材的最小范围搜索与应用 |
| `super-editor-books` | 搜索、核对、轻量/完整复制创建书本及跳转 |
| `super-editor-quality` | 相关范围审计、当前页保存回读和已有持久版本查看/恢复 |
| `super-editor-text` | 普通文本、表格单元格、思维导图节点的富文本内容、格式、链接和适配 |
| `super-editor-questions` | 搜题、读取详情/题解、选题、目录题目和题目讲解 |
| `super-editor-digital-modules` | 元素绑定的跳转、音视频、题目、AI 等点击交互 |
| `super-editor-blocks` | 区块新增、删除、复制、移动、重命名、尺寸、导入和替换 |
| `super-editor-elements` | 通用元素 CRUD、几何、层级、组，以及表格/思维导图/媒体细节路由 |
| `super-editor-canvas` | 安全切页、页面 CRUD、视口、截图、checkpoint/rollback 和保存 |
| `super-editor-outline` | 大纲树、区块关联和锚点 |

Tab 不是默认课件创作重点；只有用户明确要求时才由 elements 的按需 reference 处理。

## 连接与调用层

1. 用户在普通 Chrome/Edge 的编辑器顶部开启“AI 控制”；可用 `editor_status` 检查页面租约和上下文。
2. 首次业务工具调用会自动连接可用页面；多窗口时用租约固定 windowId，主动换目标才重新连接。
3. 所有写入调用 `editor_*` MCP 工具。浏览器控制只用于打开页面、只读探测和辅助截图，不能通过
   evaluate、鼠标或键盘修改画布。
4. 只有没有专用 MCP 工具时才使用 `editor_rpc_call`。Bridge 方法名只出现在 RPC/batch 参数或实现映射中。

## 标准路由

1. **定级**：先读公共策略，判断 micro/current/book；从最窄上下文开始。
2. **侦察**：目标明确就直读 target；current 才读相关区块/tree；book 分页读 summary。
3. **规划**：当前页创作用 page-authoring；纯几何用 layout；新建目录或成熟结构缺口才搜模板/素材。
4. **执行**：每一步只做一类领域写入，并立即用对应读取工具核对返回 id、内容或几何。
5. **视觉**：内容稳定后检查受影响区块；不因一个 micro 文本修改全页截图。
6. **保存**：画布 dirty 时统一 `editor_save_verified(scope=current)`；跨目录任务逐页保存。
7. **交付**：说明模板/素材/题目来源、保存结果、立即持久化域和仍需预览验证的项目。

## editor_batch

连续、同一页、同一意图的步骤可用 `editor_batch` 减少往返：

```text
editor_batch({
  steps: [
    { method: "getState", args: [] },
    { method: "listBlocks", args: [] }
  ],
  stopOnError: true
})
```

batch 中的 `method` 是 Bridge 方法名，这是 MCP 工具自身的参数，不是浏览器脚本。batch 按顺序执行但
**不是事务**；前一步成功不会因后一步失败自动撤销，checkpoint 也只能保护当前页工作副本。

## 关键安全边界

- dirty 切页默认 `editor_select_slide({ slideId, saveBeforeSwitch: true })`；丢弃必须来自用户明确要求。
- 目录、大纲、目录题目、题目讲解和数字模块属于立即持久化域，页面 rollback 不能恢复。
- 富文本禁止用 `editor_update_element.patch.content`，统一走 `editor_text_*`。
- 只有从完整导出对象修改少量属性、必须保持数字模块锚点和复杂内部结构时，才使用
  `editor_replace_block_safe/editor_replace_element_safe`；必须先 dry-run，再带 `expectedHash` 写入。
- `editor_save_verified(scope=book)` 不会逐页保存整书。
- `OUTCOME_UNKNOWN` 时先复读状态，禁止直接重放写操作。
- 静态审计与截图不能证明教学正确、媒体可播放或学生端互动可用；必要时走专用工具和预览链路。
