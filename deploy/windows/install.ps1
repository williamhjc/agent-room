# Agent Room —— Windows 一键部署（服务端 + Caddy HTTPS 反代 + 开机自启）
#
# 用法（管理员 PowerShell，在仓库根目录执行）：
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -PublicHost room.example.com
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -PublicHost 1.2.3.4      # 没有域名，直接用公网 IP
#   powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -PublicHost 1.2.3.4 -RenderTo .\preview
#       ↑ 只把将要生成的配置文件写到 preview 目录看看，不改动系统
#
# 结果：
#   C:\ProgramData\AgentRoom\app      服务端代码与数据（data\）
#   C:\ProgramData\AgentRoom\secret   admin-token.txt（网页登录令牌）
#   C:\ProgramData\AgentRoom\proxy    caddy.exe 与证书
#   计划任务 AgentRoom-App（LOCAL SERVICE）、AgentRoom-Caddy（NETWORK SERVICE），开机自启、崩溃重启
param(
  [Parameter(Mandatory = $true)][string]$PublicHost,
  [string]$Root = 'C:\ProgramData\AgentRoom',
  [int]$Port = 8787,
  [string]$CaddyVersion = '2.11.9',
  [string]$RenderTo = ''
)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Save($path, $text, [bool]$bom) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $bom)) }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw '未找到 Node.js，请先安装 Node.js 22 LTS：https://nodejs.org/' }
$app = Join-Path $Root 'app'; $secret = Join-Path $Root 'secret'; $proxy = Join-Path $Root 'proxy'
$publicUrl = "https://$PublicHost"
$isIp = $PublicHost -match '^\d{1,3}(\.\d{1,3}){3}$'

