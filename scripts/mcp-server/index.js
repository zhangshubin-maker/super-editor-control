// Super Editor Control MCP 服务端（stdio + JSON-RPC，零依赖）。
// 通过同源 RPC 通道连接编辑器页面，把 window.__superEditor 桥接 API 包装成 editor_* 工具。
// 运行：node index.js（可在环境变量 SUPER_EDITOR_MOCK=1 时 mock 测试）。
import { createInterface } from 'node:readline'
import * as driver from './driver.js'

const SERVER_INFO = { name: 'super-editor-control-mcp', version: '0.3.0' }

const TOOLS = [
  {
    name: 'editor_status',
    description: '返回 MCP 与页面的连接状态（mode: rpc/mock）、页面 URL、固定路由的页面实例 ID（instanceId）、桥接是否就绪、是否 mock 模式。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_connect',
    description: '连接到编辑器页面（同源 RPC 通道，无需 CDP）。pageUrl 传课件完整 URL（自动解析 origin），或 httpUrl 直接传编辑器 origin（如 http://localhost:8090），二选一。',
    inputSchema: {
      type: 'object',
      properties: {
        httpUrl: { type: 'string', description: '编辑器 origin（如 http://localhost:8090）' },
        pageUrl: { type: 'string', description: '课件完整 URL（含 ai_control=1），优先于 httpUrl' }
      },
      additionalProperties: false
    }
  },

  {
    name: 'editor_get_state',
    description: '获取当前课件整体状态：书本信息、页面(slide)列表、当前页、选中元素、脏标记。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_list_slides',
    description: '列出当前课件的页面列表。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_get_slide',
    description: '获取某一页的完整结构：区块列表与元素树。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' } },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_select_slide',
    description: '切换到指定页面。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' } },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_block',
    description: '新增区块。afterBlockId 省略时追加到末尾。',
    inputSchema: {
      type: 'object',
      properties: {
        afterBlockId: { type: 'string', description: '插入到哪个区块之后' },
        size: { type: 'object', description: '区块尺寸，如 { width: 794, height: 300 }' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_clone_block',
    description: '克隆（复制）一个区块到指定位置：保留全部元素与样式，生成新的 blockId。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '源区块 uuid' },
        afterBlockId: { type: 'string', description: '插入到哪个区块之后，省略则追加到末尾' },
        name: { type: 'string', description: '新区块名称，省略则沿用原名' }
      },
      required: ['blockId'],
      additionalProperties: false
    }
  },  {
    name: 'editor_update_block',
    description: '更新区块属性（如 name、size.height）。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string' },
        patch: { type: 'object', description: '要合并的区块属性' }
      },
      required: ['blockId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_block',
    description: '删除区块及其下所有元素。',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string' } },
      required: ['blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_element',
    description: '在指定区块内新增元素。type 参考元素类型体系：text/image/shape/line/chart/table/video/audio/mind/pdfpage/latex/bracket/connectLine/input/outline/tab/textarea 等。payload 为元素数据。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '所属区块 uuid' },
        type: { type: 'string' },
        payload: { type: 'object', description: '元素数据（坐标、尺寸、文本、样式等）' }
      },
      required: ['blockId', 'type', 'payload'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_update_element',
    description: '修改元素属性（patch 合并进元素数据）。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        patch: { type: 'object' }
      },
      required: ['elementId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_delete_element',
    description: '删除指定元素。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string' } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_group_elements',
    description: '将多个元素打组。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_ungroup',
    description: '拆分组（groupId 为 type=group 元素的 id）。',
    inputSchema: {
      type: 'object',
      properties: { groupId: { type: 'string' } },
      required: ['groupId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_order_element',
    description: '调整元素层级。position 取值：front 置顶 / forward 上移一层 / backward 下移一层 / back 置底。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        position: { type: 'string', enum: ['front', 'forward', 'backward', 'back'] }
      },
      required: ['elementId', 'position'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_undo',
    description: '撤销操作（ai_control 模式已禁用，返回 { disabled: true, reason }；回退请用 editor_checkpoint / editor_rollback 整页快照）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_redo',
    description: '重做操作（ai_control 模式已禁用，返回 { disabled: true, reason }；回退请用 editor_checkpoint / editor_rollback 整页快照）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_checkpoint',
    description: '创建整页深拷贝快照（ai_control 专用，替代撤销/重做）：任务开始或关键大节点前调用，勿频繁。返回 { checkpointId, slideId, label, time, blockCount, elementCount }。',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: '快照说明，如 "重构前基线"' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_rollback',
    description: '用快照恢复整页画布（仅限同一页面；任务取消/失败时使用）。返回恢复后的快照信息。',
    inputSchema: {
      type: 'object',
      properties: { checkpointId: { type: 'string', description: 'checkpoint 返回的快照 id' } },
      required: ['checkpointId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_checkpoints',
    description: '列出当前会话的全部快照元信息（checkpointId/slideId/label/time/blockCount/elementCount）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_clear_checkpoints',
    description: '任务成功后清理全部快照，释放内存。返回 { cleared }。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_save',
    description: '保存当前课件（走编辑器既有保存流程）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_screenshot',
    description: '截图画布并返回 PNG 图片（模型可直接看到效果，用于排版/视觉核对）。默认截当前视口；fullPage=true 截全部区块拼接为整页；blockId 指定单个区块（uuid）。注意：canvas 类区块（四线三格、手写格）和跨域图片可能渲染为空，请结合 editor_canvas_tree 数值核对。',
    inputSchema: {
      type: 'object',
      properties: {
        fullPage: { type: 'boolean', description: 'true 时拼接全部区块为整页截图' },
        blockId: { type: 'string', description: '只截指定区块（template uuid）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_get_canvas_tree',
    description: '获取当前页完整结构树：区块列表+元素树+统计（blockCount/elementCount/typeCounts），AI 理解画布首选。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_get_element',
    description: '获取单个元素的完整数据（含所属 blockId、组层级）。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string' } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_list_blocks',
    description: '列出当前页全部区块（blockId/index/name/size/elementCount）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_search_elements',
    description: '按名称/内容/类型关键字搜索元素。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键字（匹配名称/内容/类型/id）' },
        type: { type: 'string', description: '元素类型过滤' },
        blockId: { type: 'string', description: '区块 uuid 过滤' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_align_elements',
    description: '对齐/等间距排列元素。align: top/bottom/left/right/horizontal/vertical/center/hdengju(水平等间距)/vdengju(垂直等间距)；target: selection(选择集内)/canvas(对齐画布)。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { type: 'array', items: { type: 'string' } },
        align: { type: 'string', enum: ['top', 'bottom', 'left', 'right', 'horizontal', 'vertical', 'center', 'hdengju', 'vdengju'] },
        target: { type: 'string', enum: ['selection', 'canvas'], description: '默认 selection；单个元素自动对齐画布' }
      },
      required: ['elementIds', 'align'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_duplicate_elements',
    description: '批量复制元素（默认偏移 +20/+20）。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { type: 'array', items: { type: 'string' } },
        offsetX: { type: 'number' },
        offsetY: { type: 'number' }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_move_elements_by_offset',
    description: '批量移动元素（相对偏移 dx/dy）。',
    inputSchema: {
      type: 'object',
      properties: {
        elementIds: { type: 'array', items: { type: 'string' } },
        dx: { type: 'number' },
        dy: { type: 'number' }
      },
      required: ['elementIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rename_slide',
    description: '重命名页面（目录），即时写库。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' }, name: { type: 'string' } },
      required: ['slideId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_duplicate_slide',
    description: '复制整页（目录+内容），即时写库，返回新 slideId。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string' } },
      required: ['slideId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rename_block',
    description: '重命名区块。',
    inputSchema: {
      type: 'object',
      properties: { blockId: { type: 'string' }, name: { type: 'string' } },
      required: ['blockId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_export_slide',
    description: '导出整页 JSON（区块完整数据），用于备份/跨页复用。slideId 省略为当前页。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string', description: '省略=当前页' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_import_blocks',
    description: '向指定页导入区块数据（自动切换到目标页并插入；uuid/元素 id 自动重生成）。',
    inputSchema: {
      type: 'object',
      properties: {
        slideId: { type: 'string' },
        blocks: { type: 'array', description: '区块模板数组（exportSlide 产物或自定义结构）' },
        index: { type: 'number', description: '插入位置，省略追加末尾' }
      },
      required: ['slideId', 'blocks'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_info',
    description: '读取表格结构：行列数、行列宽高、合并单元格、边框样式，以及展开后的规范网格 grid[r][c]（含每格 id/rowspan/colspan/是否合并起点/是否被覆盖/纯文本内容/原始 HTML）。表格操控前先读它。',
    inputSchema: {
      type: 'object',
      properties: { tableId: { type: 'string', description: '表格元素 id' } },
      required: ['tableId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_set_cell',
    description: '修改表格单元格：content 替换内容（HTML 字符串），background 设置背景色（传空串清除）；row/col 为 0 基坐标（grid 中的位置），被合并覆盖的格子不可写，请写合并起点格。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        row: { type: 'number', description: '0 基行号' },
        col: { type: 'number', description: '0 基列号' },
        content: { type: 'string', description: '单元格内容（HTML 或纯文本）' },
        background: { type: 'string', description: '背景色，如 #FFF6E1 或 rgb(...)；传空串/null 清除' }
      },
      required: ['tableId', 'row', 'col'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_update',
    description: '整表属性/数据更新：patch 直接合并进表格元素（tableData/widths/heights/borderColor/borderWidth/borderRadius/rowColor/colColor 等顶层字段）。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        patch: { type: 'object', description: '要合并的表格元素字段' }
      },
      required: ['tableId', 'patch'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_structure',
    description: '表格结构操作：action 取值 insertRow / deleteRow / insertColumn / deleteColumn / mergeCells / splitCell，index/count/startRow/startCol/endRow/endCol 均为 0 基坐标。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string' },
        action: { type: 'string', enum: ['insertRow', 'deleteRow', 'insertColumn', 'deleteColumn', 'mergeCells', 'splitCell'] },
        index: { type: 'number', description: 'insertRow/deleteRow/insertColumn/deleteColumn 的位置（0 基）' },
        count: { type: 'number', description: 'deleteRow/deleteColumn 删除数量，默认 1' },
        startRow: { type: 'number', description: 'mergeCells 起始行（0 基）' },
        startCol: { type: 'number', description: 'mergeCells 起始列（0 基）' },
        endRow: { type: 'number', description: 'mergeCells 结束行（0 基）' },
        endCol: { type: 'number', description: 'mergeCells 结束列（0 基）' },
        row: { type: 'number', description: 'splitCell 的合并起点行（0 基）' },
        col: { type: 'number', description: 'splitCell 的合并起点列（0 基）' }
      },
      required: ['tableId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_table_fit_heights',
    description: '表格行高自适应（仅 AI 控制）：按单元格实际内容高度重算每行最小高度并写回 heights，等效于逐行拖拽收缩。用于字号/内容缩小后收紧表格；处理合并单元格。waitMs 为内容变更后等待渲染的毫秒数（默认 2000），minHeight 为行高下限（默认 30）。',
    inputSchema: {
      type: 'object',
      properties: {
        tableId: { type: 'string', description: '表格元素 id' },
        waitMs: { type: 'number', description: '内容变更后等待渲染的毫秒数，默认 2000，上限 5000' },
        minHeight: { type: 'number', description: '行高下限，默认 30' }
      },
      required: ['tableId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_info',
    description: '读取思维导图结构：返回规范节点树（每节点 id/纯文本/HTML/层级/路径/常用样式摘要）+ 节点总数/最大深度 + 整体模板/主题。思维导图操控前先读它。',
    inputSchema: {
      type: 'object',
      properties: { mindId: { type: 'string', description: '思维导图元素 id' } },
      required: ['mindId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_set_node',
    description: '修改思维导图节点：text 替换节点文本（纯文本自动转 HTML，已含标签原样保留）；patch 合并样式/附加数据（color/fontsize/bold/italic/fontFamily/background/note/image/hyperlink/priority/progress/expandState 等，传 null 删除该字段）。',
    inputSchema: {
      type: 'object',
      properties: {
        mindId: { type: 'string' },
        nodeId: { type: 'string', description: '目标节点 id（来自 editor_mind_info 的树）' },
        text: { type: 'string', description: '节点文本（HTML 或纯文本）' },
        patch: {
          type: 'object',
          description: '样式/附加数据字段（bold=true/false、italic=true/false、color、fontsize、background、note、image、hyperlink 等）'
        }
      },
      required: ['mindId', 'nodeId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_structure',
    description: '思维导图节点结构操作：action=addChild 给 nodeId 添加子节点（默认末尾，index 可指定位置）；action=addSibling 在 nodeId 后插入同级节点；action=delete 删除节点（中心主题不可删）。text 缺省为"分支主题"。',
    inputSchema: {
      type: 'object',
      properties: {
        mindId: { type: 'string' },
        action: { type: 'string', enum: ['addChild', 'addSibling', 'delete'] },
        nodeId: { type: 'string', description: '目标节点 id；addChild 省略时挂到中心主题下' },
        text: { type: 'string', description: '新节点文本' },
        index: { type: 'number', description: '插入位置（0 基，默认末尾）' }
      },
      required: ['mindId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_mind_update',
    description: '思维导图整体更新：content 整图替换（{ root, template?, theme? } 对象或 JSON 字符串，自动补齐节点 id）；template 切换布局（default/right/left/right_angle/default_angle/left_angle/orthogonal）；theme 切换主题（mind-default/retro/youth/minimalist/black）。',
    inputSchema: {
      type: 'object',
      properties: {
        mindId: { type: 'string' },
        content: {
          type: ['object', 'string'],
          description: '整图数据 { root: { data: { id, text, type }, children: [] }, template?, theme? }'
        },
        template: { type: 'string', description: '布局模板名' },
        theme: { type: 'string', description: '主题名' }
      },
      required: ['mindId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_info',
    description: '读取文本元素结构：内容（HTML/纯文本）、字数、字体样式、行高/字距、背景类型与 extendType 自适应模式、maxWidth/maxHeight、内边距、几何尺寸、groupId。改文本前先读它（判断自适应模式与尺寸约束）。',
    inputSchema: {
      type: 'object',
      properties: { elementId: { type: 'string', description: '文本元素 id' } },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_set_content',
    description: '修改文本内容并（默认）触发宽高自适应重算：fitSize=true 时按 background.extendType（both/horizontal/vertical）自动调整宽高并联动同组元素位移，返回新尺寸与受影响元素列表。纯文本自动包 <p>，\n 自动拆成多段。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        content: { type: 'string', description: '新内容（HTML 或纯文本）' },
        fitSize: { type: 'boolean', description: '是否触发自适应重算，默认 true' },
        waitMs: { type: 'number', description: '自适应等待上限（毫秒），默认 2000' }
      },
      required: ['elementId', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_adaptive',
    description: '切换文本自适应模式：extendType 取值 both（宽高都随内容）/ horizontal（仅宽）/ vertical（仅高）/ none（不自动）。切换后默认触发重算并返回新尺寸与联动位移。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        extendType: { type: 'string', enum: ['both', 'horizontal', 'vertical', 'none'] },
        fitSize: { type: 'boolean', description: '切换后是否触发重算，默认 true' }
      },
      required: ['elementId', 'extendType'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_text_fit',
    description: '强制重测文本元素尺寸（重新按当前内容与 extendType 计算宽高并联动同组元素）。内容未变但尺寸异常、或外部改了字体/样式后想重新适应时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string' },
        waitMs: { type: 'number', description: '自适应等待上限（毫秒），默认 2000' }
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_batch',
    description: '批量执行多个桥接步骤：一次调用内按顺序串行执行 steps（[{ method, args }]，method 为 window.__superEditor 方法名），一次返回全部结果，避免逐条调用等待。stopOnError=true（默认）遇错即停并返回已执行结果。适合合并独立小步骤（如 打快照+批量改元素+核对截图，或 getState+getSlide+listBlocks 一起读取）。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: '按顺序执行的步骤列表',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', description: 'window.__superEditor 方法名（如 addElement / updateElements / scrollToBlock / checkpoint / save）' },
              args: { type: 'array', description: '传给该方法的参数数组（无参数传 []）' }
            },
            required: ['method'],
            additionalProperties: false
          }
        },
        stopOnError: { type: 'boolean', description: '遇到失败是否立即停止并返回，默认 true' }
      },
      required: ['steps'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_rpc_call',
    description: '通用桥接方法调用：透传调用 window.__superEditor 上的任意方法（如 moveElement / resizeElement / rotateElement / duplicateElement / scrollToBlock / scrollToElement / canUndo / addSlide / deleteSlide / moveSlide 等未封装成专用 editor_* 工具的桥接方法）。',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'window.__superEditor 上的方法名' },
        args: { type: 'array', description: '传给该方法的参数数组（无参数传 []）' }
      },
      required: ['method'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_info',
    description: '读取大纲：返回当前页（或指定 slideId 目录）的大纲树 { slideId, outline, selectedOutlineId }。大纲是图层面板左侧「大纲」树的目录级数据，节点含 id/outline_name/parent_id/sort/content_uuids/children。',
    inputSchema: {
      type: 'object',
      properties: { slideId: { type: 'string', description: '目标目录 id，省略=当前页；传任意目录可直接读取（不切换页面）' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_refresh',
    description: '重新从服务端拉取当前页大纲并刷新编辑器大纲树，返回最新大纲树。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'editor_outline_add',
    description: '新增大纲节点：parentId 省略=根节点，sort 省略=追加到同级末尾，name 省略=“未命名”。返回新节点 { id, outline_name, parent_id, sort, content_uuids }。',
    inputSchema: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: '父节点 id，0/省略=根节点' },
        sort: { type: 'number', description: '同级排序号（从 1 开始），省略=追加末尾' },
        name: { type: 'string', description: '大纲名称，省略=“未命名”' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_rename',
    description: '重命名大纲节点。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        name: { type: 'string', description: '新名称' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_delete',
    description: '删除大纲节点（含其子节点）。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_move',
    description: '移动/排序大纲节点：parentId 为目标父节点（0/省略=根节点），sort 为目标同级排序号（从 1 开始）。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        parentId: { type: 'string', description: '目标父节点 id，0/省略=根节点' },
        sort: { type: 'number', description: '目标位置同级排序号（从 1 开始）' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId', 'sort'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_link_blocks',
    description: '设置大纲节点与区块的关联（整体替换）：blockIds 为当前页区块模板 uuid 列表（editor_list_blocks 获取），传 [] 清空关联。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        blockIds: { type: 'array', items: { type: 'string' }, description: '区块 uuid 列表' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId', 'blockIds'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_select',
    description: '选中大纲节点（编辑器大纲树高亮），outlineId 传 null 清空选中。',
    inputSchema: {
      type: 'object',
      properties: { outlineId: { type: ['string', 'null'], description: '大纲节点 id 或 null' } },
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_list',
    description: '查询某大纲节点下的锚点列表（type: 1=位置锚点，2=检索锚点）。',
    inputSchema: {
      type: 'object',
      properties: { outlineId: { type: 'string', description: '大纲节点 id' } },
      required: ['outlineId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_add',
    description: '新增大纲锚点：type 1=位置锚点（一般由编辑器 UI 按关联区块自动维护）、2=检索锚点（默认）；positionX/positionY/width/height 单位与画布一致。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        name: { type: 'string', description: '锚点名称，默认“锚点”' },
        type: { type: 'number', description: '1=位置锚点，2=检索锚点（默认 2）' },
        positionX: { type: 'number', description: 'X 坐标，默认 0' },
        positionY: { type: 'number', description: 'Y 坐标，默认 0' },
        width: { type: 'number', description: '宽，默认 0' },
        height: { type: 'number', description: '高，默认 0' },
        slideId: { type: 'string', description: '目标目录 id，省略=当前页' }
      },
      required: ['outlineId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_update',
    description: '修改大纲锚点：anchor 传完整锚点对象（必须含 id，可带 name/type/position_x/position_y/width/height 等），走编辑器 saveanchor 接口。',
    inputSchema: {
      type: 'object',
      properties: { anchor: { type: 'object', description: '完整锚点对象，必须含 id' } },
      required: ['anchor'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_outline_anchor_delete',
    description: '删除大纲锚点。',
    inputSchema: {
      type: 'object',
      properties: {
        outlineId: { type: 'string', description: '大纲节点 id' },
        anchorId: { type: 'string', description: '锚点 id' }
      },
      required: ['outlineId', 'anchorId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_upload_image',
    description: '上传本地图片到课件媒体库（走编辑器 uploadfile 通道）：imagePath 传本地 PNG/JPG/WebP/GIF 文件路径，或 data 直接传 base64/dataURL。返回 { url, fileId, fileName }，url 可用于新增/替换图片元素、设置背景图等。',
    inputSchema: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: '本地图片文件路径（与 data 二选一）' },
        data: { type: 'string', description: 'base64 或 dataURL 图片数据（与 imagePath 二选一）' },
        fileName: { type: 'string', description: '上传文件名，默认 ai-image.png' },
        mimeType: { type: 'string', description: '图片 MIME，默认按扩展名/数据自动识别' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'editor_add_image_element',
    description: '上传图片并在指定区块新增图片元素：传 url 直接用已有地址；传 imagePath/data 会自动上传后再放入课件。返回 { url, elementId }，随后可用 move/resize/rotate 排版。',
    inputSchema: {
      type: 'object',
      properties: {
        blockId: { type: 'string', description: '目标区块 uuid（editor_list_blocks 获取）' },
        url: { type: 'string', description: '已有图片地址（与 imagePath/data 二选一）' },
        imagePath: { type: 'string', description: '本地图片文件路径（与 url/data 二选一）' },
        data: { type: 'string', description: 'base64 或 dataURL 图片数据' },
        fileName: { type: 'string', description: '上传文件名' },
        mimeType: { type: 'string', description: '图片 MIME' },
        left: { type: 'number', description: 'X 坐标（画布单位）' },
        top: { type: 'number', description: 'Y 坐标' },
        width: { type: 'number', description: '宽' },
        height: { type: 'number', description: '高' },
        name: { type: 'string', description: '元素名' },
        fixedRatio: { type: 'boolean', description: '保持宽高比，默认 true' }
      },
      required: ['blockId'],
      additionalProperties: false
    }
  },
  {
    name: 'editor_set_image_src',
    description: '上传图片并替换已有 image/video 元素的 src：传 url 直接用已有地址；传 imagePath/data 会自动上传。返回 { url, elementId }。',
    inputSchema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'image/video 元素 id' },
        url: { type: 'string', description: '已有图片地址（与 imagePath/data 二选一）' },
        imagePath: { type: 'string', description: '本地图片文件路径' },
        data: { type: 'string', description: 'base64 或 dataURL 图片数据' },
        fileName: { type: 'string', description: '上传文件名' },
        mimeType: { type: 'string', description: '图片 MIME' }
      },
      required: ['elementId'],
      additionalProperties: false
    }
  },
]

class McpError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

async function callTool(name, args) {
  let data
  switch (name) {
    case 'editor_status': {
      data = { ...driver.pageInfo() }
      if (driver.isConnected()) {
        try {
          await driver.bridgeCall('ping')
          data.bridgeReady = true
        } catch (err) {
          data.bridgeReady = false
          data.bridgeError = err.message
        }
      }
      break
    }
    case 'editor_connect':
      data = await driver.connect(args.httpUrl, args.pageUrl)
      break

    case 'editor_get_state':
      data = await driver.bridgeCall('getState')
      break
    case 'editor_list_slides':
      data = await driver.bridgeCall('listSlides')
      break
    case 'editor_get_slide':
      data = await driver.bridgeCall('getSlide', [args.slideId])
      break
    case 'editor_select_slide':
      data = await driver.bridgeCall('selectSlide', [args.slideId])
      break
    case 'editor_add_block':
      data = await driver.bridgeCall('addBlock', [args])
      break
    case 'editor_update_block':
      data = await driver.bridgeCall('updateBlock', [args])
      break
    case 'editor_clone_block':
      data = await driver.bridgeCall('cloneBlock', [args.blockId, { afterBlockId: args.afterBlockId, name: args.name }])
      break
    case 'editor_delete_block':
      data = await driver.bridgeCall('deleteBlock', [args.blockId])
      break
    case 'editor_add_element':
      data = await driver.bridgeCall('addElement', [args])
      break
    case 'editor_update_element':
      data = await driver.bridgeCall('updateElement', [args])
      break
    case 'editor_delete_element':
      data = await driver.bridgeCall('deleteElement', [args.elementId])
      break
    case 'editor_group_elements':
      data = await driver.bridgeCall('groupElements', [args.elementIds])
      break
    case 'editor_ungroup':
      data = await driver.bridgeCall('ungroup', [args.groupId])
      break
    case 'editor_order_element':
      data = await driver.bridgeCall('orderElement', [args])
      break
    case 'editor_undo':
      data = await driver.bridgeCall('undo')
      break
    case 'editor_redo':
      data = await driver.bridgeCall('redo')
      break
    case 'editor_checkpoint':
      data = await driver.bridgeCall('checkpoint', [{ label: args.label }])
      break
    case 'editor_rollback':
      data = await driver.bridgeCall('rollback', [{ checkpointId: args.checkpointId }])
      break
    case 'editor_list_checkpoints':
      data = await driver.bridgeCall('listCheckpoints')
      break
    case 'editor_clear_checkpoints':
      data = await driver.bridgeCall('clearCheckpoints')
      break
    case 'editor_save':
      data = await driver.bridgeCall('save')
      break
    case 'editor_screenshot':
      data = await driver.captureScreenshot({ fullPage: !!args.fullPage, blockId: args.blockId || null })
      break
    case 'editor_get_canvas_tree':
      data = await driver.bridgeCall('getCanvasTree')
      break
    case 'editor_get_element':
      data = await driver.bridgeCall('getElement', [args.elementId])
      break
    case 'editor_list_blocks':
      data = await driver.bridgeCall('listBlocks')
      break
    case 'editor_search_elements':
      data = await driver.bridgeCall('searchElements', [args])
      break
    case 'editor_align_elements':
      data = await driver.bridgeCall('alignElements', [args])
      break
    case 'editor_duplicate_elements':
      data = await driver.bridgeCall('duplicateElements', [args.elementIds, { offsetX: args.offsetX, offsetY: args.offsetY }])
      break
    case 'editor_move_elements_by_offset':
      data = await driver.bridgeCall('moveElementsByOffset', [args])
      break
    case 'editor_rename_slide':
      data = await driver.bridgeCall('renameSlide', [args.slideId, args.name])
      break
    case 'editor_duplicate_slide':
      data = await driver.bridgeCall('duplicateSlide', [args.slideId])
      break
    case 'editor_rename_block':
      data = await driver.bridgeCall('renameBlock', [args.blockId, args.name])
      break
    case 'editor_export_slide':
      data = await driver.bridgeCall('exportSlide', [args.slideId])
      break
    case 'editor_import_blocks':
      data = await driver.bridgeCall('importBlocks', [args.slideId, args.blocks, { index: args.index }])
      break
    case 'editor_table_info': {
      const [info, grid] = await Promise.all([
        driver.bridgeCall('getTableInfo', [{ tableId: args.tableId }]),
        driver.bridgeCall('getTableGrid', [{ tableId: args.tableId }])
      ])
      data = { ...info, grid: grid.grid, mergedCells: grid.mergedCells, gridRows: grid.rows, gridCols: grid.cols }
      break
    }
    case 'editor_table_set_cell':
      if (args.content !== undefined && args.content !== null) {
        data = await driver.bridgeCall('setTableCellContent', [{ tableId: args.tableId, row: args.row, col: args.col, content: args.content }])
      }
      if (args.background !== undefined) {
        data = await driver.bridgeCall('setTableCellBackground', [{ tableId: args.tableId, row: args.row, col: args.col, background: args.background }])
      }
      if (data === undefined) data = null
      break
    case 'editor_table_update':
      data = await driver.bridgeCall('updateTable', [{ tableId: args.tableId, patch: args.patch }])
      break
    case 'editor_table_structure': {
      const a = args
      const map = {
        insertRow: 'insertTableRow',
        deleteRow: 'deleteTableRow',
        insertColumn: 'insertTableColumn',
        deleteColumn: 'deleteTableColumn',
        mergeCells: 'mergeTableCells',
        splitCell: 'splitTableCell'
      }
      const method = map[a.action]
      if (!method) throw new Error('未知 action: ' + a.action)
      if (method === 'mergeTableCells' || method === 'splitTableCell') {
        data = await driver.bridgeCall(method, [{ tableId: a.tableId, startRow: a.startRow, startCol: a.startCol, endRow: a.endRow, endCol: a.endCol, row: a.row, col: a.col }])
      } else {
        data = await driver.bridgeCall(method, [{ tableId: a.tableId, index: a.index, count: a.count }])
      }
      break
    }
    case 'editor_table_fit_heights':
      data = await driver.bridgeCall('fitTableHeights', [{ tableId: args.tableId, waitMs: args.waitMs, minHeight: args.minHeight }])
      break
    case 'editor_mind_info': {
      const [data0, tree] = await Promise.all([
        driver.bridgeCall('getMindData', [{ mindId: args.mindId }]),
        driver.bridgeCall('getMindTree', [{ mindId: args.mindId }])
      ])
      data = { ...data0, nodeCount: tree.nodeCount, depth: tree.depth, root: tree.root }
      break
    }
    case 'editor_mind_set_node': {
      if (args.text !== undefined && args.text !== null) {
        data = await driver.bridgeCall('setMindNodeText', [{ mindId: args.mindId, nodeId: args.nodeId, text: args.text }])
      }
      if (args.patch && Object.keys(args.patch).length) {
        data = await driver.bridgeCall('updateMindNode', [{ mindId: args.mindId, nodeId: args.nodeId, patch: args.patch }])
      }
      if (data === undefined) data = null
      break
    }
    case 'editor_mind_structure': {
      const a = args
      if (a.action === 'delete') {
        data = await driver.bridgeCall('deleteMindNode', [{ mindId: a.mindId, nodeId: a.nodeId }])
      } else {
        data = await driver.bridgeCall('addMindNode', [
          { mindId: a.mindId, nodeId: a.nodeId, position: a.action === 'addSibling' ? 'sibling' : 'child', text: a.text, index: a.index }
        ])
      }
      break
    }
    case 'editor_mind_update': {
      if (args.content !== undefined && args.content !== null) {
        data = await driver.bridgeCall('setMindData', [{ mindId: args.mindId, content: args.content }])
      }
      if (args.template !== undefined) {
        data = await driver.bridgeCall('setMindTemplate', [{ mindId: args.mindId, template: args.template }])
      }
      if (args.theme !== undefined) {
        data = await driver.bridgeCall('setMindTheme', [{ mindId: args.mindId, theme: args.theme }])
      }
      if (data === undefined) data = null
      break
    }
    case 'editor_text_info':
      data = await driver.bridgeCall('getTextInfo', [{ elementId: args.elementId }])
      break
    case 'editor_text_set_content':
      data = await driver.bridgeCall('setTextContent', [
        { elementId: args.elementId, content: args.content, fitSize: args.fitSize, waitMs: args.waitMs }
      ])
      break
    case 'editor_text_adaptive':
      data = await driver.bridgeCall('setTextAdaptive', [
        { elementId: args.elementId, extendType: args.extendType, fitSize: args.fitSize }
      ])
      break
    case 'editor_text_fit':
      data = await driver.bridgeCall('fitTextSize', [{ elementId: args.elementId, waitMs: args.waitMs }])
      break
    case 'editor_outline_info':
      data = await driver.bridgeCall('getOutline', [args.slideId ? { slideId: args.slideId } : {}])
      break
    case 'editor_outline_refresh':
      data = await driver.bridgeCall('refreshOutline')
      break
    case 'editor_outline_add':
      data = await driver.bridgeCall('addOutline', [
        { parentId: args.parentId, sort: args.sort, name: args.name, slideId: args.slideId }
      ])
      break
    case 'editor_outline_rename':
      data = await driver.bridgeCall('renameOutline', [
        { outlineId: args.outlineId, name: args.name, slideId: args.slideId }
      ])
      break
    case 'editor_outline_delete':
      data = await driver.bridgeCall('deleteOutline', [
        { outlineId: args.outlineId, slideId: args.slideId }
      ])
      break
    case 'editor_outline_move':
      data = await driver.bridgeCall('moveOutline', [
        { outlineId: args.outlineId, parentId: args.parentId, sort: args.sort, slideId: args.slideId }
      ])
      break
    case 'editor_outline_link_blocks':
      data = await driver.bridgeCall('linkOutlineBlocks', [
        { outlineId: args.outlineId, blockIds: args.blockIds, slideId: args.slideId }
      ])
      break
    case 'editor_outline_select':
      data = await driver.bridgeCall('selectOutline', [args.outlineId])
      break
    case 'editor_outline_anchor_list':
      data = await driver.bridgeCall('getOutlineAnchors', [{ outlineId: args.outlineId }])
      break
    case 'editor_outline_anchor_add':
      data = await driver.bridgeCall('addOutlineAnchor', [
        {
          outlineId: args.outlineId,
          name: args.name,
          type: args.type,
          positionX: args.positionX,
          positionY: args.positionY,
          width: args.width,
          height: args.height,
          slideId: args.slideId
        }
      ])
      break
    case 'editor_outline_anchor_update':
      data = await driver.bridgeCall('updateOutlineAnchor', [args.anchor])
      break
    case 'editor_outline_anchor_delete':
      data = await driver.bridgeCall('deleteOutlineAnchor', [
        { outlineId: args.outlineId, anchorId: args.anchorId }
      ])
      break
    case 'editor_upload_image':
      data = await driver.uploadImage(args)
      break
    case 'editor_add_image_element':
      data = await driver.addImageElement(args)
      break
    case 'editor_set_image_src':
      data = await driver.setImageElementSrc(args)
      break
    case 'editor_batch':
      data = await driver.bridgeCall('batch', [{ steps: args.steps, stopOnError: args.stopOnError }])
      break
    case 'editor_rpc_call':
      data = await driver.bridgeCall(args.method, Array.isArray(args.args) ? args.args : [])
      break

    default:
      throw new McpError(-32601, 'Unknown tool: ' + name)
  }
  // 截图工具返回 MCP image 内容块，模型可直接看到图片（排版/视觉核对）
  if (name === 'editor_screenshot' && typeof data === 'string' && data.startsWith('data:image')) {
    return {
      content: [{ type: 'image', data: data.slice(data.indexOf(',') + 1), mimeType: 'image/png' }]
    }
  }
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

async function handleRequest(req) {
  switch (req.method) {
    case 'initialize': {
      const requested = req.params && req.params.protocolVersion
      const version = requested && typeof requested === 'string' ? requested : '2025-06-18'
      return {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(req.params && req.params.name, (req.params && req.params.arguments) || {})
    default:
      throw new McpError(-32601, 'Method not found: ' + req.method)
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n')
  } catch {
    // EPIPE 等：客户端已断开
  }
}

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let req
  try {
    req = JSON.parse(trimmed)
  } catch {
    return
  }
  if (!req.id) return // 通知类消息（notifications/initialized 等）
  handleRequest(req).then(
    (result) => send({ jsonrpc: '2.0', id: req.id, result }),
    (err) => {
      if (err instanceof McpError) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: err.code, message: err.message } })
      } else {
        send({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: '[error] ' + err.message }], isError: true }
        })
      }
    }
  )
})

process.on('SIGINT', () => {
  driver.closeActive()
  process.exit(0)
})
process.on('SIGTERM', () => {
  driver.closeActive()
  process.exit(0)
})
