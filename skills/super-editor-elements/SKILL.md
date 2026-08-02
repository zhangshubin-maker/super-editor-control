---
name: super-editor-elements
description: 超媒编辑器（super-editor-control 插件）元素操作技能。在需要新增、删除、修改、移动、缩放、旋转、复制、选中、调整层级、打组/解组超媒画布元素（文本/图片/形状/表格/音频/视频等）时使用。表格操控（读网格/改单元格/行列增删/合并拆分/行高自适应收紧）见 §6.5，思维导图操控（读节点树/改文本样式/增删节点/切模板主题）见 §6.6，文本操控（内容修改后的宽高自适应与组内联动）见 §6.7。详细描述 window.__superEditor 桥接对象中 addElement/updateElement/getElement/listElements/selectElement/moveElement/resizeElement/rotateElement/duplicateElement/orderElement/groupElements/ungroup 的调用方式、各元素类型默认结构与文本样式模板。
---
# Super Editor Elements（元素控制）

元素是画布的最小编辑单元。区块内元素使用**区块局部坐标**；组（group）内子元素坐标相对组。

## 1. 方法速查

| 方法 | 参数 | 返回 |
|------|------|------|
| `addElement(payload)` | `{ blockId, type, payload }` | `{ elementId }` |
| `updateElement(payload)` | `{ elementId, patch }` | 无 |
| `deleteElement(elementId)` | 标量 | 无 |
| `moveElement(payload)` | `{ elementId, x, y }` | 无 |
| `resizeElement(payload)` | `{ elementId, width, height }` | 无 |
| `rotateElement(payload)` | `{ elementId, angle }` | 无 |
| `duplicateElement(elementId)` | 标量 | `{ elementId }`（新） |
| `addElements(payload)` | `{ blockId, elements: [{ type, payload }] }` | `{ elementIds }`（批量新增） |
| `updateElements(payload)` | `{ elementIds, patch }` | 无（批量改属性） |
| `deleteElements(elementIds)` | `string[]` | 无 |
| `duplicateElements(elementIds, opts?)` | `(string[], { offsetX?, offsetY? })` | `{ elementIds }`（批量复制） |
| `moveElementsByOffset(payload)` | `{ elementIds, dx?, dy? }` | 无（相对偏移） |
| `alignElements(payload)` | `{ elementIds, align, target? }` | 无（top/bottom/left/right/horizontal/vertical/center/hdengju/vdengju，target: selection/canvas） |
| `setElementSpacing(payload)` | `{ elementIds, direction, spacing }` | 无（横向/纵向等间距重排） |
| `centerElementInBlock(payload)` | `{ elementId, axis? }` | 无（区块内居中） |
| `setTextStyle(payload)` | `{ elementId, style }` | 无（fontSize/color/lineHeight 等，映射顶层字段） |
| `setElementOpacity(payload)` | `{ elementId, opacity }` | 无 |
| `lockElements` / `hideElements` | `(elementIds, bool)` | 无 |
| `renameElement(elementId, name)` | (string, string) | 无 |
| `flipElement(payload)` | `{ elementId, direction }` | 无 |
| `setElementText` / `setImageSrc` | `{ elementId, ... }` | 无（文本/资源快捷设置） |
| `setTableCellContent` / `setTableCellBackground` / `setTableData` / `getTableGrid` / `getTableInfo` / `insertTableRow` / `deleteTableRow` / `insertTableColumn` / `deleteTableColumn` / `mergeTableCells` / `splitTableCell` / `fitTableHeights` / `setTabs` / `setActiveTab` | 表格/选项卡专用（v0.4） | 见 §6.5 |
| `getMindData` / `getMindTree` / `setMindData` / `setMindNodeText` / `addMindNode` / `deleteMindNode` / `updateMindNode` / `setMindTemplate` / `setMindTheme` | 思维导图专用（v0.5） | 见 §6.6 |
| `getTextInfo` / `setTextContent` / `setTextAdaptive` / `fitTextSize` | 文本专用（v0.6，含宽高自适应与组内联动） | 见 §6.7 |
| `orderElement(payload)` | `{ elementId, position }`，position ∈ front/forward/backward/back | 无 |
| `groupElements(elementIds)` | `string[]`（≥2） | `{ groupId }` |
| `ungroup(groupId)` | 标量 | 无 |
| `getElement(elementId)` | 标量 | 元素完整数据（含 `blockId`） |
| `listElements(filter?)` | `{ blockId?, type? }` | `[{ id, name, type, left, top, width, height, blockId }]` |
| `selectElement(elementId)` | 标量 | `{ selected: [id] }`（选中并滚动定位） |
| `selectElements(elementIds)` | `string[]` | `{ selected: ids }`（多选） |
| `getSelection()` | 无 | `[elementId]` 当前选中 |

