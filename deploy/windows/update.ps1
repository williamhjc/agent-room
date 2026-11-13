# Agent Room —— Windows 升级：备份 → 替换代码 → 重启服务 → 健康检查
#
# 用法（管理员 PowerShell，在已 git pull 的仓库根目录执行）：
#   powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1
#
# 回滚：把 C:\ProgramData\AgentRoom\backup\app-<时间> 里的 server、public、agent 复制回 app\，再重启 AgentRoom-App
param([string]$Root = 'C:\ProgramData\AgentRoom', [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$app = Join-Path $Root 'app'
if (-not (Test-Path "$app\Start-App.ps1")) { throw "没有找到已部署的服务：$app（首次部署请用 install.ps1）" }

$bk = Join-Path $Root ("backup\app-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-Host "==> 备份到 $bk" -ForegroundColor Cyan
New-Item -ItemType Directory -Force $bk | Out-Null
foreach ($d in 'server', 'public', 'agent', 'data') { if (Test-Path "$app\$d") { Copy-Item "$app\$d" "$bk\$d" -Recurse -Force } }
Copy-Item "$app\package.json" $bk -Force

Write-Host '==> 替换代码' -ForegroundColor Cyan
$depsChanged = (Get-FileHash (Join-Path $Source 'package-lock.json')).Hash -ne (Get-FileHash "$app\package-lock.json" -ErrorAction SilentlyContinue).Hash
foreach ($d in 'server', 'public', 'agent') {
  Remove-Item "$app\$d" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Source $d) "$app\$d" -Recurse -Force
}
Copy-Item (Join-Path $Source 'package.json'), (Join-Path $Source 'package-lock.json') $app -Force
if ($depsChanged) {
  Write-Host '==> 依赖有变化，重新安装' -ForegroundColor Cyan
  Push-Location $app; & npm.cmd ci --omit=dev --no-audit --no-fund | Out-Null; Pop-Location
}

Write-Host '==> 重启服务（agent 连接器会自动重连）' -ForegroundColor Cyan
Stop-ScheduledTask -TaskName AgentRoom-App
Start-Sleep -Seconds 2
# 万一旧进程没退出，按端口结束它
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-ScheduledTask -TaskName AgentRoom-App
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 3 | Out-Null; $ok = $true } catch {}
}
if ($ok) {
  Write-Host '升级完成，服务正常。浏览器按 Ctrl+F5 刷新。' -ForegroundColor Green
} else {
  Write-Host "服务未响应！查看 $app\app-logs\stderr.log，必要时从 $bk 回滚" -ForegroundColor Red
  exit 1
}
