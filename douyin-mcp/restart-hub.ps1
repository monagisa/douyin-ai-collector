# 重启 douyin-mcp Hub（带 CORS 的新版）
$ErrorActionPreference = 'Stop'
# 优先用 PATH 里的 node；可用环境变量 DTS_NODE_EXE 覆盖
$node = $env:DTS_NODE_EXE
if (-not $node) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node) { $node = 'node' }
$mcp = Join-Path $PSScriptRoot 'mcp.js'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'douyin-mcp\\mcp\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Milliseconds 300
$p = Start-Process -FilePath $node -ArgumentList $mcp -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 600

$origin = 'chrome-extension://mjneoakihhpeefdjlandcombjgnhmfcg'
try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18765/api/v1/health' -Headers @{ Origin = $origin } -UseBasicParsing -TimeoutSec 3
  Write-Output "Hub OK pid=$($p.Id) status=$($r.StatusCode) ACAO=$($r.Headers['Access-Control-Allow-Origin'])"
  Write-Output $r.Content
} catch {
  Write-Output "Hub FAIL: $_"
  exit 1
}