坐标别名：`moveElement` 的 `x/y` 即 `left/top`；`updateElement` 的 patch 同时接受 `x/y` 与 `left/top`。

## 2. 新增元素（addElement）

```js
(async () => {
  const b = window.__superEditor
  const r = await b.addElement({
    blockId: 'w8fecasuXh12582',   // 所属区块 uuid
    type: 'text',
    payload: {
      content: '<p>双击编辑文本</p>',
      left: 75, top: 20, width: 300, height: 40,
      defaultFontSize: 16
    }
  })
  return r // { elementId }
})()
```

- `left/top` 省略时自动居中（按 viewport 794x1123 计算）。
- 添加后元素自动设为选中态；ai_control 下无撤销栈，批量调整前先 `checkpoint()`，出错 `rollback()`。
- 新元素 `templateId` 自动绑定为区块 uuid；坐标超出区块会撑高区块（高度联动）。

## 3. 各元素类型默认结构（可覆盖的 payload 基础）

```js
text:     { width:200, height:50, content:'双击编辑文本', background:{extendType:'horizontal'}, defaultFontSize:14 }
image:    { width:300, height:200, src:'', fixedRatio:true }
shape:    { width:100, height:100, isFill:true, fill:'#d14424', verticalAlign:'middle' }
line:     { width:200, height:2 }
audio:    { width:600, height:100, audio:[] }
video:    { width:600, height:340 }
input:    { width:500, height:80, placeholder:'请输入', isOutline:true, outline:{width:1,color:'rgba(0,0,0,1)',style:'solid'}, fill:'rgba(255,255,255,1)', fontsize:'40px' }
textarea: { width:500, height:300, placeholder:'请输入', isOutline:true, ...同上 }
latex:    { width:200, height:50, latex:'', color:'#000000' }
tab:      { width:300, height:60, activeTab:0, styleType:1 }   // 自动生成 3 个 tab 项
outline:  { width:130, height:45 }
bracket:  { width:300, height:200, src:'[]', style:1 }
mind:     { width:400, height:300, content:'' }  // content 为 kityminder JSON 字符串，见 §6.6
table:    { width:400, height:200 }                             // 表格数据需在 tableData 字段
connectLine: { width:200, height:100, points:[], lineType:'straight' }
group:    { width:100, height:100, child_list:[] }
```

> 表格类元素（table）结构复杂：字段含 `widths/heights/colWidth/rowWidth/borderWidth/borderColor/rowColor/colColor/borderRadius/tableData`。`tableData` 为行数组 `[{ minHeight, data: [{ id, content, rowspan, colspan, background, backgroundColor, verticalAlign, defaultFontSize, ... }] }]`。最稳妥的创建方式：复制一个现有表格元素（`duplicateElement`）再改 `tableData`。

## 4. 文本样式模板（与产品风格一致，实测可用）

### 一级标题（橙色粗体 20px 江城圆体）
```js
payload: {
  content: '<p><b class="cmihee-bold" data-weight="600" style="font-weight: 600; color: rgb(211, 94, 15); font-size: 20px; font-family: num-江城圆体, en-江城圆体, zh-江城圆体;">学习目标</b></p>',
  left: 75, top: 20, width: 180, height: 32,
  adaptive: 'width', defaultFontSize: 20, defaultFontName: '江城圆体',
  defaultFontWeight: 600, wordSpace: 1.8
}
```

