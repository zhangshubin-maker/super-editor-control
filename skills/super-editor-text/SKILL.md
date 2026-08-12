---
name: super-editor-text
description: 超媒编辑器（super-editor-control 插件）的富文本技能。用户要求读取、搜索、新增、替换、删除、批量改写或格式化普通文本元素、表格单元格或思维导图节点文字，修改字符区间、段落、列表、字体、字号、颜色、对齐、间距、缩进，复制文本样式，设置独立文本框背景/内边距/横竖排/自适应/溢出，检查裁切和适配，或安全处理公式、图片、拼音、超链接等文本内嵌结构时使用。覆盖 editor_text_info、editor_text_document、editor_text_set_content、editor_text_set_style、editor_text_edit、editor_text_set_link、editor_text_remove_link、editor_text_edit_embed、editor_text_format、editor_text_set_layout、editor_text_inspect_layout、editor_text_fit、editor_text_fit_to_box、editor_text_search、editor_text_copy_style、editor_text_fonts。
---
# Super Editor Text（富文本控制）

执行写操作前读取公共[任务策略](../super-editor-control/references/task-policy.md)。公共策略决定
micro/current/book 范围、checkpoint 和保存；本技能的领域步骤不能把明确 micro 修改升级为整页流程。

把文本当作“文档结构 + 文本框”操作，不要把它当作一段可随意覆盖的 HTML。局部改字、改格式和查找替换优先使用结构化工具；只有明确要整体重写时才使用 `editor_text_set_content`。

## 1. 统一目标与标准工作流

Bridge 1.6.0 起，内容级工具同时支持普通文本、表格单元格和思维导图节点。每次调用只传 legacy
`elementId` 或统一 `target` 之一：

```json
{ "elementId": "text-1" }
{ "target": { "kind": "element", "elementId": "text-1" } }
{ "target": { "kind": "tableCell", "tableId": "table-1", "cellId": "cell-1" } }
{ "target": { "kind": "tableCell", "tableId": "table-1", "row": 0, "col": 1 } }
{ "target": { "kind": "mindNode", "mindId": "mind-1", "nodeId": "node-1" } }
```

- `tableCell` 必须传 `tableId`，并用 `cellId` 或 0-based `row+col` 定位；两种方式同时给出时必须指向
  同一单元格。被合并覆盖的格不可操作。
- `mindNode` 必须传 `mindId+nodeId`。节点 id 不唯一时 Bridge 拒绝操作，不能猜目标。
- `editor_text_info`、`editor_text_document`、`editor_text_set_content`、`editor_text_set_style`、
  `editor_text_edit`、`editor_text_set_link`、`editor_text_remove_link`、`editor_text_edit_embed` 和
  `editor_text_format` 支持上述统一
  目标。返回值含外层 `elementId`、规范化 `target`、`targetKind`、`layoutOwner` 和
  `standaloneLayoutSupported`；后续写入应复用返回的规范化 `target`。
- `editor_text_adaptive`、`editor_text_fit`、`editor_text_set_layout`、
  `editor_text_inspect_layout` 和 `editor_text_fit_to_box` 涉及文本框几何，只支持独立文本元素的
  legacy `elementId`。不要把表格或思维导图外层 id 当普通文本框调用。

标准工作流：

1. 调用 `editor_text_document({ elementId })` 或 `editor_text_document({ target })`，读取 `plainText`、`paragraphs`、`runs`、`embeds`、`hyperlinks`、`defaultStyle`、`layout` 和 `contentHash`；需要定位差异时再看 `htmlHash`、`hyperlinkMetadataHash`。
2. 按公共策略判断风险：单一 target 的局部编辑默认不打整页 checkpoint；批量重写、组内连锁布局或复杂
   embed 变更才建立一次 checkpoint。批量内容编辑先用支持它的工具传 `dryRun: true` 预览命中范围。
3. 普通内容变化调用 `editor_text_edit`；超链接调用 `editor_text_set_link` 或
   `editor_text_remove_link`；公式、拼音和内嵌图片调用 `editor_text_edit_embed`；其他格式变化调用
   `editor_text_format`；只有独立文本元素的文本框外观和约束调用 `editor_text_set_layout`。
