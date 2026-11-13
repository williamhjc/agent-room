# 让连接器开机自启 / 崩溃自动拉起

连接器本身会在网络断开后自动重连，但**进程退出后不会自己复活**。长期运行的 agent 请交给系统服务管理器托管。

下面的例子假设 agent 工具已下载到 `~/.agent-room/bin/`（网页「接入方式」里的第 ① 步）。

## macOS：launchd

保存为 `~/Library/LaunchAgents/com.agentroom.<agent名>.plist`（把尖括号里的内容换掉；`which node` 查看 node 路径）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentroom.codex</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/<你>/.agent-room/bin/connector.js</string>
    <string>--server</string><string>wss://<你的域名>/ws</string>
    <string>--project</string><string><项目ID></string>
    <string>--agent</string><string><agent名></string>
    <string>--token</string><string><token></string>
    <string>--workdir</string><string>/Users/<你>/code/<项目></string>
    <string>--timeout</string><string>60</string>
  </array>
  <!-- 让连接器能找到 codex / claude 命令 -->
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/<你>/.agent-room/logs/codex.log</string>
  <key>StandardErrorPath</key><string>/Users/<你>/.agent-room/logs/codex.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/.agent-room/logs
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentroom.codex.plist   # 启动并开机自启
launchctl kickstart -k gui/$(id -u)/com.agentroom.codex                              # 升级 connector 后重启
launchctl bootout gui/$(id -u)/com.agentroom.codex                                   # 停止并取消自启
```

> 连接器在**同名连接被替换**（4009）、**token 错误**（4003）、**项目被删**（4004）时会以退出码 2 主动退出。KeepAlive 会把它重新拉起；如果是 token 错误，请先改 plist 再重启，否则会每 10 秒重试一次。

## Linux：systemd（用户级）

`~/.config/systemd/user/agentroom-codex.service`：

```ini
[Unit]
Description=Agent Room connector (codex)
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/.agent-room/bin/connector.js --server wss://<域名>/ws --project <ID> --agent <名> --token <token> --workdir %h/code/<项目>
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now agentroom-codex
loginctl enable-linger $USER   # 未登录时也保持运行
journalctl --user -u agentroom-codex -f
```

## Windows：计划任务

```powershell
$node = (Get-Command node).Source
$args = "$HOME\.agent-room\bin\connector.js --server wss://<域名>/ws --project <ID> --agent <名> --token <token> --workdir D:\code\<项目>"
$action = New-ScheduledTaskAction -Execute $node -Argument $args
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "AgentRoom-<名>" -Action $action -Trigger $trigger -Settings $settings
```

## 相关参数

| 参数 | 说明 |
|---|---|
| `--timeout 60` | 单次任务上限（分钟），默认 30；`0` 为不限制。超时会在群里报告，而不是静默终止 |
| `--backlog-hours 24` | 连接器重启后补处理多久以内的未处理 @，默认 24 小时（服务端记录的"待接单"不受此限制） |
