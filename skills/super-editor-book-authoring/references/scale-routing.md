# 调用规模路由

## 目标

让调用成本与用户意图匹配。默认从最窄上下文开始，只有证据不足或任务本身跨目录时才升级范围。

## 规模判断

### Micro：单一明确目标

示例：改一个标题、替换一句话、设置一个表格单元格、绑定一个数字模块。

- 只读取目标元素/文本 target/数字模块。文本局部修改加载 `super-editor-text`，使用 `editor_text_document` → `editor_text_edit` → 同 target 复读，不要猜工具名或整体覆盖 HTML。
- 不调用整书 manifest，不搜索全部模板，不做全局审计。
- 修改后读取同一目标核对。
- 若画布产生 dirty，调用 `editor_save_verified({ scope: 'current', expectedSlideId })` 持久化；它只保存并回读当前页，不会扫描整书。
- `expectedContentHash` 可省略；若传入，只能使用刚从当前页 manifest/页面清单取得的页级 hash，不能使用文本 `contentHash` 或审计 `sourceHash`。

### Current：一个区块或一个目录

示例：整理本区块排版、补一组图文、把三道题放入练习区、制作当前课页。

- 一个目录使用 `editor_get_book_manifest({ scope: 'current', detail: 'standard' })`；单区块只读取区块和相关元素。
- 需要成熟结构时搜索区块模板；不搜索无关样章。
- 同类修改可放入一次 `editor_batch`。
- 先参考一到三个高相关样章/区块模板，不遍历整个素材库。
- 结构写入前建立当前页 checkpoint；完成后只审计相关 checks，并 saveVerified current。

### Book：多目录或整本书

示例：完整制作一本书、补齐所有章节、全书术语与风格统一。

- 使用 `book/summary` manifest，按 `pageNo >= 0`、`pageSize: 1..200` 分页；不要传 audit 的 cursor/limit。
- `editor_search_book_content` 使用非空 query、`pageNo >= 0`、`pageSize: 1..200` 和每批 `limit: 1..500`；按返回的 `pagination.hasMore/nextPageNo` 续页，不传 audit cursor。用窄查询定位命中目录，再读取该目录的 current/standard；不要把单批有限命中声称为穷尽搜索。
- 先确定代表性样章和结构规则，再逐页制作。
- 样章只读参考；现有目录实际复用区块模板。组件和图片仅在结构或资源有缺口时搜索。
- 每页 checkpoint、current 审计并保存验证；明确整书交付时才按 cursor/limit 分页审计整书。

## 升级条件

只有以下情况从局部升级到整书：

- 用户明确说“整书、全部目录、统一、批量”；
- 当前问题疑似在多个目录重复出现；
- 需要判断知识覆盖、前后重复或跨目录跳转；
- 局部证据无法决定模板或内容归属。

升级前说明范围变化；不要因工具可用就自动升级。
