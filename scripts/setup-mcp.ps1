# setup-mcp.ps1
# 生成 .mcp.json 兜底脚本：探测可用的 Node 运行时（优先 Codex 捆绑的 node），
# 校验版本 >= 20，生成带绝对路径的 MCP 配置（跨机器、免手动装 Node）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/setup-mcp.ps1
# 可用环境变量 SUPER_EDITOR_NODE 手动指定 node 路径。
$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $pluginRoot 'scripts\mcp-server\index.js'
$mcpPath = Join-Path $pluginRoot '.mcp.json'

if (-not (Test-Path -LiteralPath $serverPath)) {
  Write-Host "[错误] 找不到 $serverPath" -ForegroundColor Red
  exit 1
}

# 1. 收集候选 node：环境变量 > Codex 捆绑路径 > PATH
$candidates = @()
if ($env:SUPER_EDITOR_NODE) { $candidates += $env:SUPER_EDITOR_NODE }
if ($env:USERPROFILE) {
  $candidates += (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
}
if ($env:LOCALAPPDATA) {
  $candidates += (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin\node.exe')
  $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Codex\bin\node.exe')
}
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }

# 2. 选第一个存在且主版本 >= 20 的
$node = $null
foreach ($cand in $candidates) {
  if (-not (Test-Path -LiteralPath $cand)) { continue }
  try {
    $ver = (& $cand -v 2>$null) | Out-String
  } catch {
    continue
  }
  if ($ver -match 'v?(\d+)\.') {
    $major = [int]$Matches[1]
    if ($major -ge 20) {
      $node = $cand
      break
    }
  }
}
if (-not $node) {
  Write-Host '[错误] 未找到 Node >= 20。请先安装 Node.js 20+，或用环境变量 SUPER_EDITOR_NODE 指定路径。' -ForegroundColor Red
  exit 1
}

# 3. 生成 .mcp.json（绝对路径、正斜杠，兼容 Windows/macOS/Linux）
$nodeJson = $node.Replace('\', '/')
$serverJson = $serverPath.Replace('\', '/')
$mcp = @{
  'super-editor' = @{
    type    = 'stdio'
    command = $nodeJson
    args    = @($serverJson)
  }
}
$json = $mcp | ConvertTo-Json -Depth 4

if (Test-Path -LiteralPath $mcpPath) {
  Copy-Item -LiteralPath $mcpPath -Destination "$mcpPath.bak" -Force
  Write-Host "[提示] 已备份旧配置到 $mcpPath.bak"
}
[System.IO.File]::WriteAllText($mcpPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[完成] 已生成 $mcpPath"
Write-Host "  command: $nodeJson"
Write-Host "  args:    $serverJson"
Write-Host '请重启 Codex 使新配置生效。'