### 正文（思源黑体 CN 16px，行高 1.6，自适应高度）
```js
payload: {
  content: '<p style="margin: 0 0 4px 0;"><span style="font-family: &quot;num-思源黑体 CN&quot;, &quot;en-思源黑体 CN&quot;, &quot;zh-思源黑体 CN&quot;; font-size: 16px; color: rgb(51, 51, 51);">正文内容</span></p>',
  left: 75, top: 70, width: 644, height: 110,
  adaptive: 'height', defaultFontSize: 16, defaultFontName: '思源黑体 CN',
  defaultFontChinese: '思源黑体 CN', defaultFontEnglish: '思源黑体 CN', defaultFontNumber: '思源黑体 CN',
  lineHeight: 1.6
}
```

### 强调色
- 一级标题橙：`rgb(211, 94, 15)`；辅助橙：`rgb(234, 121, 45)`；正文深灰：`rgb(51, 51, 51)`；错误红：`rgb(255, 30, 2)`。
- 字体族写法：`num-思源黑体 CN, en-思源黑体 CN, zh-思源黑体 CN`；英文常用 `num-Times New Roman, en-Times New Roman, zh-楷体`。

## 5. 修改元素（updateElement）

```js
// 改文本内容 + 位置 + 字号
await b.updateElement({
  elementId: 'xxxx',
  patch: {
    content: '<p>新内容</p>',
    left: 100, top: 80, width: 400,
    defaultFontSize: 18
  }
})
// 移动 / 缩放 / 旋转（专用方法，语义更清晰）
await b.moveElement({ elementId: 'xxxx', x: 120, y: 60 })
await b.resizeElement({ elementId: 'xxxx', width: 500, height: 80 })
await b.rotateElement({ elementId: 'xxxx', angle: 15 })
```

- `duplicateElement` 自动在 (left+20, top+20) 生成副本；组元素复制时组内 id 同步重生成。
- `orderElement` 的 position 映射：front→置顶、forward→上移一层、backward→下移一层、back→置底。

## 6. 打组 / 解组

```js
const r = await b.groupElements(['elA', 'elB'])   // 至少 2 个元素，返回 { groupId }
await b.ungroup(r.groupId)                         // 解开组，子元素回到区块顶层
```

- 打组基于当前选中集合，组内元素 `groupId` 自动同步；组元素本身是 `type: 'group'` 的容器。
- 组内子元素坐标相对组：移动组 = 批量移动子元素。

## 6.5 表格操控（数据模型与流程）

表格元素（type=table）是结构化数据，不要当普通元素打 patch。先读、再改、后核对。

**数据模型**：`tableData` 是展开网格（每行 `{ minHeight, data: [cell...] }`，`data` 长度 = 列数）。单元格 `{ id, content(HTML), rowspan, colspan, background, backgroundColor, ... }`；合并单元格用 `rowspan>1 / colspan>1` 表示起点，被覆盖位置是 `rowspan=0 / colspan=0` 的占位格（内容为空）。行列宽高在 `widths` / `heights` 数组。

**索引规则**：所有 row/col 都是 **0 基**（grid 里的坐标），与 `data` 数组下标一一对应。

| 方法 | 参数 | 说明 |
|------|------|------|
| `getTableGrid({ tableId })` | - | **首选读取**：返回 `{ rows, cols, grid: [[{ row, col, id, rowspan, colspan, isOrigin, isCovered, origin, content(纯文本), contentHtml, backgroundColor }]], mergedCells }` |
| `getTableInfo({ tableId })` | - | 结构信息：行列数、widths/heights、mergedCells、边框/行列样式 |
| `setTableCellContent({ tableId, row, col, content })` | 0 基 | 写单元格内容（HTML 字符串；纯文本也可渲染） |
| `setTableCellBackground({ tableId, row, col, background })` | 0 基 | 写背景色；传空串/null 清除 |
| `setTableData({ tableId, tableData })` | - | 整表数据替换（结构必须完整） |
| `updateTable({ tableId, patch })` | - | 整表字段合并（widths/heights/borderColor 等） |
| `insertTableRow({ tableId, index })` / `deleteTableRow({ tableId, index, count? })` | 0 基 | 插入/删除行（自动处理合并跨行） |
| `insertTableColumn({ tableId, index })` / `deleteTableColumn({ tableId, index, count? })` | 0 基 | 插入/删除列（自动处理合并跨列） |
| `mergeTableCells({ tableId, startRow, startCol, endRow, endCol })` | 0 基含边界 | 合并矩形区域（区域内不能有既有合并/被覆盖格） |
| `splitTableCell({ tableId, row, col })` | 0 基 | 拆分合并格（必须传合并起点格坐标） |
| `fitTableHeights({ tableId, waitMs?=2000, minHeight?=30 })` | - | 行高自适应：按单元格实际内容高度重算每行最小高度并写回 `heights`（等效逐行拖拽收缩），自动处理 rowspan 合并单元格 |

