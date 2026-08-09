---
name: super-editor-page-authoring
description: 超媒编辑器当前课页创作技能。用户要求制作、扩充、重写或完善当前目录/单个课页，新增一个或多个教学环节，利用区块模板填充讲解、示例、练习、总结、图片或题目，并完成当前页布局、验收和保存时使用。一个明确文本或元素小改动不触发本技能；多目录或整书任务由 super-editor-book-authoring 逐页调用本技能。
---

# Super Editor Current Page Authoring

先读取公共[任务策略](../super-editor-control/references/task-policy.md)。本技能只编排当前页；目标只是
一个明确文本或元素时直接使用领域技能，多个目录时加载 `super-editor-book-authoring`。

## 1. 确认目标和教学结构

1. 用 `editor_get_state` 确认当前 slideId；用 `editor_list_blocks` 读取当前页轻量结构。
2. 仅在需要嵌套元素、几何和内容角色时调用 `editor_get_canvas_tree`；不因“制作课页”读取整书。
3. 根据用户目标列出必要教学环节，例如导入、目标、讲解、例题、互动、练习、总结。不要机械补齐所有环节。
4. 已有区块可满足目标时优先克隆或改写；缺成熟结构时再搜索区块模板。

### 发现成熟参考页的 MCP recipe

当前页写入需要复用本书风格时，允许做以下有界只读，不改变任务规模：

```text
editor_list_slides({})

# 目录很多、需要轻量结构摘要时二选一补充
editor_get_book_manifest({
  scope: "book",
  detail: "summary",
  pageNo: 0,
  pageSize: 50
})

# 按相邻章节、同类教学环节或相近区块结构筛出 1–3 页
editor_get_slide({ slideId: "representative-slide-id" })
```

从代表页提取标题层级、字体、配色、间距、区块密度、图片比例和教学环节结构。最多深读 1–3 个代表页，
不切换或修改参考页，不因使用 `scope=book` 的 summary 读取而启动整书审计或整书写入。候选不足时再使用
区块模板，不通过逐页 `getSlide` 遍历全书。

## 2. 模板选型与真实落位

1. 加载 `super-editor-assets`，搜索少量 `kind=block` 高相关模板；读取候选详情核对结构、风格和元素类型。
2. 样章只用于理解设计语言。现有目录不能应用 `kind=chapter`；它会新建目录并立即写库。
3. 调用 `editor_apply_template({ kind: 'block', ... })` 后，以返回的真实 blockId 为后续目标。
4. 没有合适模板时才使用 `editor_add_block` 和基础元素构造；复用当前书的标题层级、字体、配色和间距。

## 3. 理解槽位后填充

模板没有可靠的自动语义槽位时，按以下证据识别元素角色：

1. 元素原文、名称、类型、空间层级和同组关系；
2. 模板详情中的重复结构与装饰/内容分区；
3. 当前书相似区块中的实际用法。

将角色记录为标题、正文、示例、提示、题干、答案区、图片等，再逐项写入。证据不足时不要批量覆盖
相似文本或删除装饰元素；先缩小到明确 target。

当前没有通用的模板语义槽位 API 或“按角色一次性实例化模板”工具；上述映射属于基于实际模板内容的
推断，必须逐项复读验证，不能声称模板已自动理解。

- 普通文本、表格单元格、思维导图节点统一用 `super-editor-text`。
- 图片优先从本书素材库选择；区块仍有视觉缺口时才搜索组件或总图片库。
- 题库内容加载 `super-editor-questions`，先计划和 validate-only，再渲染到真实 blockId。
- 点击交互只有用户需要时才加载 `super-editor-digital-modules`。

## 4. 先内容、后最终布局

1. 先完成文本和媒体填充，让文本适配、表格行高和思维导图重排稳定。
2. 再加载 `super-editor-layout`，在区块局部坐标内调整元素位置、尺寸、对齐、间距和层级。
3. 多元素重排、区块结构或复杂嵌套修改按公共策略建立一次 checkpoint；普通槽位文案替换不默认整页快照。
4. 不从通用技能套固定品牌色；从已确认模板和当前书提取设计语言。

## 5. 验收与保存

1. 复读所有写入 target、blockId、elementId 和题目元素映射。
2. 对每个受影响区块调用 `editor_screenshot({ blockId })`，结合 `editor_get_canvas_tree` 检查边界、
   遮挡、对齐、留白、图片比例和文本适配。整页流向改变，或跨区块对齐、节奏、留白关系本身就是
   验收目标时，必须追加 `editor_screenshot({ fullPage: true })`。
3. 加载 `super-editor-quality`，只运行与本次任务相关的 current checks。
4. 调用：

```text
editor_save_verified({
  scope: "current",
  expectedSlideId: "当前 slideId",
  verify: true
})
```

5. 报告复用的模板/素材、写入区块、题目 GUID、保存结果和学生端仍需验证的互动或媒体项。

## 最小 recipe

- **补一个教学环节**：listBlocks → 搜索/应用一个 block 模板或 cloneBlock → 理解槽位 → 文本/资源填充
  → 局部布局 → 受影响区块截图 → current 保存验证。
- **完善已有当前页**：读取目标区块 → 先修内容缺口 → 再调布局 → 只审计相关 checks → current 保存。
- **空白当前页**：先确定必要环节和代表性模板，不先批量创建基础元素；逐区块完成并核对。