# ---------------- 生成配置内容 ----------------
$startApp = @"
`$ErrorActionPreference = 'Stop'
`$root = '$Root'
`$env:ADMIN_TOKEN = [IO.File]::ReadAllText((Join-Path `$root 'secret\admin-token.txt')).Trim()
if (`$env:ADMIN_TOKEN.Length -lt 40) { throw 'Missing administrator token' }
`$env:HOST = '127.0.0.1'
`$env:PORT = '$Port'
`$env:PUBLIC_URL = '$publicUrl'
`$env:DATA_DIR = Join-Path `$root 'app\data'
Set-Location -LiteralPath (Join-Path `$root 'app')
`$ErrorActionPreference = 'Continue'
& '$node' server/index.js >> app-logs\stdout.log 2>> app-logs\stderr.log
exit `$LASTEXITCODE
"@

$startCaddy = @"
`$root = '$proxy'
Set-Location -LiteralPath `$root -ErrorAction Stop
& .\caddy.exe run --config Caddyfile --adapter caddyfile >> logs\stdout.log 2>> logs\stderr.log
exit `$LASTEXITCODE
"@

$storage = ($proxy -replace '\\', '/') + '/storage'
if ($isIp) {
  # 没有域名：Let's Encrypt 的 IP 证书需要 shortlived 配置（有效期约 6 天，Caddy 自动续期）
  $caddyfile = @"
{
	admin off
	default_sni $PublicHost
	storage file_system $storage
	skip_install_trust
}

https://$PublicHost {
	tls {
		issuer acme {
			dir https://acme-v02.api.letsencrypt.org/directory
			profile shortlived
		}
	}
	reverse_proxy 127.0.0.1:$Port
}
"@
} else {
  $caddyfile = @"
{
	admin off
	storage file_system $storage
	skip_install_trust
}

$PublicHost {
	reverse_proxy 127.0.0.1:$Port
}
"@
}

if ($RenderTo) {
  New-Item -ItemType Directory -Force $RenderTo | Out-Null
  Save (Join-Path $RenderTo 'Start-App.ps1') $startApp $true
  Save (Join-Path $RenderTo 'Start-Caddy.ps1') $startCaddy $true
  Save (Join-Path $RenderTo 'Caddyfile') $caddyfile $false
  Write-Host "预览文件已写到 $((Resolve-Path $RenderTo).Path)，系统未做任何改动。" -ForegroundColor Green
  exit 0
}

# ---------------- 正式安装 ----------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '请用"以管理员身份运行"的 PowerShell 执行本脚本' }
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source

Step '创建目录'
foreach ($d in $app, "$app\data", "$app\app-logs", $secret, $proxy, "$proxy\logs", "$proxy\storage", "$Root\backup") {
  New-Item -ItemType Directory -Force $d | Out-Null
}

Step '复制服务端代码并安装依赖'
foreach ($d in 'server', 'public', 'agent') {
  Remove-Item "$app\$d" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item (Join-Path $Source $d) "$app\$d" -Recurse -Force
}
Copy-Item (Join-Path $Source 'package.json'), (Join-Path $Source 'package-lock.json') $app -Force
Push-Location $app; & $npm ci --omit=dev --no-audit --no-fund | Out-Null; Pop-Location

Step '生成管理员令牌（已存在则保留）'
$tokenFile = Join-Path $secret 'admin-token.txt'
if (-not (Test-Path $tokenFile)) {
  $bytes = New-Object byte[] 36; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  Save $tokenFile ([Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')) $false
}

Step "写入启动脚本，准备 Caddy v$CaddyVersion"
Save "$app\Start-App.ps1" $startApp $true
Save "$proxy\Start-Caddy.ps1" $startCaddy $true
Save "$proxy\Caddyfile" $caddyfile $false
if (-not (Test-Path "$proxy\caddy.exe")) {
  $zip = Join-Path $env:TEMP "caddy_$CaddyVersion.zip"
  Invoke-WebRequest "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip" -OutFile $zip
  Expand-Archive $zip -DestinationPath $proxy -Force
}

Step '设置目录权限（服务账号只拿到需要的权限）'
icacls $app /grant '*S-1-5-19:(OI)(CI)RX' | Out-Null            # LOCAL SERVICE：读代码
icacls "$app\data" /grant '*S-1-5-19:(OI)(CI)M' | Out-Null       # 写数据
icacls "$app\app-logs" /grant '*S-1-5-19:(OI)(CI)M' | Out-Null   # 写日志
icacls $secret /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
icacls $proxy /grant '*S-1-5-20:(OI)(CI)RX' | Out-Null           # NETWORK SERVICE：读 Caddy
icacls "$proxy\storage" /grant '*S-1-5-20:(OI)(CI)M' | Out-Null
icacls "$proxy\logs" /grant '*S-1-5-20:(OI)(CI)M' | Out-Null

Step '注册计划任务（开机自启、崩溃重启）'
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$ps = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
foreach ($t in @(
    @{ Name = 'AgentRoom-App'; File = "$app\Start-App.ps1"; User = 'NT AUTHORITY\LOCAL SERVICE' },
    @{ Name = 'AgentRoom-Caddy'; File = "$proxy\Start-Caddy.ps1"; User = 'NT AUTHORITY\NETWORK SERVICE' }
  )) {
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $($t.File)"
  $principal = New-ScheduledTaskPrincipal -UserId $t.User -LogonType ServiceAccount
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
  Stop-ScheduledTask -TaskName $t.Name -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $t.Name
}

Step '放行防火墙 80/443'
if (-not (Get-NetFirewallRule -DisplayName 'AgentRoom HTTPS' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'AgentRoom HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
}

Step '健康检查'
Start-Sleep -Seconds 5
try { Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing | Out-Null; Write-Host '服务端：正常' -ForegroundColor Green }
catch { Write-Host "服务端未响应，查看 $app\app-logs\stderr.log" -ForegroundColor Red }

Write-Host ''
Write-Host "部署完成：$publicUrl" -ForegroundColor Green
Write-Host "网页登录令牌：$tokenFile"
Write-Host '首次申请 HTTPS 证书可能需要 1 分钟；云服务器记得在安全组放行 TCP 80 和 443。'
