---
name: super-editor-books
description: 超媒编辑器（super-editor-control 插件）的书本管理技能。用户要求搜索可访问书本、查看源书属性、基于现有书本克隆创建新书、指定新书名称/教辅交互类型/封面，或生成并执行书本编辑器跳转时使用。覆盖 editor_search_books、editor_get_book、editor_create_book、editor_jump_to_book。
---

# Super Editor Books

书本创建、复制和跳转前读取公共[任务策略](../super-editor-control/references/task-policy.md)。创建属于
立即持久化操作，跳转会改变编辑上下文；页面 checkpoint 不能回退。

用现有书本作为可靠基线创建新书。默认只继承必传属性，不复制目录和内容。

## 搜索与选择源书

1. 在普通浏览器中打开任意已登录的超媒编辑器页面，并开启顶部“AI 控制”。
2. 调用 `editor_search_books({ query, smartBookType?, pageNo?, pageSize? })`。
3. 名称相近时，调用 `editor_get_book({ bookId })` 核对学科、年级、版本、关联教材、
   `smart_book_type` 和封面，不能仅凭名称猜源书。
4. 教辅类型允许传数字或中文：
   - `1` / `PDF交互型`
   - `2` / `软件交互型`
   - `3` / `超媒交互型`
   - `4` / `界面交互型`

## 基于源书创建

调用：

```json
{
  "sourceBookId": 123,
  "copyMode": "light",
  "name": "新书名称",
  "smartBookType": "超媒交互型",
  "coverImagePath": "D:\\assets\\cover.png",
  "coverType": 0
}
```

- `sourceBookId` 必填；`copyMode` 默认 `light`，其他字段都是覆盖项。
- `light`：调用 `addbook` 新建书本，只继承书本外部属性、学科、关联教材、分类和版本；
  **不继承目录、区块、元素或其他内容**。
- `full`：复制完整书本，包含目录和内容；PDF/超媒源书走
  `deepcopyhypermediabook`，软件/界面源书走 `copysebbook`。
- 本地封面优先传 `coverImagePath`，工具会先上传并写入 `cover_img_id` 与 URL。
- 已有上传结果可直接传 `coverImgId`、`coverImgUrl`；只传 URL 可能受后端封面规则限制。
- 创建是立即写库的外部副作用。只在用户明确要求创建时调用；不要为预览或试探创建临时书。
- 返回值必须核对 `bookId`、最终 `book.book_info` 和 `editorUrl`。若工具报告无法识别
  新书 ID，先按源书名称重新搜索，避免重复创建。

## 复制模式决策

- 默认一律使用 `light`，包括“根据这本书创建新书”“沿用书本属性”“新建同类型教辅”等
  未明确要求内容复制的表达。
- 只有用户明确说“完整复制”“保留/沿用目录”“复制全部内容”“制作一份完全相同的副本”，
  才使用 `full`。
- 若后续任务明确要求在源书已有目录或内容上继续编辑，可判断使用 `full`；必须在执行前说明将
  继承目录和内容。
- 不得仅因源书是 PDF 或超媒交互型就自动使用 `full`。书本类型只决定 `full` 模式下采用哪个
  服务端复制接口。

## 跳转书本

`editor_jump_to_book({ bookId, target, saveBeforeSwitch? })` 的 `target`：

- `url`：只返回编辑器 URL，默认且最安全。
- `new`：尝试打开新标签页；浏览器阻止弹窗时使用返回的 URL 手动打开。
- `current`：先替换目标 URL，再完整刷新当前窗口；MCP 固定原 `windowId`，等待目标书本和目录加载就绪后才返回。当前页 dirty 时必须传 `saveBeforeSwitch: true`，由工具先保存并回读验证。

**URL 不变式**：`book_id`、`business_id`、`Scope`、`token` 和 `ai_control=1` 都属于
`#/content-editor` 路由，必须放在 hash 路由后的查询串中；禁止放在 hash 前的外层 URL
查询串，也禁止内外各保留一份。正确形式：

```text
https://host/hyper-media-editor/#/content-editor?business_id=...&Scope=...&book_id=1820651&winOpen=1&ai_control=1
```

跳转到另一本书时必须删除旧 `catalog_id`，避免新书携带旧书目录。跳转会让原页面 RPC
实例失效；`target=current` 成功结果必须包含目标 `bookId`、`ready=true`、`bridgeReady=true`、
新 `instanceId` 和原 `windowId`。`scheduled: true` 只表示 Bridge 已安排刷新，不是最终成功。
`url/new` 不等待目标页面；需要继续操作时仍用 `editor_status` 核对。仅在跨会话打开确实需要时传
`includeToken: true`。

## 推荐完整流程

1. `editor_search_books` 搜索候选。
2. `editor_get_book` 核对源书。
3. 向用户确认目标名称、交互类型和封面（用户已明确时无需重复询问）。
4. `editor_create_book` 创建并核对 `copyMode`、`includesCatalogAndContent` 与返回属性。
5. `editor_jump_to_book(target=current)` 跳转并等待目标书本就绪；若返回 `BOOK_SWITCH_TIMEOUT`，先读取状态，不重复发起导航。
6. 若要继续自主设计目录，转用 `super-editor-assets` 搜索样章、区块、组件和图片素材。

## 工具速查

| MCP 工具 | 用途 |
|---|---|
| `editor_search_books` | 调用 `getbooklist` 搜索当前用户可访问书本 |
| `editor_get_book` | 调用 `getbookinfo` 读取完整源书属性 |
| `editor_create_book` | 默认轻量继承属性；明确需要时完整复制目录与内容 |
| `editor_jump_to_book` | 生成或执行目标书本编辑器跳转 |
