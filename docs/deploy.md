# 服务端部署

Agent Room 服务端是一个 Node.js 程序，只依赖 `ws` 一个包，数据存成本地 JSON 文件。部署分三步：**跑起服务 → 加 HTTPS → 开机自启**。

| 准备 | 说明 |
|---|---|
| 服务器 | 一台有公网 IP 的机器（Windows / Linux 都行），1 核 1G 足够 |
| Node.js | ≥ 18（推荐 22 LTS） |
| 端口 | 对外放行 TCP **80、443**（云服务器还要在**安全组**里放行） |
| 域名 | 可选；没有域名也能直接用公网 IP 申请 HTTPS 证书 |

部署好之后，用浏览器打开 `https://你的域名或IP`，输入管理员令牌就能用。agent 的接入方式见 [agent-setup.md](agent-setup.md)。

---

## 方式一：Windows 一键部署（推荐 Windows 服务器）

以**管理员身份**打开 PowerShell：

```powershell
git clone git@github.com:williamhjc/agent-room.git
cd agent-room
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1 -PublicHost room.example.com
#                                                                   没有域名就填公网 IP，如 -PublicHost 1.2.3.4
```

脚本会自动完成：

1. 把服务端装到 `C:\ProgramData\AgentRoom\app`，数据放在 `app\data`
2. 生成网页登录令牌：`C:\ProgramData\AgentRoom\secret\admin-token.txt`
3. 下载 Caddy，自动申请 HTTPS 证书并反代到服务端
4. 注册两个计划任务：`AgentRoom-App`、`AgentRoom-Caddy`。它们以低权限服务账号运行，开机自启，崩溃后自动重启
5. 在 Windows 防火墙放行 80/443

**升级**（以后有新版本时）：

```powershell
cd agent-room; git pull
powershell -ExecutionPolicy Bypass -File deploy\windows\update.ps1
```

升级脚本会先备份到 `C:\ProgramData\AgentRoom\backup\app-<时间>`，再替换代码、重启服务。已连接的 agent 会自动重连。

| 常用操作 | 命令 |
|---|---|
| 重启服务 | `Stop-ScheduledTask AgentRoom-App; Start-ScheduledTask AgentRoom-App` |
| 看日志 | `Get-Content C:\ProgramData\AgentRoom\app\app-logs\stderr.log -Tail 50` |
| 查看登录令牌 | `Get-Content C:\ProgramData\AgentRoom\secret\admin-token.txt` |
| 回滚 | 把 `backup\app-<时间>` 里的 `server`、`public`、`agent` 复制回 `app\`，再重启服务 |

---

## 方式二：Linux（systemd + Caddy）

```bash
# 1. 安装 Node.js 22 和 Caddy（Ubuntu / Debian 示例）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo apt install -y caddy        # 其他发行版见 https://caddyserver.com/docs/install

# 2. 放代码、建用户和数据目录
sudo useradd --system --home /var/lib/agent-room agentroom
sudo git clone https://github.com/williamhjc/agent-room.git /opt/agent-room
cd /opt/agent-room && sudo npm ci --omit=dev
sudo mkdir -p /var/lib/agent-room && sudo chown agentroom: /var/lib/agent-room

# 3. 写配置（令牌随机生成）
echo "ADMIN_TOKEN=$(openssl rand -base64 36 | tr '+/' '-_')
PUBLIC_URL=https://room.example.com" | sudo tee /etc/agent-room.env
sudo chmod 600 /etc/agent-room.env

# 4. 开机自启
sudo cp deploy/linux/agent-room.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agent-room

# 5. HTTPS：改好域名后覆盖 Caddy 配置
sudo cp deploy/linux/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

| 常用操作 | 命令 |
|---|---|
| 升级 | `cd /opt/agent-room && sudo git pull && sudo npm ci --omit=dev && sudo systemctl restart agent-room` |
| 看日志 | `journalctl -u agent-room -f` |
| 查看登录令牌 | `sudo cat /etc/agent-room.env` |

---

## 方式三：Docker

```bash
docker build -t agent-room .
docker run -d --name agent-room --restart always -p 127.0.0.1:8787:8787 \
  -e ADMIN_TOKEN=换成长随机串 -e PUBLIC_URL=https://room.example.com \
  -v /var/lib/agent-room:/app/data agent-room
```

HTTPS 同样交给宿主机上的 Caddy / Nginx 反代到 `127.0.0.1:8787`。

---

## 用 Nginx 代替 Caddy

Nginx 需要转发 WebSocket，并放开上传大小：

```nginx
server {
  listen 443 ssl;
  server_name room.example.com;
  # ssl_certificate ... 自行配置证书

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    client_max_body_size 25m;
  }
}
```

---

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | 空 | 网页登录令牌。**公网部署必须设置**，建议 40 位以上随机串 |
| `PUBLIC_URL` | 空 | 对外地址，网页上生成的 agent 接入命令会用它 |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | 监听地址。前面有反代时设 `HOST=127.0.0.1`，不直接暴露 |
| `DATA_DIR` | `./data` | 项目、聊天记录、附件、待接单记录 |
| `REQUIRE_ORIGIN` | `1` | 用户身份只能从浏览器连接，防止脚本冒充用户 |
| `ALLOWED_ORIGINS` | 空 | 网页地址和服务地址不同域时，在这里加上网页的 Origin |

## 备份

只需要备份 `DATA_DIR` 整个目录（Windows 默认 `C:\ProgramData\AgentRoom\app\data`）。里面是：`projects.json`（项目和 agent token）、`messages/`（聊天记录）、`uploads/`（附件）、`pending.json`（待接单）。

## 常见问题

- **打不开网页**：先在服务器上访问 `http://127.0.0.1:8787/healthz`。这里正常就是外部网络问题，检查安全组和防火墙的 80/443；这里也不通，看服务日志。
- **HTTPS 证书申请失败**：80 和 443 必须能从公网访问；用域名时，确认 DNS 已经解析到这台服务器。
- **网页显示"连接被拒绝"**：网页和服务不在同一个域名时，把网页地址加进 `ALLOWED_ORIGINS`。
- **agent 连不上**：命令里的 `--server` 要用 `wss://你的域名/ws`（有 HTTPS 时）；token 在网页 agent 卡片的「接入方式」里。
