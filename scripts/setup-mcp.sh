#!/usr/bin/env bash
# setup-mcp.sh
# 生成 .mcp.json 兜底脚本：探测可用的 Node 运行时（优先 Codex 捆绑的 node），
# 校验版本 >= 20，生成带绝对路径的 MCP 配置（跨机器、免手动装 Node）。
# 用法：bash scripts/setup-mcp.sh
# 可用环境变量 SUPER_EDITOR_NODE 手动指定 node 路径。
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PATH="$PLUGIN_ROOT/scripts/mcp-server/index.js"
MCP_PATH="$PLUGIN_ROOT/.mcp.json"

if [ ! -f "$SERVER_PATH" ]; then
  echo "[错误] 找不到 $SERVER_PATH" >&2
  exit 1
fi

# 候选 node：环境变量 > Codex 捆绑路径（常见位置）> PATH
CANDIDATES=()
[ -n "${SUPER_EDITOR_NODE:-}" ] && CANDIDATES+=("$SUPER_EDITOR_NODE")
CANDIDATES+=("$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
CANDIDATES+=("/Applications/Codex.app/Contents/Resources/cua_node/bin/node")
CANDIDATES+=("$HOME/Applications/Codex.app/Contents/Resources/cua_node/bin/node")
CANDIDATES+=("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node")
CANDIDATES+=("$HOME/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node")
CANDIDATES+=("$HOME/Library/Application Support/Codex/bin/node") # 旧版 macOS 位置
CANDIDATES+=("$HOME/.local/share/Codex/bin/node")                # Linux 常见位置
CANDIDATES+=("$HOME/.local/opt/Codex/bin/node")                  # Linux 备选位置
if command -v node >/dev/null 2>&1; then
  CANDIDATES+=("$(command -v node)")
fi

NODE=""
for c in "${CANDIDATES[@]}"; do
  if [ -x "$c" ] || [ -f "$c" ]; then
    ver="$("$c" -v 2>/dev/null || true)"
    major="$(printf '%s' "$ver" | sed -E 's/^v?([0-9]+).*/\1/')"
    if [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null; then
      NODE="$c"
      break
    fi
  fi
done

if [ -z "$NODE" ]; then
  echo "[错误] 未找到 Node >= 20。请先安装 Node.js 20+，或用环境变量 SUPER_EDITOR_NODE 指定路径。" >&2
  exit 1
fi

[ -f "$MCP_PATH" ] && cp "$MCP_PATH" "$MCP_PATH.bak" && echo "[提示] 已备份旧配置到 $MCP_PATH.bak"

SUPER_EDITOR_CONFIG_PATH="$MCP_PATH" \
SUPER_EDITOR_SERVER_PATH="$SERVER_PATH" \
SUPER_EDITOR_PLUGIN_ROOT="$PLUGIN_ROOT" \
  "$NODE" <<'NODE'
const fs = require('node:fs')

const config = {
  'super-editor': {
    type: 'stdio',
    command: process.execPath,
    args: [process.env.SUPER_EDITOR_SERVER_PATH],
    cwd: process.env.SUPER_EDITOR_PLUGIN_ROOT,
    startup_timeout_sec: 15,
    tool_timeout_sec: 120
  }
}

fs.writeFileSync(
  process.env.SUPER_EDITOR_CONFIG_PATH,
  `${JSON.stringify(config, null, 2)}\n`,
  'utf8'
)
NODE

echo "[完成] 已生成 $MCP_PATH"
echo "  command: $NODE"
echo "  args:    $SERVER_PATH"
echo "请重启 Codex 使新配置生效。"
