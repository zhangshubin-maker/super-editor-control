# 文本布局排障观察

仅在文本适配结果异常、组内元素意外位移或旧页面行为排障时读取。正常富文本工作流以
`super-editor-text` 和实时工具返回为准，不把这里的历史像素值当成跨模板保证。

- `both` 通常同时调整宽高；`horizontal` 只调整宽度；`vertical` 通常固定宽度并调整高度；
  `none` 保持手动宽高。
- 组内文本尺寸变化可能推动其下方或右侧兄弟元素；组外元素通常不联动。以文本工具返回的
  `moved` 几何 diff 为准。
- `maxWidth/maxHeight`、背景图尺寸、内边距和混合字号都会限制适配结果。
- 批量写内容后统一适配时，先完成内容写入，再调用专用 fit/inspect 工具，避免每次写入都重复重排。
- `settled=false`、`needResetSize=true`、overflow 或 `deferredLayout=true` 都不是成功终态；复读内容，
  检查外层表格/思维导图或组，并截图核对。
