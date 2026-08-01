# window.__superEditor 桥接 API 契约（v0.1）

本文档定义 super-editor 编辑器侧需要实现的桥接层接口，供 Codex 通过浏览器控制编辑器（本插件 skill / MCP 的调用依据）。

## 1. 启用与挂载

- 仅在 URL 带 `ai_control=1` 时挂载 `window.__superEditor`（开发/测试环境），生产环境默认关闭。
- 建议页面加载完成后（`mounted` 之后）挂载，路由销毁时移除：`delete window.__superEditor`。
- 提供一个 `window.__superEditor.disable()` 以便随时摘除。

## 2. 调用约定

- 所有方法返回 `Promise`；内部实现必须走 Vuex mutation/action（与用户 UI 操作同一条链路），以保留操作日志与撤销/重做。
- 参数一律为普通对象/数组/基本类型；返回值一律可 JSON 序列化（不要返回 Vue 实例、DOM 节点、函数）。
- 每个写操作完成后 `await this.$nextTick()`，保证调用方随后截图/读状态时拿到最新渲染。
- 读操作返回“深拷贝”后的数据，避免调用方改动污染编辑器状态。

## 3. 数据形状（关键字段）

层级：`画布(slide) -> 区块(block/template) -> 打组(group) -> 元素(element)`

```js
// slide 关键字段
{ id, name, book_id, parent_id, page_id?, natural_code?, manual_code? }

// block 关键字段
{
  uuid, name,
  template_data_content: {
    size: { width, height },
    paddingTop, paddingBottom,
    elements: [ ... ]  // 本区块元素（含 group 容器）
  }
}

// element 关键字段（详见《元素结构说明文档》）
{ id, type, templateId /*=所属区块uuid*/, groupId /*=父组id，表层为0*/, child_list?, ...业务字段 }

// getState() 返回
{
  bookInfo: { id, name, smart_book_type },
  slides: [ { id, name, pageId } ],
  currentSlideId,
  selection: [ elementId ],
  dirty: Boolean
}

// getSlide(slideId) 返回
{
  slide: { id, name, size: { width, height }, background },
  blocks: [ { uuid, name, size: { width, height }, elements: [ element ] } ]
}
```

## 4. 方法清单

### 状态与查询

| 方法 | 参数 | 返回 |
|------|------|------|
| `ping()` | 无 | `{ version, editorType, bookId, mode }` |
| `getState()` | 无 | 见上 |
| `listSlides()` | 无 | `[{ id, name, pageId }]` |
| `getSlide(slideId)` | string | 见上 |
| `isDirty()` | 无 | `Boolean` |

### 页面（slide）

| 方法 | 参数 | 返回 |
|------|------|------|
| `selectSlide(slideId)` | string | 无 |
| `addSlide(payload)` | `{ name?, parentId?, template_id?, type? }`（不加模板时创建空页面） | `slideId` |
| `deleteSlide(slideId)` | string | 无 |
| `moveSlide(payload)` | `{ slideId, toIndex }`（同级排序） | 无 |

### 区块（block）

| 方法 | 参数 | 返回 |
|------|------|------|
| `addBlock(payload)` | `{ afterBlockId?, size? }` | `blockId` |
| `updateBlock(payload)` | `{ blockId, patch }`（patch 支持 `name`、`size` 等） | 无 |
| `deleteBlock(blockId)` | string | 无 |
| `moveBlock(payload)` | `{ blockId, toIndex }` | 无 |

### 元素（element）

| 方法 | 参数 | 返回 |
|------|------|------|
| `addElement(payload)` | `{ blockId, type, payload }` | `elementId` |
| `updateElement(payload)` | `{ elementId, patch }` | 无 |
| `deleteElement(elementId)` | string | 无 |
| `moveElement(payload)` | `{ elementId, x, y }` | 无 |
| `resizeElement(payload)` | `{ elementId, width, height }` | 无 |
| `rotateElement(payload)` | `{ elementId, angle }` | 无 |
| `duplicateElement(elementId)` | string | `elementId`（新） |
| `orderElement(payload)` | `{ elementId, position }`，position ∈ `front/forward/backward/back` | 无 |

### 打组

| 方法 | 参数 | 返回 |
|------|------|------|
| `groupElements(elementIds)` | `string[]` | `groupId` |
| `ungroup(groupId)` | string | 无 |

### 历史 / 保存 / 视觉

| 方法 | 参数 | 返回 |
|------|------|------|
| `undo()` / `redo()` | 无 | 无 |
| `save()` | 无 | 无（复用编辑器保存流程） |
| `screenshot()` | 无 | `data:image/png;base64,...`（画布可视区域） |

