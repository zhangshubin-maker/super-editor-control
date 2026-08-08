# 语义配置 Schema

数字模块后端结构包含多层 `add_model_*_en`。调用方只填写语义化 `config`，由桥接适配并维护所有后端 ID。不要把配置界面源码中的原始请求对象直接交给 MCP。

## 先读取实时 Schema

```json
{
  "type": 81,
  "supportedOnly": true
}
```

调用 `editor_list_digital_module_types` 后，使用返回项中的：

- `type`、`key`、`name`：类型编号、别名和中文名。
- `supported`：当前是否能从语义配置新建或修改。
- `configSchema`：允许字段、必填字段和枚举。
- `defaults`：产品默认值。
- `resourceRequirements`：题目、媒体、书本、智能体等外部资源。

本文件说明选择和验证语义；字段名、枚举和默认值以实时 `configSchema` 为最终依据。

## 通用创建与修改

创建：

```json
{
  "elementId": "target-element-id",
  "type": 81,
  "name": "打开课程网站",
  "config": {},
  "replaceExisting": false,
  "validateOnly": true
}
```

修改：

```json
{
  "elementId": "target-element-id",
  "name": "新的模块名称",
  "config": {},
  "replaceType": false,
  "validateOnly": true
}
```

- 复杂配置先 `validateOnly: true`，确认规范化结果后去掉该字段执行。
- 创建时 `elementId`、`type` 必填；修改时仅 `elementId` 必填，省略 type 表示沿用现有类型。
- `replaceExisting` 只用于创建时显式替换已有模块；`replaceType` 只用于修改时显式切换类型。
- `validateOnly` 与 `mediaPath` 互斥。媒体预检先上传，再把真实上传结果放入 `config`。

## 当前语义适配范围

| type | 名称 | 配置必须表达的核心语义 |
|---:|---|---|
| 61 | 互动课程 | 已有互动课程 `resourceId` |
| 76 | 图文 | `content` 富文本、呈现形态、输出方式 |
| 77 | 音频 | `audio`/`uploadedFile`、名称；有文稿时还需文稿内容 |
| 78 | 视频 | 至少一个视频 URL/上传结果和对应名称 |
| 79 | 智能课件 | `guid` 或含 GUID 的 `url`，以及课件名称 |
| 80 | 定位 | `catalogId`、真实 `resourceId` 和 anchor/outline/block 目标类型 |
| 81 | 跳转 | `http://` 或 `https://` 网页 URL；App/小程序规则暂不做语义化自动配置 |
| 82 | 在线答题 | 题目 GUID 列表、`questionMode`、`timeMode`、计时与顺序规则 |
| 83 | 核对答案 | 题目 GUID 列表和顺序规则 |
| 85 | 计时器 | 正/倒计时、倒计时时长、弹框/悬浮形态和位置 |
| 86 | 思维导图 | 名称和可解析的 KityMinder `content` |
| 87 | 智能体 | 智能体 ID、学科及该智能体要求的参数 |
| 93 | 逻辑组件 | 一个父题或子题 GUID，以及判断类型 |
| 94 | 题目 AI 讲解 | `questions[{guid, explainIds}]`；先查询/生成并取得真实讲解记录 ID |
| 96 | AI问 | 学习内容、问题与答案列表、选中状态等交互数据 |
| 98 | AI学习播客 | 已完成生成的播客 `resourceId`；本工具不负责异步生成 |
| 99 | 页面链接 | 链接范围和一个或多个合法书本 ID |

若 `supported: false`，不要绕过适配器提交原始 payload。仍可查询、删除，或用
`editor_copy_digital_module` 复用已有成熟模块。

## 类型校验要点

### 图文、思维导图与 AI问

- 富文本保留必要 HTML，不把 Markdown 当作可直接渲染 HTML。
- 思维导图必须是合法树，节点 ID 由适配器补齐时不要自行重复生成。
- AI问的问题和答案保持一一对应；不要提交空问题或错位答案。

### 跳转、定位与页面链接

- 网页跳转 URL 必须以 `http://` 或 `https://` 开头。
- 定位目标必须来自当前页面的真实区块、大纲或锚点查询结果。
- 页面链接的书本 ID 先用 `super-editor-books` 搜索并核对，不凭书名猜 ID。

### 计时器

- 正计时通常不需要时限；倒计时必须给正数时长。
- 悬浮形态需要合法位置；弹框形态不要附带无意义坐标。
- 单位以实时 Schema 为准，不把分钟误传成秒。

### 题目模块

- 使用 `super-editor-questions` 返回的 GUID 字符串，不使用题目数字 ID。
- 在线答题和核对答案至少一题；逻辑组件只选择一个判断对象。
- GUID 数组顺序就是内容顺序；随机展示通过模块规则声明。
- type 82 的测评模式 `questionMode=2` 不允许 `timeMode=0`；提交前调用
  `editor_validate_question_selection`，不要只依赖数字模块保存报错。
- type 94 的 `guid` 是实际讲解对象的父题或子题 GUID；`explainIds`（后端
  `explain_ids`）是该对象已保存讲解记录的数字 ID 列表。先用题目技能执行获取或异步生成流程，禁止把 GUID、展示序号或生成任务 ID 放入 `explainIds`。

### 音视频与课件

- 读取 [media-workflows.md](media-workflows.md)；本地路径先上传。
- 视频列表中每一项都要有 URL，不能只给封面。
- 智能课件地址必须能解析出合法课件 GUID；普通 PPT/PDF URL 不自动等价于智能课件。

## 更新时的合并边界

先读取当前规范化配置。除非实时 Schema 明确说明支持局部 patch，否则把原配置与用户要求合并成完整目标 `config` 再提交；数组通常代表整体顺序，修改题目、视频或问题列表时必须提交完整目标数组。桥接负责保留后端关系和嵌套实体 ID。更新后重新读取并逐项核对。