```js
// 标准流程：读 → 改 → 核对
const g = await b.getTableGrid({ tableId: "V3MFeGf4Pi" })
g.grid.forEach(row => console.log(row.map(c => c.content).join(" | ")))
await b.setTableCellContent({ tableId: "V3MFeGf4Pi", row: 4, col: 4, content: "/ɡrəʊ ʌp/" })
await b.insertTableRow({ tableId: "V3MFeGf4Pi", index: 2 })
await b.getTableGrid({ tableId: "V3MFeGf4Pi" })   // 核对
```

注意：
- 被合并覆盖的格子（`isCovered: true`）不可写内容，写合并起点格（`isOrigin: true`）。
- 行列增删/合并拆分是**结构操作**，改动前先 `checkpoint()`，出错 `rollback()`。
- 删除行/列时若覆盖到合并格，算法自动调整 rowspan/colspan（与编辑器右键菜单同语义）。
- 行高只增不减：编辑器对内容变高自动撑大行高，但变瘮不收缩。字号/内容缩小后（如统一缩放字号），用 `fitTableHeights` 收紧行高，避免留下大片空白；表格缩短后注意同区块内其他元素（如底部图片）是否需要随之调整位置。

﻿## 6.6 思维导图操控（数据模型与流程）

思维导图元素（type=mind）是结构化数据：`element.content` 是 **kityminder JSON 字符串**，不要当普通文本打 patch。先读、再改、后核对。

**数据模型**：

```js
// element.content = JSON.stringify({
//   root: 节点树, template: 'right', theme: 'mind-default', version, connectColor
// })
// 节点：{ data: { id, text(HTML), type, ...样式 }, children: [子节点...] }
//   id     节点唯一标识（kityminder getNodeById 依赖 data.id，新增节点桥接自动生成）
//   text   Quill HTML（如 '<p>中心主题</p>'；纯文本写入会自动包 <p>）
//   type   0=中心主题，1=分支主题
//   样式   defaultFontSize / defaultFontWeight / defaultFontStyle / defaultColor / totalDefaultFontFamily / background
```

**布局模板**：`default` `right` `left` `right_angle` `default_angle` `left_angle` `orthogonal`
**主题**：`mind-default` `retro` `youth` `minimalist` `black`

| 方法 | 参数 | 说明 |
|------|------|------|
| `getMindTree({ mindId })` | - | **首选读取**：返回规范节点树 `{ nodeCount, depth, template, theme, root: { id, text(纯文本), textHtml, type, depth, path, attrs, children[] } }`，`attrs` 含 color/background/fontsize/bold/italic/fontFamily/note/image/hyperlink/priority/progress/expandState |
| `getMindData({ mindId })` | - | 原始数据：`{ template, theme, version, connectColor, root }`（节点为原始形状，适合整体备份） |
| `setMindNodeText({ mindId, nodeId, text })` | 节点 id | 改节点文本；纯文本自动包 `<p>`，已含标签原样保留 |
| `updateMindNode({ mindId, nodeId, patch })` | 节点 id | 改样式/附加数据：`color/fontsize/bold/italic/fontFamily/background/note/image/hyperlink/priority/progress/expandState`；`bold:true`→粗体、`italic:true`→斜体、`color`→defaultColor+color；传 `null`/空串删除该字段 |
| `addMindNode({ mindId, nodeId, position?, text?, index?, data? })` | position: `child`(默认)/`sibling` | 新增节点；`nodeId` 省略时 child 挂到中心主题；返回新 `nodeId` |
| `deleteMindNode({ mindId, nodeId })` | 节点 id | 删除节点（中心主题不可删，整图替换用 `setMindData`） |
| `setMindData({ mindId, content })` | 对象或 JSON 字符串 | 整图替换 `{ root, template?, theme? }`；自动补齐节点 id |
| `setMindTemplate({ mindId, template })` / `setMindTheme({ mindId, theme })` | 模板名/主题名 | 切换整体布局与配色 |

