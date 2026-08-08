# 媒体模块工作流

适用于音频（77）、视频（78）、智能课件（79）、打印/下载文件（84）及其他需要文件信息的数字模块。

## 输入来源

优先级：

1. 已从编辑器素材库取得的合法 URL、文件 ID 和名称。
2. AI 已生成并落盘的本地文件。
3. 用户明确提供的外部 URL。

不要把本地磁盘路径直接写入数字模块配置，学生端无法访问该路径。

## 显式上传

```json
{
  "filePath": "D:\\assets\\lesson.mp3",
  "fileName": "课文朗读.mp3",
  "mimeType": "audio/mpeg",
  "kind": "audio"
}
```

调用 `editor_upload_file` 后得到类似：

```json
{
  "url": "https://.../lesson.mp3",
  "fileId": "12345",
  "fileName": "课文朗读.mp3",
  "mimeType": "audio/mpeg"
}
```

将返回对象按 `editor_list_digital_module_types` 的实时 Schema 写入模块 `config`。不得根据本地文件名伪造 `fileId` 或 URL。

`editor_upload_file` 也接受 `data`（base64/dataURL），与 `filePath` 二选一。`kind` 可为
`image/audio/video/document/other`。本地文件通过 RPC 内联传输，当前主动限制约 70MB；更大的文件应先使用产品已有的大文件上传或素材库流程。

## 创建/更新时便捷上传

`editor_create_digital_module` 和 `editor_update_digital_module` 支持：

- `mediaPath`
- `mediaFileName`
- `mediaMimeType`

MCP 会先上传文件，删除这些本地字段，再把上传结果放入 `config.uploadedFile` 交给类型适配器。例如：

```json
{
  "elementId": "play-button-id",
  "type": 77,
  "name": "播放课文朗读",
  "mediaPath": "D:\\assets\\lesson.mp3",
  "config": {}
}
```

`validateOnly: true` 与 `mediaPath` 互斥，工具会拒绝这种组合。需要验证媒体配置时，先调用
`editor_upload_file`，再把真实上传结果按实时 Schema 放入 `config`；不要为了预检重复上传。

## 音频

- 至少需要可访问的音频 URL；适配器要求文件 ID、时长等字段时使用真实资源元数据。
- 名称描述内容而不是格式，例如“播放课文朗读”，不要只写“MP3”。
- 时长未知时不要伪造；先让上传/素材信息补齐，或按实时 Schema 允许省略。

## 视频

- 使用视频文件 URL，不要误用视频封面 URL。
- 缩略图、尺寸、时长只有在资源真实提供时才填写。
- 本地 MP4/WEBM/MOV 可通过通用上传；其他格式先确认浏览器和学生端支持。

## 智能课件与文档

- 智能课件通常还要求资源 GUID 或可预览地址，单纯上传任意 PPTX 不一定等价于已发布课件资源。
- 打印/下载模块应使用后端可访问的 PDF/文档 URL，而不是本地路径。
- 资源仍在异步生成时先等待完成，确认 URL 可用后再创建数字模块。

## 验证

1. 上传后检查 `url`、`fileId`、`fileName` 和 MIME。
2. 创建模块后调用 `editor_get_digital_module`，确认规范化配置引用同一资源。
3. 若任务还包含页面排版，最后按画布流程保存；媒体数字模块关系本身已即时持久化。
