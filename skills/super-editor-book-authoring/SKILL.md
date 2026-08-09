---
name: super-editor-book-authoring
description: 超媒编辑器整书与跨目录创作技能。用户明确要求创建或扩充多个目录、完整制作一本书、统一跨目录结构/术语/风格、批量从题库编排多个课页，或对整书进行分层验收时使用。负责分页建立轻量清单和逐页调度 super-editor-page-authoring；单个当前课页改用后者。
---

# Super Editor Book Authoring

先读取公共[任务策略](../super-editor-control/references/task-policy.md)。只有用户明确要求多目录、整书、
全书统一或跨目录搜索时使用 book 范围；每个目录的实际制作必须加载 `super-editor-page-authoring`。

## 1. 建立轻量清单

1. 调用 `editor_get_book_manifest({ scope: 'book', detail: 'summary', pageNo, pageSize })` 分页读取。
2. 区分可制作课页、父目录、空容器和附录；不要把所有目录自动列为写入目标。
3. 记录目标 slideId、名称、页面规格、现有区块数和轻量内容 hash。只对疑点页或即将制作的当前页
   读取 standard/deep。
4. 只有任务确实涉及术语、占位、知识点或重复内容时才调用
   `editor_search_book_content`；使用非空 query、`pageNo/pageSize` 和返回的 nextPageNo 续页。

manifest 和整书内容搜索使用 `pageNo >= 0`、`pageSize: 1..200`；搜索单批命中仍受
`limit: 1..500` 限制。不要把审计 cursor 传给 manifest/search，也不要把单批结果声称为全书结果。

## 2. 建立复用规则

1. 选取少量代表性已完成课页和高相关模板，提取标题层级、字体、配色、间距、区块密度和教学结构。
2. 样章只读参考；明确新增目录时才应用 `kind=chapter`。现有目录使用 `kind=block` 区块模板。
3. `styleReference` 只记录参考，不会应用模板或创建 blockId。
4. 组件和图片只在区块结构或资源有缺口时搜索，不因 book 任务自动遍历素材库。
5. 记录模板 ID、题目 GUID、真实 blockId 和主要素材来源，保持可追溯。

## 3. 逐页执行

对每个目标目录：

1. dirty 时使用 `editor_select_slide({ slideId, saveBeforeSwitch: true })` 安全切页。
2. 加载 `super-editor-page-authoring`，按当前页流程完成模板落位、槽位填充、局部布局和截图核对。
3. 加载 `super-editor-quality`，运行相关 current checks，并调用
   `editor_save_verified(scope=current)`。
4. 记录完成状态后再进入下一页。失败从最近已保存页面继续，不把跨目录步骤包装成事务。

不在 book 任务开始为所有页面创建 checkpoint；checkpoint 是当前会话、当前页快照，只在进入某页的
中高风险结构写入前使用。

当前没有持久化的整书 authoring job、后台队列或自动 resume token。长任务在当前任务上下文中维护
“待做/已保存/失败”页面清单；连接中断或 `OUTCOME_UNKNOWN` 后重新读取 manifest 和当前页状态，
从最后一个已验证保存点继续，不能声称存在服务端作业恢复。

## 4. 题库到多页课件

加载 `super-editor-questions` 搜索和读取题目，再按以下限制执行：

1. 从最窄 scope 搜题，读取少量候选详情并检查缺失、重复和父子题冲突。
2. `editor_plan_question_lesson` 每次接受 1..50 个 GUID；简单题组用 summary，复杂题组才用 deep。
3. `editor_render_questions_to_block` 单批最多 30 题。目标页先应用真实区块模板取得 blockId；
   每批先 `validateOnly=true`，正式渲染默认 append，replace 需要明确授权。
4. 渲染后由当前页技能检查公式、题图、选项、作答空间和答案/解析策略。

完整题目布局规则见 [question-layout.md](references/question-layout.md)。

## 5. 整书收尾

- 确认所有目标目录均有 current 保存验证结果。
- 只有明确整书交付/验收时，才用 `editor_audit_content(scope=book)` 按 cursor/limit 分页汇总；
  命中页再深读。
- `editor_save_verified(scope=book)` 只保存当前 dirty 页并附加整书摘要，不替代逐页保存。
- 报告目录完成情况、模板和题目来源、遗留 warning，以及静态工具无法证明的媒体、互动和学生端体验。