4. 内容与可见格式写入时传刚读取的 `expectedContentHash`，防止覆盖用户在此期间对正文或链接参数的修改。该 hash 联合覆盖 canonical HTML 与稳定排序后的 `hyperlinkParamList`，不能用 `htmlHash` 代替；`editor_text_format` 同时支持 `expectedContentHash + dryRun`。
5. `editor_text_set_layout` 和 `editor_text_fit` 不改文本内容，不接受 `expectedContentHash/dryRun`；`editor_text_fit_to_box` 会改字号，接受 `expectedContentHash` 但不接受 `dryRun`。
6. 独立文本元素调用 `editor_text_inspect_layout` 核对溢出、裁切、自适应和稳定状态；需要时再选择 `editor_text_fit` 或 `editor_text_fit_to_box`。嵌套目标以内容复读和外层表格/思维导图截图核对。
7. 用相同 selector 调用 `editor_text_document` 复读结果。只有内容影响尺寸、外层表格/思维导图或视觉时
   才滚动截图；当前页 dirty 时调用 `editor_save_verified(scope=current)`。只有本次确实建立过 checkpoint
   且需要恢复时才调用 `editor_rollback({ checkpointId })`。

## 2. 索引与目标范围

- `index` / `length` 使用 UTF-16 / Quill 索引；中文通常长度 1，部分 emoji 长度 2，公式、图片、拼音等内嵌对象长度按 1 计算。
- `plainText/displayText` 是给 AI 阅读的可见文本，拼音框会展开为 `word`；`indexText` 保持 Quill 的
  U+FFFC 占位，`displayIndexMap` 映射两套坐标。存在展开的 embed 时，不能把 plainText 下标直接当 index。
- 不要根据肉眼字符数猜索引。始终从 `paragraphs`、`runs`、`embeds` 或
  `editor_text_search` 返回的 `index/length` 读取写入范围；搜索的 `displayIndex/displayLength` 只用于展示。
- `occurrence` 从 1 开始。相同文字出现多次时必须指定 occurrence，或用 index/length 精确定位。
- `scope=default` 只改文本元素默认样式，不保证覆盖已有内联格式。
- `scope=all/range/match/paragraph` 才修改可见富文本内容；段落范围优先使用 `paragraphIndexes`，其值是来自 `editor_text_document.paragraphs[].index` 的 **0-based** 下标。

## 3. 内容编辑

### 按范围替换并保留周围格式

```json
{
  "elementId": "text-1",
  "action": "replace",
  "index": 8,
  "length": 4,
  "text": "新标题",
  "expectedContentHash": "读取到的 contentHash",
  "fitSize": true
}
```

### 按文字查找替换

```json
{
  "elementId": "text-1",
  "action": "findReplace",
  "match": "旧术语",
  "text": "新术语",
  "occurrence": 1,
  "caseSensitive": false,
  "dryRun": true
}
```

- `action`：`insert`、`replace`、`delete`、`findReplace`。
- `insert` 必须传 `index`；`replace/delete` 必须传 `index+length`。只有 `findReplace` 使用
  `match+occurrence`；`text` 与 `html` 二选一。
- 新内容优先传 `text`；确实需要插入富文本结构时才传 `html`。`findReplace` 省略二者即删除匹配。
- 按索引删除使用 `action=delete`；按文字删除使用无替换内容的 `action=findReplace`。
- 需要完全重写整个文本框时才调用 `editor_text_set_content`；必须带最新 `expectedContentHash`，先用
  `dryRun=true` 检查规范化结果。重写前检查并处理超链接、公式、图片、拼音等 embeds。

## 4. 字符、段落和列表格式

调用 `editor_text_format`，用一个工具组合多项格式：

```json
{
  "elementId": "text-1",
  "scope": "range",
  "index": 0,
  "length": 6,
  "formats": {
    "fontSize": 24,
    "fontChinese": "思源黑体 CN",
    "fontEnglish": "Arial",
    "fontNumber": "Arial",
    "color": "#D35E0F",
    "bold": true
  }
}
```

常用字符格式：

- 字体：`fontName`、`fontChinese`、`fontEnglish`、`fontNumber`。先调用 `editor_text_fonts` 核对可用字体。
- 基础：`fontSize`、`color`、`background`、`bold`、`fontWeight`、`italic`。
- 扩展：`script`、`underline`、`strike`、`wave`、`emphasis`、`deleteBox`。

常用段落格式：

- `align`、`justifyLast`、`lineHeight`、`letterSpacing`、`wordSpace`。
- `paragraphBefore`、`paragraphAfter`、`paragraphSpacing`、`indent`、`textIndent`。
- `list` 使用编辑器已有的列表配置对象；修改前保留 `editor_text_document` 返回的未知列表字段。

清除格式时只修改目标字段，不要传一整份空 formats 覆盖其他样式；仅在该工具 schema 明确允许时传
`null` 或 `false`。例如部分布尔型内联格式可传 `false`，但 `editor_text_set_style` 的 `fontSize`、
`fontName` 等字段不接受 `null`，应改成有效值或改用允许清除该格式的范围格式工具。

`editor_text_set_style` 只改默认字体/字号/颜色/粗斜体/行距/字距等字段。对齐、列表、下划线、
背景等可见格式必须用 `editor_text_format`，不要把它们传给默认样式入口。

## 5. 超链接和内嵌对象

