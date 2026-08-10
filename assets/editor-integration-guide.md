# super-editor 桥接层实现指南

在超媒编辑器（Vue 2 + Vue CLI 3）仓库内实现 `window.__superEditor`，让 Codex 能通过浏览器控制编辑器。本文档基于仓库现状（`docs/base-editor-canvas.md`、`docs/store-api-layer.md`、`画布与元素层级结构说明文档.md`、`元素结构说明文档.md`）。

## 0. 实现状态

桥接层已在 `src/modules/contentEditor/aiControl/` 实现并挂载：

- `src/modules/contentEditor/aiControl/bridge.js` — `window.__superEditor` 实现
- `src/modules/contentEditor/aiControl/index.js` — `mountBridge` / `unmountBridge`
- `src/modules/contentEditor/index.vue` — 监听 store 中的 `aiControl` 状态并动态挂载/卸载
- `src/modules/contentEditor/components/Header/index.vue` — 顶部“AI 控制”按钮

以下步骤作为原理说明与后续扩展参考；若只需启用，按第 3 节联调即可。

## 1. 总体思路

**复用现有编辑页，而不是新做一个画布。** `/content-editor` 页面本身已经满足“左元素树 / 中画布 / 右属性面板”三栏布局。用户点击顶部“AI 控制”后，把桥接对象挂到 `window` 上，Codex 就能驱动整个编辑器，且所有修改走与人工操作完全相同的 Vuex action（操作日志、自动高度联动全部生效）；AI 控制开启时撤销/重做改用整页深拷贝快照（checkpoint/rollback），不再写操作栈。

## 2. 实现步骤

### 2.1 入口：监听顶部 AI 控制按钮

文件：`src/modules/contentEditor/index.vue`

在页面中监听根 store 的 `aiControl` 状态：

```js
watch: {
  aiControl(val) {
    if (val) mountBridge(this.$store)
    else unmountBridge()
  }
}
```

更简单的方式：桥接模块自己持有对 `store` 的引用（直接 `import store from '@/store/index'`），在页面 `mounted` 后调用 `mountBridge()`，`beforeDestroy` 时 `unmountBridge()`。

```js
// src/modules/contentEditor/aiControl/index.js
import store from '@/store/index'
import { createBridge } from './bridge.js'

export function mountBridge() {
  if (window.__superEditor) return window.__superEditor
  const bridge = createBridge(store)
  window.__superEditor = bridge
  return bridge
}

export function unmountBridge() {
  delete window.__superEditor
}
```

### 2.2 新建目录

```
src/modules/contentEditor/aiControl/
├── index.js        # 挂载/卸载
├── bridge.js       # window.__superEditor 实现（契约见 assets/bridge-api-spec.md）
└── README.md       # 说明
```

### 2.3 桥接方法 -> 现有 store action 映射表

