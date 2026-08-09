---
name: super-editor-quality
description: 超媒编辑器课件质量审计、当前页保存回读与版本查看/恢复技能。用户要求检查当前目录或整书中 Bridge 可检测的空目录、缺名、空文本、已知占位、空媒体、非法几何或越界问题，验证当前页保存结果，查看或恢复持久版本，或在完整做书后进行分层验收时使用。按 micro/current/book 范围调用 editor_audit_content、editor_save_verified 和版本工具；更深引用、数字模块、术语一致性与视觉遮挡转交专用读取工具或预览验证。
---
# Super Editor 质量验收

验证 AI 的当前改动已按目标核对并保存，报告 Bridge 实际能够发现的问题。不要把静态审计结果描述为教学正确、引用完整、互动可用或视觉无遮挡的证明。

## 1. 按 micro / current / book 选择范围

- **micro**：用对应读取工具复读明确目标；不调用 `editor_audit_content`，但画布 dirty 时仍用 `editor_save_verified(scope=current)` 保存回读。
- **current**：当前区块或目录完成后，用 `editor_audit_content(scope=current)` 且只选择相关 checks，再 `editor_save_verified(scope=current)`。
- **book**：逐页 current 审计和保存；只有用户明确要求整书交付/验收时，才用 `editor_audit_content(scope=book)` 按 `cursor`、`limit: 1..100` 分页，汇总后只深读命中页。

审计维度和严重级别见 [audit-checks.md](references/audit-checks.md)。

## 2. 保存验证

1. 写操作后读取目标确认本地状态。
2. 调用 `editor_save_verified({ scope: 'current', expectedSlideId, verify: true })`；不把 micro/current 保存升级为 book 扫描。
3. 核对返回的 slideId、dirty、保存前后 hash 和回读结果。
4. hash 或 expectedSlideId 不匹配时停止后续写入，重新读取现状。
5. 多目录任务每完成一页就保存验证，避免最后一次性承担全部风险。

`expectedContentHash` 是可选并发保护。若传入，必须是**写入后、保存前**刚从当前页 manifest/页面清单取得的页级内容 hash；不要传文本工具的 target `contentHash`，也不要传审计报告的 `sourceHash`。`editor_save_verified(scope=book)` 仍只保存当前 dirty 页，然后附加整书摘要校验，不会逐页保存全书。

## 3. 内容审计

- `checks` 只选择与任务相关的维度：`structure`、`text`、`resources`、`layout`。实际规则以 [audit-checks.md](references/audit-checks.md) 为准。
- 使用问题的稳定 `id` 定位，使用 `sourceHash` 判断报告是否仍对应当前内容。
- 先处理 error，再处理 warning；占位文本和空媒体不能因页面“看起来正常”而忽略。
- 表格和思维导图文本问题仍通过统一富文本 target 修复，不直接重写其内部结构。
- 修复前重新读取目标；sourceHash 变化时放弃旧修复计划并重新审计。
- Bridge 审计不验证深层大纲/锚点/目录跳转、题目和答案正确性、数字模块配置、全书术语一致性、元素互相遮挡或学生端互动。分别加载 outline/questions/digital-modules/text 或 book-authoring 搜索工具，并结合 canvas tree、截图和预览链路核对。

## 4. checkpoint 与持久版本

- 每个目录的大范围或结构性写入前调用当前页 `editor_checkpoint`；它是会话内、单页快照，不是后端持久版本，刷新后失效。
- `editor_list_book_versions` 只列出现有持久版本，**不会创建恢复点**。仅在用户要求查看/恢复版本或已有明确回滚计划时调用；默认查 current，不因整书制作自动列出全书版本。
- 恢复前先 `editor_get_book_version` 查看目标版本，不凭序号猜测。
- 先调用 `editor_restore_book_version(validateOnly=true)` 校验版本、目录和当前状态。
- 正式恢复是破坏性操作，必须来自用户明确要求或已确认的回滚计划。
- 恢复后重新读取目录并运行对应范围审计。

## 5. 交付顺序

1. 确认所有目标目录均已逐页 current 保存验证。
2. 明确整书交付时分页执行 book 审计，并记录 Bridge 未覆盖的检查项。
3. 有题目或数字模块时才用对应专用工具核对 GUID、答案/解析策略和绑定；不要对无互动课件做无关全局调用。
4. 用文本/内容搜索核对明确术语；用 canvas tree + 代表性截图检查裁切、重叠和遮挡；重要互动走学生端人工或预览链路。
5. 汇总修改目录、引用模板/素材、选用题目、遗留 warning、未自动验证项，以及用户明确查看过的持久版本信息。

不要自动发布书本；发布属于有外部影响的独立操作。
