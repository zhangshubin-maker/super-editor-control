---
name: super-editor-control
description: 控制超媒编辑器（super-editor）自动完成课件创作、编辑、修改与优化。通过浏览器打开带 ai_control=1 的编辑器页面，使用 window.__superEditor 桥接 API（或本插件 MCP 的 editor_* 工具）实时操作画布/区块/元素/打组/撤销重做/保存，并用截图验证效果。当用户要求 Codex 帮忙创建、编辑、修改、优化或审查课件内容时使用。
---

# Super Editor Control

让 Codex 像控制 Figma 一样控制超媒编辑器：实时查看画布、操作元素与区块、调整属性、保存与回退。

## 1. 架构总览

- **编辑器桥接页（在 super-editor 仓库内实现）**：`/content-editor?book_id=xxx&ai_control=1`。页面本身已具备三栏 UI（左侧图层/目录树、中间画布、右侧属性面板），并挂载 `window.__superEditor` 桥接对象。完整契约见插件 `assets/bridge-api-spec.md`。
- **本插件的 MCP 服务端**：零依赖 Node 程序，通过 CDP 连接浏览器页面，把桥接 API 包装成结构化工具（`editor_*`）。
- **浏览器控制**：优先用 MCP 工具；若 MCP 不可用，直接用浏览器控制技能（`browser:control-in-app-browser` / `chrome:control-chrome`）在页面里执行 JS 调用 `window.__superEditor`。

## 2. 前置条件

- super-editor 已在本机 `npm run dev` 运行（或可访问的测试环境）。
- 浏览器里有已登录的有效会话（推荐直接控制用户已登录的 Chrome）。
- 编辑器已实现桥接层（`window.__superEditor` 存在）；未实现时先按 `assets/editor-integration-guide.md` 补齐。
- 拿到目标课件的 `book_id`（或完整链接）。

## 3. 连接

### 方式 A：MCP 工具（推荐）
1. 让用户以调试端口启动已登录的 Chrome：`chrome.exe --remote-debugging-port=9222`。
2. 调用 `editor_connect`（可带 `pageUrl` 片段匹配已打开页面）或 `editor_open`（传入目标 URL）。
3. 调用 `editor_status` 确认桥接就绪。

### 方式 B：浏览器技能 + 直接调用桥接
1. 用浏览器控制技能打开目标 URL（带 `ai_control=1`）。
2. 在页面执行 JS 读取/调用 `window.__superEditor.*`。

## 4. 标准工作流（编辑/优化任务）

1. **打开**：确认 URL 带 `ai_control=1` 与正确的 `book_id`，等待页面加载且 `window.__superEditor` 就绪。
2. **勘察**：`editor_get_state` / `editor_get_slide` 获取页面、区块、元素树；必要时 `editor_screenshot` 看视觉现状。
3. **规划**：按用户需求列出改动清单（新增哪页/哪块、改哪些元素、布局如何调整），小步执行。
4. **执行**：每步只做一件事（新增元素 → 设属性 → 移动/缩放 → 截图核对），属性值要精确（坐标、宽高、颜色、字号等）。
5. **验证**：每个动作后截图（`editor_screenshot`）或读取状态，确认符合预期；不满足则用 `editor_update_element` 修正或 `editor_undo` 回退。
6. **收尾**：确认整体效果后 `editor_save`；如需撤销全部改动可逐步 `editor_undo`。

## 5. 桥接 API 速查

完整契约见 `assets/bridge-api-spec.md`。常用方法（均返回 Promise）：

| 分类 | 方法 |
|------|------|
| 状态 | `ping()` `getState()` `listSlides()` `getSlide(slideId)` `isDirty()` |
| 页面 | `selectSlide(slideId)` `addSlide(payload)` `deleteSlide(slideId)` `moveSlide(payload)` |
| 区块 | `addBlock(payload)` `updateBlock(payload)` `deleteBlock(blockId)` `moveBlock(payload)` |
| 元素 | `addElement(payload)` `updateElement(payload)` `deleteElement(elementId)` `moveElement(payload)` `resizeElement(payload)` `rotateElement(payload)` `duplicateElement(elementId)` `orderElement(payload)` |
| 打组 | `groupElements(elementIds)` `ungroup(groupId)` |
| 历史/保存 | `undo()` `redo()` `save()` |
| 视觉 | `screenshot()` |

层级结构：`画布(slide) -> 区块(block/template) -> 打组(group) -> 元素(element)`。元素关键字段：`id`、`templateId`（所属区块 uuid）、`groupId`（表层为 0）、`child_list`（组内子元素）。元素类型包括 text/image/shape/table/video/audio/mind/latex/bracket/connectLine/input/outline/tab/textarea/group/template 等，字段结构参考《元素结构说明文档》。

## 6. 安全与协作规则

- 删除（区块/元素）前先读取状态确认对象存在；删除虽可撤销，仍需谨慎。
- 切换页面、保存前确认脏状态；大批量操作前先告知用户并小步执行。
- 不要绕过桥接 API 直接改 Vuex（除非调试），否则会破坏操作日志与撤销重做。
- 生产环境页面默认不挂桥接；仅在开发/测试环境使用 `ai_control=1`。
- 操作失败时读错误信息，先修参数重试，不要盲目重复相同调用。

## 7. 故障排查

- 桥接不存在（BRIDGE_MISSING）：URL 是否带 `ai_control=1`？页面是否已登录？刷新后重试。
- CDP 连接失败：确认 Chrome 用 `--remote-debugging-port=9222` 启动，且 `http://127.0.0.1:9222/json/version` 可访问。
- 元素没显示：确认 `templateId`/`groupId` 正确、坐标在区块/画布范围内、区块高度足够（高度会自动联动）。
- 截图与实际不符：先 `getState` 读取真实数据，再以截图为准核对渲染。
## 8. 实战工作流（2026-08 首轮课件优化验证）

### 8.1 推荐连接方式（无用户浏览器依赖）
1. 用 `node` 子进程拉起独立 Chrome：`chrome.exe --remote-debugging-port=9222 --user-data-dir=<临时目录> --headless=new <目标URL>`（URL 自带 `token` 即可登录，无需用户已登录会话）。
2. CDP `Runtime.evaluate`（`awaitPromise + returnByValue`）在页面主世界调用 `window.__superEditor.*`。
3. 编辑完成后 `Page.reload` 验证服务端持久化。

### 8.2 操作纪律
- 编辑前：`getSlide(slideId)` 全量 JSON 落盘备份。
- 小步执行：每步只做一类操作（新增→属性→移动→校验），完成后 `getSlide` 核对。
- 结构核对优先：先比对疑似重复区块的 `src`/`content`/坐标，确认重复再删除；不要仅凭同名删除。
- 保存后：重载页面确认新增区块/改名/删除都持久化。

### 8.3 已知坑
- 扩展/沙箱 evaluate 读不到 `window.__superEditor`：用 `data-super-editor-bridge` DOM 标记探测，调用走 CDP 主世界。
- `getSlide` 等 id 参数是标量，传对象会得到服务端 JSON 反序列化错误。
- 画布虚拟滚动：`scrollTop` 赋值无效，用 wheel 事件滚动后读 `innerText` 验证远端区块。
- `screenshot()` 只覆盖已渲染区块；需要全页时滚动分段截图。