```js
// 标准流程：读 → 改 → 核对
const t = await b.getMindTree({ mindId: "xxx" })          // 先读树，拿节点 id
t.root.children[0].text                                    // 一级主题文本
await b.setMindNodeText({ mindId: "xxx", nodeId: t.root.children[0].id, text: "新主题" })
await b.addMindNode({ mindId: "xxx", nodeId: t.root.id, text: "分支1" })
await b.updateMindNode({ mindId: "xxx", nodeId: "y", patch: { color: "#d14424", bold: true, fontsize: 18 } })
await b.getMindTree({ mindId: "xxx" })                     // 核对
```

注意：
- 节点 id 来自 `getMindTree` 返回的 `id`/`path`；不要猜 id。
- 结构操作（增删节点、整图替换）前先 `checkpoint()`，出错 `rollback()`。
- 节点文本是 HTML：要加粗/变色请写在文本 HTML 的 style 里，或节点级用 `updateMindNode` 的 patch（作用于整个节点）。
- 改完 content 后 MindElement 会自动重新导入渲染，元素尺寸会随内容自动适配。

﻿## 6.7 文本操控（数据模型与自适应机制）

文本元素（type=text）内容修改后**宽高会自动适应**，但效果取决于 `background.extendType` 与尺寸约束，且**同组内其他元素可能被联动位移**。AI 控制时要先读、再改、后核对。

**自适应规则（与 TextElement 组件一致）**：

| extendType | 效果 |
|------|------|
| `both`（默认） | 宽、高都随内容自动调整（内容变多变宽，变少变窄） |
| `horizontal` | 仅宽度随内容伸缩（背景图为九宫格时高度锁定为背景图高度） |
| `vertical` | 仅高度随内容伸缩（宽度保持不变，文字自动换行） |
| `none` | 不自动调整（保持手动设置的宽高） |

**尺寸约束**：
- `maxWidth` / `maxHeight`（非 `∞`）为上限，内容超出时封顶。
- 背景为图片（`background.type === 'image'`）时，`background.width/height` 为下限。
- 内边距 `paddingTop/Bottom/Left/Right` 计入自适应尺寸。

**组内联动**：元素在组（`groupId` 非 0）内时，正下方（垂直+水平重叠）的组内元素随高度变化自动下移、右侧元素随宽度变化自动右移，区块高度联动；组外元素不受影响。联动由编辑器组件自动完成，桥接方法会返回 `moved` 位移列表供核对。

| 方法 | 参数 | 说明 |
|------|------|------|
| `getTextInfo({ elementId })` | - | **首选读取**：内容/纯文本/字数、字体、背景与 extendType、maxWidth/maxHeight、内边距、几何、groupId |
| `setTextContent({ elementId, content, fitSize? })` | HTML 或纯文本 | 改内容（纯文本自动包 `<p>`，`\n` 自动拆成多段）并触发自适应；返回新宽高 + `moved` 位移列表 |
| `setTextAdaptive({ elementId, extendType, fitSize? })` | both/horizontal/vertical/none | 切换自适应模式并重算尺寸 |
| `fitTextSize({ elementId })` | - | 强制重测尺寸（内容没变但尺寸异常、改样式后想重新适应时用） |

```js
// 标准流程：读 → 改 → 核对
const info = await b.getTextInfo({ elementId: "xxx" })
info.background.extendType                                 // 当前自适应模式（both/horizontal/vertical/none）
const r = await b.setTextContent({ elementId: "xxx", content: "更长的正文内容……" })
r.autoResized                                              // 是否发生了宽高变化
r.moved                                                    // 同组内被联动位移的元素 [{ id, dTop, dLeft, ... }]
// 想固定宽度、只让高度随内容长高：
await b.setTextAdaptive({ elementId: "xxx", extendType: "vertical" })
await b.setTextContent({ elementId: "xxx", content: "多行文本\n第二行" })
```

注意：
- 改文本前先 `checkpoint()`；结构可能连锁变化（宽高 + 组内位移 + 区块高度），出错 `rollback()`。
- `fitSize` 默认 true；如果只想改内容不重排（如先批量写入再统一适应），传 `fitSize: false`。
- 内容含公式/图片时自适应同样生效（隐藏测量层与编辑渲染一致）。
- `moved` 是操作前后同区块元素的几何 diff，包含组内位移；非组内元素不会联动。

