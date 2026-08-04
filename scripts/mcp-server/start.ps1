$ErrorActionPreference = 'Stop'

$serverPath = Join-Path $PSScriptRoot 'index.js'
$candidates = [System.Collections.Generic.List[string]]::new()

if ($env:SUPER_EDITOR_NODE) {
  $candidates.Add($env:SUPER_EDITOR_NODE)
}

if ($env:USERPROFILE) {
  $runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes'
  $primaryNode = Join-Path $runtimeRoot 'codex-primary-runtime\dependencies\node\bin\node.exe'
  $candidates.Add($primaryNode)

  if ((Test-Path -LiteralPath $runtimeRoot) -and -not (Test-Path -LiteralPath $primaryNode)) {
    Get-ChildItem -LiteralPath $runtimeRoot -Filter node.exe -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '[\\/]dependencies[\\/]node[\\/]bin[\\/]node\.exe$' } |
      ForEach-Object { $candidates.Add($_.FullName) }
  }
}

$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode -and $pathNode.Source) {
  $candidates.Add($pathNode.Source)
}

$nodePath = $null
foreach ($candidate in $candidates) {
  if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) {
    continue
  }
  try {
    $versionText = (& $candidate --version 2>$null) | Out-String
  } catch {
    continue
  }
  if ($versionText -match 'v?(\d+)\.' -and [int]$Matches[1] -ge 20) {
    $nodePath = $candidate
    break
  }
}

if (-not $nodePath) {
  [Console]::Error.WriteLine(
    'Super Editor Control requires Node.js 20+. No bundled Codex runtime or system Node was found.'
  )
  exit 1
}

& $nodePath $serverPath
exit $LASTEXITCODE