### 原子设置超链接

```json
{
  "elementId": "text-1",
  "index": 0,
  "length": 4,
  "hyperlink": {
    "input_type": 1,
    "link_mode": 1,
    "jump_type": 1,
    "link_address": "https://example.com",
    "agent_id": 0,
    "agent_params": []
  },
  "expectedContentHash": "读取到的 contentHash",
  "dryRun": true
}
```

- 优先复用 `editor_text_document.hyperlinks[].metadata`；复用已有 `hyperlinkId` 时，可只传 id。
- 新链接的 `hyperlink.hyperlink_id` 可以省略，由 Bridge 生成；必须以返回的 `hyperlinkId`（以及 `hyperlink.hyperlink_id`）为准保存或继续操作，不能预判生成值。
- 表格单元格或思维导图节点可能与兄弟目标共享同一 `hyperlinkId`。若只修改当前目标的链接 metadata，
  Bridge 会返回 `TEXT_HYPERLINK_SHARED`，避免连带改变兄弟目标；此时省略 `hyperlinkId`，用完整
  `hyperlink` 新建当前目标专属链接，不要修改共享记录。
- 新 URL 链接使用 UI 已确认的字段：`input_type=1`、`link_mode=1`、`jump_type=1`、非空
  `link_address`、`agent_id=0`、`agent_params=[]`。
- 智能体链接使用 `jump_type=2`，且必须来自真实选择结果的非零 `agent_id` 和 `agent_params`；不能猜。
- 移除时调用 `editor_text_remove_link`，按 `hyperlinkId` 清除全部同 id 范围，或同时传
  `index+length` 只清除指定范围。

### 原子编辑公式、拼音和内嵌图片

```json
{
  "elementId": "text-1",
  "action": "insert",
  "index": 4,
  "embedType": "pinyinBox",
  "value": { "pinyin": "hǎo", "word": "好" },
  "expectedContentHash": "读取到的 contentHash",
  "dryRun": true
}
```

- `formulaMath` 的 value 是 LaTeX 字符串或 `{ "latex": "..." }`。
- 插入 `pinyinBox` 必须同时包含非空 `pinyin` 与单个中文字符 `word`；更新时可只传其中一个字段，
  Bridge 会与当前 value 合并。它在 Quill 索引中长度始终为 1。
- 插入 `image` 可传 URL 字符串；需要保留图片结构时传完整 ImageBot 对象。支持字段：`url`、
  `width/height`、`originalWidth/originalHeight`、`rotate`、`opacity`、`flip`、
  `outlineWidth/outlineColor/outlineStyle`、`verticalAlign`、`offsetX/offsetY`。更新时可只传这些字段的
  子集并与当前 value 合并；不要传 CSS `style` 代替结构字段。可先上传或查素材库取得 URL。
- `insert` 需要 `embedType+value`，`update` 需要 `value`（embedType 可由当前位置推断），`delete` 不传 value。
- 页面未注册对应自定义 blot 或现有内容不能安全往返时，Bridge 会明确拒绝。不要退回正则改 HTML。

## 6. 文本框布局与两种适配

用 `editor_text_set_layout` 修改文本框级属性：

- 自适应：`extendType=both/horizontal/vertical/none`。
- 约束：`maxWidth`、`maxHeight`、`overflowType`。
- 内边距：`paddingTop/Bottom/Left/Right`。
- 排版方向：`textAlign`、`verticalAlign`、`vertical`、`vAlignBottom`。
- 外观：`background`、`outline`、`shadow`、`borderRadius`。
- 溢出：`overflowType` 传由 `auto`、`overWithBreak`、`overSizeScroll` 组成的数组或 `null`。
- 填充：`fill` 传 `{ enabled?, color? }`；`null` 表示禁用并清空，清除颜色也可传
  `{ color: null }`；不要直接传颜色字符串。

嵌套对象会与现值深合并；只传需要修改的键。不要用 `editor_update_element` 整体覆盖 `background`、`outline` 或 `shadow`。

区分两种适配：

- `editor_text_fit`：保持字号，让文本框按照 `extendType` 适应内容。
- `editor_text_fit_to_box`：保持文本框宽高，在 `minFontSize/maxFontSize` 范围内缩小字号；即使当前未溢出，
  当前字号高于显式 `maxFontSize` 时也会降到允许范围。调用时传最新 `expectedContentHash`，但不要传 `dryRun`。
- 如果文本包含混合字号或不可解析字号，`editor_text_fit_to_box` 默认零写入并返回
  `reason=mixed-font-sizes`、`fontSizes`、`invalidFontSizes`、`requiresExplicitUniformization=true`。
  只有用户明确同意把原有混合字号统一为单一字号后，才重试并传
  `allowUniformizeMixedSizes=true`；否则保留原排版。成功统一后检查 `uniformizedMixedSizes=true`。

