# 强制清掉旧 Service Worker 并重载扩展（按顺序执行）

# 扩展开发目录：仓库里与本脚本所在目录平级的 douyin-collector/
$extDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'douyin-collector'

Write-Output '== 1. 重启 Hub（新版，带 CORS） =='
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'restart-hub.ps1')

Write-Output ''
Write-Output '== 2. 磁盘上的扩展版本（读 manifest.json，不写死） =='
$m = Get-Content (Join-Path $extDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Output "version=$($m.version)"
Write-Output "permissions=$($m.permissions -join ',')"
Write-Output "host=$($m.host_permissions -join ',')"
if ($m.permissions -contains 'alarms') {
  Write-Output 'ERROR: manifest 仍含 alarms，请先改文件'
  exit 1
}

Write-Output ''
Write-Output '== 3. 请你在 Chrome / Edge 里手动完成 =='
Write-Output ''
Write-Output '打开 chrome://extensions（或 edge://extensions）'
Write-Output '找到「抖音评论采集器」'
Write-Output '① 先点「移除」删除扩展（清掉旧 SW 缓存）'
Write-Output '② 开发者模式 → 加载已解压的扩展程序'
Write-Output "③ 重新选择目录: $extDir"
Write-Output '④ 打开抖音视频页并 F5'
Write-Output '⑤ Service Worker 控制台：点「全部清除」，再看是否还有 onAlarm / CORS'
Write-Output ''
Write-Output '若你用 Edge 打开抖音，请在 Edge 的扩展页同样移除→重载。'
Write-Output '浏览器：Chrome 与 Edge 可同时装同一扩展目录，但 SW 互相独立，两边都要重载。'
