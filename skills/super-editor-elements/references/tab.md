# Tab 控件

Tab 不是默认课件创作重点。只有用户明确要求创建、修改或排查 Tab 控件时才处理；不要在一般页面
编写或布局任务中主动引入。

- 先用 `editor_get_element` 读取完整 Tab 数据和当前选中项。
- 当前没有专用 MCP 工具时，通过 `editor_rpc_call` 调用实时 Bridge 提供的 `setTabs` 或
  `setActiveTab`，参数以 `assets/bridge-api-spec.md` 和运行时错误为准。
- Tab 可能关联子画布/区块；写前确认不会误删关联数据，写后走实际预览链路验证切换行为。
- Tab 结构写入按 current 结构性修改处理；相关学生端行为不是静态截图可以证明的。