## 6.8 文本操控验证记录（2026-08-01 真实画布实测）

> 以下结论在真实画布（区块内文本元素、fontSize 14、lineHeight 1.5）实测得出；字体/行距/字号不同时数值会变化，但行为规则一致。

**换行行为**
- `setTextContent` 纯文本按 `\n` 自动拆成多段 `<p>`（每行一个段落，与编辑器 Quill 输出一致）；不要再依赖单个段落内嵌 `<br>` 实现换行。
- 多行时 `horizontal` 宽度按**最长一行**计算；`vertical` 高度按**行数 × 行高**增长（实测 4 行 → 高度 84，单行约 21）。
- 空文本在 `vertical`/`both` 下会收缩到约一行高度（实测约 21），属正常行为。

**自适应模式差异（实测）**
| extendType | 实测行为 |
|------|------|
| `both`（默认） | 宽高都随内容，内容变多变宽同步扩展 |
| `horizontal` | 仅宽度随内容伸缩（取最长行），高度锁定（实测宽 120→476→840，高始终不变） |
| `vertical` | 仅高度随内容伸缩（行数 × 行高），宽度锁定（实测高 21→84，宽始终不变） |
| `none` | 不自动调整，保持手动宽高 |

**组内联动（实测）**
- 组内（`groupId` 非 0）正下方元素随文本高度变化**同量下移**（实测文本高 +54 → 下方图形 top +54）；组内右侧元素随宽度变化右移。
- 组外元素不受影响（实测同区块组外元素坐标零变化）。
- 三个方法返回的 `moved` 列表即全部受影响元素（含自身），可直接核对 `dLeft/dTop/dWidth/dHeight`。

**使用建议**
- 需要"先批量写内容、再统一适应"时：多次 `setTextContent(..., { fitSize: false })`，最后 `fitTextSize()` 一次重测。
- 改内容/模式后尺寸未按预期变化，优先检查：① `getTextInfo().background.extendType` 是否生效；② 是否设置了 `maxWidth/maxHeight` 上限；③ 背景图为 image 时的宽高下限约束。

## 7. 常见坑

- 元素 id 参数都是**标量**；`updateElement({ elementId, patch })` 的 patch 是**浅合并**，嵌套对象（如 background/outline）需整体传入。
- 文本 `content` 是 HTML 字符串，直接写纯文本会丢失样式但可渲染；换行可直接用 `\n`（自动拆成多段 `<p>`），需要精确样式时手写 `<p>` HTML。
- 添加元素后立即 `getSlide` 核对；渲染验证见 `super-editor-canvas` 的滚动核对方法。
- 不要绕过桥接直接改 Vuex（会破坏操作日志与编辑器状态）；回退只走 `checkpoint()` / `rollback()` 快照。

## 8. MCP 工具对照

| 桥接方法 | MCP 工具 |
|---------|---------|
| `addElement` | `editor_add_element` |
| `updateElement` | `editor_update_element` |
| `deleteElement` | `editor_delete_element` |
| `groupElements` / `ungroup` | `editor_group_elements` / `editor_ungroup` |
| `orderElement` | `editor_order_element` |
| `getTableInfo` / `getTableGrid` | `editor_table_info` |
| `setTableCellContent` / `setTableCellBackground` | `editor_table_set_cell` |
| `updateTable` | `editor_table_update` |
| `insertTableRow` / `deleteTableRow` / `insertTableColumn` / `deleteTableColumn` / `mergeTableCells` / `splitTableCell` | `editor_table_structure` |
| `getMindData` / `getMindTree` | `editor_mind_info` |
| `setMindNodeText` / `updateMindNode` | `editor_mind_set_node` |
| `addMindNode` / `deleteMindNode` | `editor_mind_structure` |
| `setMindData` / `setMindTemplate` / `setMindTheme` | `editor_mind_update` |
| `getTextInfo` | `editor_text_info` |
| `setTextContent` | `editor_text_set_content` |
| `setTextAdaptive` | `editor_text_adaptive` |
| `fitTextSize` | `editor_text_fit` |
| 其余（move/resize/rotate/duplicate） | `editor_rpc_call` |