执行后检查返回的 `moved`。组内文本尺寸变化可能推动下方或右侧元素。嵌套目标的内容写入可能已完成，
但 Bridge 无法独立验证表格/思维导图领域布局，此时可返回 `rendered=true`、`settled=false`、
`deferredLayout=true`；这不是布局已稳定的证明，必须复读内容并截图检查外层元素。

## 7. 搜索、字体和样式复制

- `editor_text_search` 在当前已加载目录中搜索可见文本（含拼音 word）。`targetKinds` 默认
  `['element','tableCell','mindNode']`，可显式缩小范围；返回 `target/targetKind`、外层
  `elementId`、blockId、上下文、可写入的 `index/length` 和仅供展示的
  `displayIndex/displayLength`。替换前用返回的 `target` 再次读取目标。
- `editor_text_fonts({ language })` 查询 `all/chinese/english/number` 可用字体；不要凭空写字体名。
- `editor_text_copy_style` 的 source 从 `sourceElementId/sourceTarget` 二选一，targets 从
  `targetElementIds/targetTargets` 二选一；source 与 targets 两侧可分别混用 legacy/统一形式。嵌套目标只支持
  `scope=default/character/paragraph`；`layout/all` 涉及独立文本框几何，遇到嵌套目标会返回
  `TEXT_LAYOUT_TARGET_UNSUPPORTED`。复制后逐项复读内容并检查外层布局。

## 8. 安全规则

- 不直接正则改 HTML；不依赖当前光标、UI 选区或鼠标键盘模拟。
- 不用 `editor_update_element` 写 `content`、`hyperlinkParamList` 或字数统计；Bridge 会返回
  `TEXT_SPECIALIZED_UPDATE_REQUIRED`。几何位置和默认样式等通用字段仍可走通用更新。
- 不把默认样式等同于可见样式；已有 span/run 的内联格式优先级更高。
- 不破坏 `hyperlinkParamList`、拼音、列表层级、公式/图片 embeds、任意 `data-*`、answer-tag、phoneme
  及图片尺寸/样式属性。发现未知 embed/blot 时先只读，不整体重写。
- 写入后以 Bridge 返回的规范化内容为准，不以输入 HTML 为准。
- Bridge 会用生产 Quill/`convertHTML` 最多稳定化 5 轮。HTML 形态不同但文本顺序、有效样式、内嵌对象
  和超链接语义一致时可安全通过；不要因标签嵌套、属性顺序或连续 run 切分差异自行降级为纯文本。
  若真实语义变化或返回 `TEXT_CANONICALIZATION_UNSTABLE`，停止写入并保留原内容，不要绕过检查。
- 独立文本框若 `settled=false`、`needResetSize=true` 或检查结果仍有 overflow，不要直接保存；先重新定位、
  重测或回滚。嵌套目标若 `deferredLayout=true`，用所属表格/思维导图截图完成领域布局核对。
- 批量替换先 dry run，核对命中数与上下文，再执行实际写入。

## 9. 工具对照

| MCP 工具 | Bridge 方法 | 用途 |
|---|---|---|
| `editor_text_info` | `getTextInfo` | 三类目标的轻量富文本摘要 |
| `editor_text_document` | `getTextDocument` | 三类目标的结构化富文本读取 |
| `editor_text_set_style` | `formatText(scope=default)` | 设置默认字体和基础样式 |
| `editor_text_edit` | `editText` | 插入、替换、删除、查找替换 |
| `editor_text_set_link` | `setTextLink` | 原子设置超链接和元数据 |
| `editor_text_remove_link` | `removeTextLink` | 按 id 或范围移除超链接 |
| `editor_text_edit_embed` | `editTextEmbed` | 原子增删改公式、拼音、内嵌图片 |
| `editor_text_format` | `formatText` | 字符、段落和列表格式 |
| `editor_text_set_content` | `setTextContent` | 整体内容替换 |
| `editor_text_set_layout` | `setTextLayout` | 独立文本框布局与外观；仅 elementId |
| `editor_text_inspect_layout` | `inspectTextLayout` | 独立文本框溢出与稳定性检查；仅 elementId |
| `editor_text_adaptive` / `editor_text_fit` | `setTextAdaptive` / `fitTextSize` | 让独立文本框适应内容；仅 elementId |
| `editor_text_fit_to_box` | `fitTextToBox` | 独立固定框缩小字号；仅 elementId，混合字号默认零写入 |
| `editor_text_search` | `searchTextElements` | 当前目录三类目标文本搜索，可传 targetKinds |
| `editor_text_copy_style` | `copyTextStyle` | 支持 sourceTarget/targetTargets 复制文本样式 |
| `editor_text_fonts` | `listTextFonts` | 查询可用字体 |