## 5. 实现注意事项

- **走 Vuex action**：所有写操作 dispatch 现有 action（见 `editor-integration-guide.md` 的映射表），这样 `commonDataSave` 会记录操作对象，撤销/重做（`commonDataUndo`）才能工作。
- **id 生成与替换**：新增元素必须生成唯一 `id`，并设置 `templateId = 所在区块 uuid`、`groupId = 0`；打组后子元素 `groupId = 组 id`；复制/深拷贝时用 `replaceElementsId` 同步替换所有子级 `groupId`。
- **高度联动**：增删改元素后调用 `updateTemplateHeightByElementList(templateId)`（现有 action 已处理）。
- **错误处理**：任何失败都 reject，消息要可读（例如 `区块不存在: xxx`）。
- **不要**在桥接里直接 `commit` 绕过日志的 mutation（除非该动作本身无操作日志需求）。


- 页面增删改会通过目录接口持久化（ddBookCatalog / deletecatalog / updatecatalogsort），其他写操作先入本地 store，save() 时统一提交。

## 6. 安全

- 桥接只在 `ai_control=1` 且非生产环境挂载；服务端若可鉴权更佳。
- `editor_eval` 类低层通道不要暴露给非授权方；本插件只在页面上下文调用，不新增远程端口。
- 建议给桥接增加调用白名单/频率限制（可选）。
## 7. 实战经验（2026-08 首轮验证补充）

### 7.1 探测与连接
- 页面挂载后 `document.documentElement` 会出现 `data-super-editor-bridge="1"` 属性，卸载时移除。任何隔离世界/主世界都可以用它探测桥接是否就绪。
- 浏览器扩展类控制工具（如 content-script 沙箱）通常**看不到** `window.__superEditor`，此时以 DOM 标记为准；真正调用方法必须走 CDP `Runtime.evaluate`（主世界）。
- URL 带 `token` 时，全新浏览器实例（`--remote-debugging-port` + 独立 `--user-data-dir`）打开同一 URL 即可直接鉴权，无需用户已登录的浏览器。

### 7.2 参数约定（重要）
- `getSlide(slideId)` / `selectSlide(slideId)` / `deleteBlock(blockId)` 等方法的 id 参数一律是**标量**（string/number），传 `{ slideId }` 对象会触发服务端反序列化错误（`Cannot deserialize ... int from Object`）。
- `addBlock({ afterBlockId?, size? })` 返回 `{ blockId }`；`addElement({ blockId, type, payload })` 返回 `{ elementId }`；新增后可立刻 `getSlide` 校验。

### 7.3 文本元素样式模板（与产品风格一致）
```js
// 一级标题（橙色粗体，产品色 rgb(211,94,15)，字体江城圆体 20px）
{
  type: 'text', adaptive: 'width', defaultFontSize: 20, defaultFontName: '江城圆体',
  defaultFontWeight: 600, wordSpace: 1.8,
  content: '<p><b class="cmihee-bold" data-weight="600" style="font-weight: 600; color: rgb(211, 94, 15); font-size: 20px; font-family: num-江城圆体, en-江城圆体, zh-江城圆体;">标题文字</b></p>'
}
// 正文内容（思源黑体 CN 16px，行高 1.6，自适应高度）
{
  type: 'text', adaptive: 'height', defaultFontSize: 16, defaultFontName: '思源黑体 CN',
  defaultFontChinese: '思源黑体 CN', defaultFontEnglish: '思源黑体 CN', defaultFontNumber: '思源黑体 CN',
  lineHeight: 1.6,
  content: '<p style="margin: 0 0 4px 0;"><span style="font-family: &quot;num-思源黑体 CN&quot;, &quot;en-思源黑体 CN&quot;, &quot;zh-思源黑体 CN&quot;; font-size: 16px; color: rgb(51, 51, 51);">正文</span></p>'
}
```

### 7.4 画布渲染与验证
- 编辑器画布是**虚拟滚动**：`#canvas-ref` 只渲染可视区块，`screenshot()`（html2canvas）只能捕获已渲染部分；验证远端区块时先用 wheel 事件滚动画布（`scrollTop` 被自定义滚动接管，直接赋值无效）。
- 滚动验证示例：`document.querySelector('#canvas-ref').dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true, cancelable: true }))`，循环滚动后读取 `innerText` 核对文本。
- 编辑前先 `getSlide` 全量 JSON 备份；保存后 `Page.reload` 再从服务端读取验证持久化。