| 桥接方法 | 实现（现有逻辑） |
|----------|------------------|
| `getState()` | `commonBook/bookInfo` + `contentEditorSlides` 的 getters：`slides`、`currentSlide`、`currentSlideElementTree`、`baseEditorMain/selectElementIdList` |
| `getDigitalModule({ elementId })` | 先在当前 `blockTemplateList` 中定位元素所属模板，再以 `control_id=elementId`、`hypermedia_content_id=template.id` 调 `hypermedia/getControlModelList`；这里必须用模板后端 `id`，不能用 `uuid` |
| `createDigitalModule/updateDigitalModule` | 复用数字模块页面的 `hypermedia/addControlModel` 请求结构；更新时保留关系、模型、内容行和嵌套实体 ID，成功后广播 `ELEMENT_DIGITAL_MODULE` |
| `deleteDigitalModule` | 先查真实关系，再调 `hypermedia/deleteControlPosition({ id, model_id, type })` |
| `copyDigitalModule` | 调 `hypermedia/addcontrolmodelrelation` 给目标元素新增关系；当前语义是共享 `model_id`，不是独立深复制 |
| `listQuestionPaths` | `bookpath/getbooklearningpathtree`；递归展开 `child_list`，同时支持扁平节点和原树返回 |
| `getQuestionSearchOptions` | `dictionary/gettypelist(type=1,3,5)` + `book/getbooksearchmap(book_type=101)`；缓存实时字典，`refresh` 时重取 |
| `searchQuestions` | 当前目录/当前书资源用 `hypermedia/getcatalogresources`；学习路径用 `getbooklearningpathtree` + `getchildrenlistquesbypathid`；总题库用 `sbyquestion/getquestionlist`；`book` 仅是 `learningPath` 兼容别名 |
| `getQuestions/validateQuestionSelection` | `sbyquestion/getquestioninfolist` + `questions.js` 规范化/诊断；返回缺失、重复、父子冲突和模块兼容性，type 82 额外校验测评计时组合 |
| `getQuestionSolutions` | 对已找到 GUID 小批并发请求 `sbyquestion/getquestionsolution`，保留 `missingGuids` |
| `addQuestionsToCatalog/removeCatalogQuestion/moveCatalogQuestion` | 分别复用 `hypermedia/addcatalogresource`、`deletecatalogresource`、`updatecatalogresourcesort`；删除/排序使用关系 `resourceMappingId` |
| `getQuestionExplanations/startQuestionExplanationGeneration/getQuestionExplanationStatus` | 已保存讲解用 `sbyquestion/getquestionaiexplain`；生成与状态复用 `bookhypermedia/aiexplain/generateaiexplain`、`getaiexplainstatebyguid`、`getaiexplainbyguid` |
| `saveQuestionExplanation/deleteQuestionExplanation` | `sbyquestion/savequestionaiexplain` / `deletequestionaiexplain`；按讲解记录数字 ID 更新或删除 |
| `uploadFile` | 把 dataURL/base64 转为 `File`，复用 `request.upLoadFile`；图片、音频、视频数字模块共用 |
| `getTextDocument/editText/formatText/...`（Bridge 1.6.0） | 通过 `richTextTarget` 统一解析普通文本 `{elementId}`、表格单元格 `{tableId,cellId或row+col}`、思维导图节点 `{mindId,nodeId}`；内容级方法复用同一 Quill canonical 流程，布局级方法仍只处理独立文本元素 |
| `listSlides()` | `contentEditorSlides/slides` |
| `selectSlide(id)` | `dispatch('contentEditorSlides/selectSlide', id)` |
| `getSlide(id)` | 由 `slides`/`currentSlideAllTemplateList` + `dfcRecursion` 组装（参考 getter `currentSlideElementTree`） |
| `addBlock(payload)` | `dispatch('contentEditorSlides/addBlockTemplate', template)`，template 至少含 `uuid`、`template_data_content: { size, elements: [] }` |
| `cloneBlock(uuid, opts)` | `dispatch('contentEditorSlides/insertBlockTemplate', { template: cloneDeep(原模板) + 新 uuid, index })`，元素 id 冲突由 insertBlockTemplate 自动重生成 |
| `updateBlock(payload)` | `dispatch('contentEditorSlides/updateBlockTemplateDateContent', {...})`（改 name 用 `renameBlockTemplate`） |
| `deleteBlock(blockId)` | `dispatch('contentEditorSlides/deleteBlockTemplateByUuid', uuid)` |
| `moveBlock(payload)` | `dispatch('contentEditorSlides/moveBlockTemplate', { fromIndex, toIndex })`（fromIndex 由 uuid 换算） |
| `addElement(payload)` | `dispatch('contentEditorSlides/addElement', element)`；element 结构参考《元素结构说明文档》，必填 `id`/`type`/`templateId`/`groupId=0` |
| `updateElement(payload)` | `dispatch('contentEditorSlides/updateElement', { eid: elementId, ...patch })`（参数形态以现有调用为准，见 store 内 `updateElement` 消费方式） |
| `deleteElement(elementId)` | `dispatch('contentEditorSlides/deleteElement', elementId)` |
| `moveElement/resizeElement/rotateElement` | 先取元素对象，再 `dispatch('contentEditorSlides/updateElement', {...})` 合并坐标/尺寸/角度 |
| `duplicateElement(id)` | 参考现有复制/粘贴逻辑（`replaceElementsId` + `addElement`） |
| `orderElement(payload)` | `dispatch('contentEditorSlides/orderElement', { elements, position })` |
| `groupElements(ids)` | `commit('baseEditorMain/setSelectElementIdList', ids, { root: true })` 后 `dispatch('contentEditorSlides/groupElements')`（现有 action 按选中列表打组） |
| `ungroup(groupId)` | `dispatch('contentEditorSlides/decomposeElements')`（先选中该组） |
| `undo()` / `redo()` | ai_control 下已禁用（返回 `{ disabled: true, reason }`），回退请用 `checkpoint()` / `rollback()` 整页快照；无需再 dispatch `commonDataUndo/unDo|reDo` |
| `save()` | 复用 Header 的保存流程（`src/modules/contentEditor/components/Header/index.vue` 中 `saveCatalogContent` 的组装逻辑） |
| `screenshot()` | 复用 `ScreenShotContainer` 或 `html2canvas` 截取画布可视区域，返回 data URL |
| `isDirty()` | 依据 `commonDataSnapshot` / 保存状态判断 |

