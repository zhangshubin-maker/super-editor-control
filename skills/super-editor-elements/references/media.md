# 图片上传与元素使用

优先从本书素材库复用图片；只有用户提供本地文件、AI 已生成资源或素材库无合适结果时才上传。

| 意图 | MCP 工具 |
|---|---|
| 上传本地图片 | `editor_upload_image` |
| 上传并新增图片元素 | `editor_add_image_element` |
| 上传并替换已有图片 | `editor_set_image_src` |
| 搜索/应用素材库图片 | `editor_search_images` / `editor_apply_image` |

MCP-first 例程：

```text
editor_upload_image({ imagePath: "本地绝对路径" })
editor_add_image_element({
  blockId: "block-uuid",
  imagePath: "本地绝对路径",
  left: 120,
  top: 180,
  width: 320
})
```

- 复用上传返回的 URL，不重复上传同一文件。
- 默认保持宽高比；最终尺寸与裁切通过 `super-editor-layout` 检查。
- 上传会生成独立资源，页面 rollback 不会删除上传资源；页面引用仍需保存当前页。
- 替换后复读元素的 `src`，并截图检查加载、比例和裁切。跨域图片可能无法进入截图，必要时走预览链路。
