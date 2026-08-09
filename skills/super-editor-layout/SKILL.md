---
name: super-editor-layout
description: 超媒编辑器布局调整技能。用户要求移动、缩放、旋转、对齐、分布、重排、修复重叠/越界/裁切、统一间距、调整区块高度，或在文本、表格、思维导图和图片内容变化后重新整理当前页视觉布局时使用。负责局部几何与视觉验证，不改写教学内容；完整当前页创作配合 super-editor-page-authoring。
---

# Super Editor Layout

写前读取公共[任务策略](../super-editor-control/references/task-policy.md)。本技能先解决明确受影响区域，
不会把单元素调整升级为整页或整书重排。

## 1. 读取最小布局上下文

- 已知单元素：`editor_get_element`；只有可能与兄弟冲突时再读所属区块。
- 多元素或一个区块：`editor_get_canvas_tree` 后只分析目标 blockId。
- 目标不明确：`editor_search_elements` 缩小候选，不按名称直接修改重名元素。
- 多元素边界优先调用 `editor_get_elements_bounds({ elementIds, coordinateSpace })`；同块用 `block`，
  跨块必须显式用 `page`。
- `element.left/top` 始终是所属 block 的局部坐标。概念上 page Y 为
  `localTop + blockTemplateListTopMap[blockId]`，但普通任务让 Bridge 完成换算，不自行把整页 Y 写进
  `element.top`。

先记录受影响元素的 id、类型、groupId、left/top/width/height/rotate、层级及区块尺寸。不要凭截图像素
反推坐标。

## 2. 对齐参照与坐标语义

`editor_align_elements` 的 `target` 是对齐参照，`coordinateSpace` 是计算坐标，两者不能混为一谈：

| target | coordinateSpace | 规则 |
|---|---|---|
| `selection` | 同块默认 `block`；跨块必须显式 `page` | 以选择集包围盒为参照；至少两个元素 |
| `block` | 强制 `block` | 只接受同一 owner block；单元素对齐区块时也必须显式写 target |
| `page` | 强制 `page` | 以整页边界为参照；最终仍写回各元素 owner 的 block-local 坐标 |

- 单元素 `target=selection` 会拒绝；根据意图显式选择 `block` 或 `page`，不要默认推成 canvas/page。
- `canvas` 只是旧 Bridge 兼容别名；MCP 文档和新调用统一使用 `page`。
- 跨 block selection 只能显式 `coordinateSpace: 'page'`。Bridge 先用 topMap 在 page space 计算，再分别
  写回各自 owner block 的局部坐标。
- 所有待写位置会在任何写入前统一检查。任一元素将越出自己的 owner block 时，整次操作零写入拒绝；
  不要用逐元素写入绕过。`target=page` 或跨块 selection 因此可能合法计算但被 owner 边界拒绝。
- `editor_set_element_spacing` 和 `editor_center_element_in_block` 只使用同 owner 的 block-local 语义。

`align` 的中文视觉语义：

| align | 含义 |
|---|---|
| `left/right/top/bottom` | 对齐相应边缘 |
| `horizontal` | X 轴中心线对齐，即“水平/左右方向居中”；只左右移动，不是水平等间距 |
| `vertical` | Y 轴中心线对齐，即“垂直/上下一样空”；只上下移动，不是垂直等间距 |
| `center` | X、Y 两轴同时居中，即放到参照区域正中央 |
| `hdengju/vdengju` | 水平/垂直等间距；仅支持 `target=selection`，可在 block 或 page space 计算 |

用户说“上下居中”时，只有目标是上下留白相等才映射为 `vertical`；若是上下排列元素的中心线、边缘或
间距关系，分别选择 `horizontal`、`left/right` 或 `vdengju`，不要直接猜成 `center`。

MCP-first 示例：

```text
# 同一区块内按选择集左边缘对齐
editor_align_elements({
  elementIds: ["a", "b", "c"],
  align: "left",
  target: "selection",
  coordinateSpace: "block"
})

# 跨区块只允许显式 page space；若任何结果越出 owner block，工具零写入拒绝
editor_align_elements({
  elementIds: ["block-a-element", "block-b-element"],
  align: "horizontal",
  target: "selection",
  coordinateSpace: "page"
})
```

## 3. 内容稳定后再做最终几何

1. 文本变化先用 `super-editor-text` 完成适配与 overflow 检查。
2. 表格/思维导图先加载 `super-editor-elements` 的对应 reference，让行高或节点布局稳定。
3. 图片先确认真实比例与可用 URL。
4. 再调整元素和区块几何；否则内容重排会覆盖或破坏刚完成的位置。

单元素几何优先使用 typed 工具：

```text
editor_move_element({ elementId: "element-id", x: 120, y: 160 })
editor_resize_element({ elementId: "element-id", width: 320, height: 180 })
```

新增元素的 `left/top/x/y` 同样是目标区块局部坐标；省略位置时 Bridge 按该 owner 区块自身尺寸居中，
不会拿整页高度计算 `top`。新增、通用几何更新、批量更新、复制、缩放和旋转都会先计算真实包围盒，
任一候选越出自己的 owner 区块时零写入拒绝。组元素不能直接缩放或旋转；先解组并调整叶子元素。
复制偏移也是 block-local，靠近区块边缘时默认 `+20/+20` 可能被拒绝，应改用明确的安全偏移。

普通布局优先让 Bridge/MCP 封装完成坐标换算，不自行重算。其他批量布局优先使用专用工具：

```text
editor_move_elements_by_offset({
  elementIds: ["a", "b", "c"],
  dx: 0,
  dy: 24
})
```

以当前 `tools/list` 为准，优先使用 `editor_move_element`、`editor_resize_element`、
`editor_rotate_element`、`editor_set_element_spacing`、`editor_center_element_in_block` 和视口 typed 工具；
只有真正未覆盖的方法才用 `editor_rpc_call({ method, args })`。不要通过浏览器模拟拖拽。

## 4. 布局决策顺序

1. **边界**：元素保持在目标区块内；确需撑高区块时更新区块高度并检查后续内容流。
2. **内容可读性**：先消除文本裁切、图片失真和表格/思维导图未稳定状态。
3. **层级**：处理背景、装饰、正文和交互元素的前后关系。
4. **对齐与间距**：基于当前模板已有轴线和间距，不发明固定全书数值。
5. **密度与留白**：保持教学分组清晰，避免为填满空间放大无关装饰。
6. **跨区块关系**：区块高度/顺序变化，或跨区块对齐、节奏、留白本身是目标时检查整页。

多元素重排、组结构、区块高度连锁或复杂嵌套属于中高风险，写前按公共策略建立一次 checkpoint。
单元素确定性坐标调整默认不创建整页快照。

## 5. 视觉验证循环

1. 复读受影响元素和区块的数值；检查负数、非有限值、越界和异常尺寸。
2. 文本调用布局检查；表格/思维导图确认 settle/deferred 状态并检查外层容器。
3. `editor_screenshot({ blockId })` 查看受影响区块；截图有缺口时结合 `editor_get_canvas_tree`。若验收
   跨区块视觉关系，必须追加 `editor_screenshot({ fullPage: true })`，不要求页面流向已经变化。
4. 只对仍有问题的元素迭代，不每轮全页扫描。
5. current 任务运行相关 layout/resources/text checks，再调用
   `editor_save_verified({ scope: 'current', expectedSlideId, verify: true })`。

静态树和截图不能自动证明元素互不遮挡、视觉层级正确或学生端交互可用。重要互动和媒体要走预览链路；
无法自动确认的项目在交付中明确列出。