> 注意：以上 action 的参数形态请在实现时以 `src/modules/contentEditor/store/contentEditorSlides.js` 实际签名为准（部分 action 依赖 getter 推导，如 `groupElements`）。

### 2.4 写操作通用模板

```js
async function mutate(action, payload) {
  await store.dispatch(action, payload)
  await new Promise((resolve) => store._vm.$nextTick(resolve)) // 等待渲染
}
```

### 2.5 安全门槛

- 仅当用户点击顶部“AI 控制”按钮时挂载，关闭按钮时立即卸载。
- 挂载前打印一条明显的 `console.info('[ai-control] bridge mounted')`，便于排查。

## 3. 联调步骤

1. `npm run dev` 启动，浏览器登录（确保 `sessionStorage.business_id` 与 token 存在）。
2. 在普通 Chrome / Edge 中打开 `/#/content-editor?book_id=<你的课件ID>`，点击顶部“AI 控制”；`book_id` 和后续 `ai_control=1` 都必须位于 hash 路由查询串中。首次出现本地网络访问提示时选择允许。
3. Console 验证：`window.__superEditor && await window.__superEditor.ping()`。
4. 用本插件 MCP（直接调用 `editor_get_state`，或先调用无参数 `editor_connect`）执行一次元素修改，确认画布实时变化。
5. 任务开始/关键节点先 `checkpoint({ label })` 打快照；修改后 `editor_save`，刷新页面确认已持久化；若结果不符合预期 `rollback({ checkpointId })` 恢复，任务成功 `clearCheckpoints()`。

## 4. 注意事项

- **不要绕过 Vuex**：直接改 DOM/store 会让操作日志与编辑器状态失效；回退只允许走桥接快照（checkpoint/rollback）。
- **区分区块双 ID**：画布 API 的 `blockId`、元素 `templateId` 是模板 `uuid`；数字模块请求的 `hypermedia_content_id` 是同一模板对象的后端 `id`。桥接必须从 `elementId` 内部解析，不接受调用方传该后端字段。
- **数字模块即时写库**：新增、修改、删除、关系复制不受画布 `checkpoint/rollback/save` 管理；先读现状、明确冲突策略，写后重新查询验证。
- **题目资源即时写库**：目录题目添加/移除/排序、讲解保存/删除都不受画布回滚或保存管理；添加用题目 GUID，移除/排序用 `resourceMappingId`。AI 讲解生成采用 start/status 两步，Bridge 与 MCP 均不在启动调用里长轮询。
- **题目能力边界**：当前只管理题目资源及讲解，不实现完整题目编辑、OCR/AI 录题或把题目排版插入画布区块。
- **嵌套富文本布局**：单元格/思维导图文字写入后若无法独立验证领域布局，返回
  `settled=false/deferredLayout=true`；必须截图核对外层表格/思维导图。共享 hyperlinkId 的单目标 metadata
  修改返回 `TEXT_HYPERLINK_SHARED`，应省略旧 id 新建该目标的独立链接。
- **批量执行**：连续小步骤（改多个元素、多步读取、快照+编辑+核对）用 `batch({ steps })` 一次调用串行执行，一次返回全部结果，避免逐条 RPC 往返等待；写步骤之间会自动等渲染，安全可靠。
- **PDF 书差异**：`smart_book_type === 1` 的 PDF 书有占位页、页码合并逻辑，桥接 `listSlides/getSlide` 需兼容。
- **协同锁**：页面有 `EditLock` 协同编辑锁，多人编辑时桥接操作同样受锁约束。
- **大组/复制 id 重制**：参考 `replaceElementsId` 及映射 Map 逻辑，避免 id 冲突。
- 元素高度联动由 `updateTemplateHeightByElementList` 处理，桥接层无需重复实现。
