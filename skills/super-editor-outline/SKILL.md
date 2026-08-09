---
name: super-editor-outline
description: 超媒编辑器大纲技能。在需要读取、新增、重命名、删除、移动排序大纲节点，关联大纲与当前页区块，维护位置/检索锚点，或参考一个目录的大纲生成其他目录大纲时使用。大纲写入立即持久化，不能由页面 checkpoint 回退。
---

# Super Editor Outline

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。大纲是目录级树，不是画布元素；
节点可关联本页 blockId，并可挂载锚点。

## MCP 工具

| 意图 | MCP 工具 |
|---|---|
| 读取当前/指定目录大纲 | `editor_outline_info` |
| 刷新当前页大纲 | `editor_outline_refresh` |
| 新增/重命名/删除节点 | `editor_outline_add` / `editor_outline_rename` / `editor_outline_delete` |
| 移动排序 | `editor_outline_move` |
| 整体替换节点关联区块 | `editor_outline_link_blocks` |
| 选择节点 | `editor_outline_select` |
| 锚点查询/增改删 | `editor_outline_anchor_list` / `editor_outline_anchor_add` / `editor_outline_anchor_update` / `editor_outline_anchor_delete` |

使用 `editor_list_blocks` 获取当前页真实 blockId。`sort` 从 1 开始，`parentId=0` 表示根级；节点 id、
目录 id、区块 uuid 和锚点 id 不能混用。

## 工作流

1. 调用 `editor_outline_info` 读取全量树，核对节点 id、父级、排序和 `content_uuids`。
2. 需要区块关联时调用 `editor_list_blocks`，不要凭名称猜 blockId。
3. 写入一类变更后立即重读大纲；服务端若重排 sort，以返回和刷新结果为准。
4. 删除节点会连带删除其子节点和锚点，必须来自明确意图并先记录受影响树。
5. 大纲写操作立即持久化，不依赖 `editor_save`，也不能由页面 checkpoint/rollback 撤销。

MCP-first 示例：

```text
editor_outline_info({})
editor_outline_add({ name: "一、核心概念", parentId: 0 })
editor_outline_link_blocks({
  outlineId: "真实节点 id",
  blockIds: ["当前页 block uuid"]
})
editor_outline_info({})
```

参数类型以实时 MCP Schema 为准，不把示例中的占位字符串当作真实 id。

## 跨目录生成

1. `editor_outline_info({ slideId: sourceSlideId })` 只读源树和层级规则。
2. 逐个目标目录安全切页；dirty 时传 `saveBeforeSwitch: true`。
3. 刷新目标大纲，根据目标页真实区块建立节点和关联；不要复制源页 blockId。
4. 每个目标目录写后立即重读。大纲写入不是 batch 事务，失败时从最近已核对目录继续。

位置锚点可能由编辑器按关联区块维护；AI 默认只在用户明确需要时管理检索锚点。重要定位行为需走
学生端预览，静态树只能证明数据关系存在。
