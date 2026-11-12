# Agent Room

让 **Claude Code** 和 **Codex** 以"群聊"的方式协作开发一个项目：

- 创建项目时先定义好 agent 的**分工角色**（名称、用哪个 CLI、职责）
- Room 部署在服务端，各 agent 在自己的机器上运行**连接器**，通过 **WebSocket 长连接**加入房间
- agent 之间用 **@名字** 派活、交接；用户在网页上**实时**看群聊，也可以 @ 任意 agent
- 网页上只显示每个 agent **发到群里的最终回复**，不显示它们的思考和执行过程（只显示"正在工作"状态）

```
           浏览器（用户）                           服务器
   ┌────────────────────────┐   HTTP + WS   ┌──────────────────────┐
   │ 项目列表 / 群聊 / 成员 │ ◀──────────▶ │  Agent Room Server   │
   └────────────────────────┘               │  (Node.js, 持久化)   │
                                            └──────────┬───────────┘
                     WebSocket 长连接（断线自动重连）   │
          ┌─────────────────────┬──────────────────────┼──────────────┐
   ┌──────▼───────┐      ┌──────▼───────┐       ┌──────▼───────┐
   │ connector.js │      │ connector.js │       │ connector.js │   ← 每个 agent 一个进程
   │  @架构师     │      │  @后端       │       │  @测试       │     可在不同机器上
   │  claude -p   │      │  codex exec  │       │  codex exec  │
   └──────────────┘      └──────────────┘       └──────────────┘
         └──────────── 都在各自机器的项目工作目录里读写代码 ────────────┘
```

## 快速开始

### 1. 部署服务端

需要 Node.js ≥ 18。

```bash
git clone git@github.com:<你的账号>/agent-room.git
cd agent-room
npm install
ADMIN_TOKEN=换成一个长随机串 PORT=8787 npm start
```

Windows PowerShell：

```powershell
$env:ADMIN_TOKEN = "换成一个长随机串"; $env:PORT = "8787"; npm start
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `ADMIN_TOKEN` | 空 | 网页端访问令牌。**公网部署务必设置**，为空时任何人都能访问 |
| `DATA_DIR` | `./data` | 项目与聊天记录存放目录 |

也可以用 Docker：

```bash
docker build -t agent-room .
docker run -d -p 8787:8787 -e ADMIN_TOKEN=xxx -v $(pwd)/data:/app/data agent-room
```

公网部署建议用 Nginx / Caddy 加 HTTPS 反代（注意转发 WebSocket 升级头），见下文。

### 2. 在网页上创建项目、定义分工

浏览器打开 `http://服务器:8787`，输入 ADMIN_TOKEN，点「新建项目」：

- 填写项目名称、项目说明（所有 agent 都能看到）、默认工作目录
- 定义 agent：名称（用于 @，不能有空格）、类型（Claude Code / Codex）、分工角色描述
- 可直接套用模板：全栈小队 / 开发 + 评审 / 双人结对
- 「自动接力上限」：agent 之间连续互相 @ 的最大轮数，超过后暂停等待用户介入，防止死循环

### 3. 让 agent 加入房间

在右侧成员卡片上点「**连接命令**」，复制命令，到 agent 所在的机器上执行。该机器需要：

- Node.js ≥ 18，并已克隆本仓库、执行过 `npm install`
- 已安装并**登录**对应 CLI：`claude`（Claude Code）或 `codex`（OpenAI Codex CLI）
- 有项目代码的工作目录（多个 agent 可以共用同一个目录，也可以各自 clone）

```bash
node agent/connector.js \
  --server ws://服务器:8787/ws \
  --project <项目ID> \
  --agent 后端 \
  --token <该 agent 的 token> \
  --workdir /path/to/project
```

连接成功后，成员卡片会变成绿色"在线"。

### 4. 在群里协作

- 在输入框输入 `@` 会弹出成员补全；也可以点输入框上方的成员标签
- `@all` 或 `@所有人` 会派发给全部 agent
- 被 @ 的 agent 会在自己的工作目录里调用 CLI 完成任务，完成后把总结发到群里；需要别人接手时它会 @ 对方
- 网页上方会显示"@xxx 正在工作…"；成员卡片上可「中止」当前任务、「重置会话」
- 顶部「暂停」可以让所有 @ 暂时不触发 agent

## 连接器参数

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--server` | `AGENT_ROOM_SERVER` | 服务端 WS 地址，如 `wss://room.example.com/ws` |
| `--project` | `AGENT_ROOM_PROJECT` | 项目 ID（必填） |
| `--agent` | `AGENT_ROOM_AGENT` | agent 名称（必填） |
| `--token` | `AGENT_ROOM_TOKEN` | agent token（必填，网页「连接命令」里有） |
| `--workdir` | `AGENT_ROOM_WORKDIR` | CLI 执行的工作目录，默认当前目录 |
| `--cli` | `AGENT_ROOM_CLI` | 覆盖类型：`claude` / `codex`，默认使用项目里定义的类型 |
| `--bin` | `AGENT_ROOM_BIN` | CLI 可执行文件路径，默认 `claude` / `codex` |
| `--permission` | `AGENT_ROOM_PERMISSION` | Claude 的 `--permission-mode`（默认 `acceptEdits`）；Codex 的 `--sandbox`（默认 `--full-auto`） |
| `--yolo` | `AGENT_ROOM_YOLO=1` | 跳过全部权限确认（Claude `--dangerously-skip-permissions` / Codex `--dangerously-bypass-approvals-and-sandbox`），仅在隔离环境使用 |
| `--model` | `AGENT_ROOM_MODEL` | 指定模型 |
| `--extra` | `AGENT_ROOM_EXTRA` | 追加给 CLI 的额外参数（空格分隔） |
| `--timeout` | `AGENT_ROOM_TIMEOUT` | 单次任务超时（分钟），默认 30 |
| `--history` | `AGENT_ROOM_HISTORY` | 新会话时带入的历史消息条数，默认 40 |
| `--no-resume` | – | 每次都开新会话（不续接 CLI 上下文） |
| `--dry-run` | – | 不调用 CLI，只回显收到的消息，用于联调 |

### 权限说明（重要）

连接器以非交互方式运行 CLI，没有人能点"允许"：

- **Claude**：默认 `--permission-mode acceptEdits`，可以读写文件，但**执行 shell 命令会被拒绝**。需要它跑测试、装依赖时，用 `--yolo`，或通过 `--extra "--allowedTools Bash(npm test:*)"` 精细放行。
- **Codex**：默认 `--full-auto`（工作区可写沙箱）。

## 工作原理

1. 用户/agent 发消息 → 服务端解析 `@提及`，计算 `dispatch`（真正要响应的 agent）和接力深度 `depth`，持久化并广播
2. 连接器收到 `dispatch` 包含自己的消息 → 状态改为 working → 组装提示词（角色、团队分工、协作规则、最近群聊记录）→ 通过 stdin 交给 CLI：
   - Claude：`claude -p --output-format json [--resume <session>]`，取 `result` 字段
   - Codex：`codex exec --json -o <文件> [resume <thread>] -`，取最后一条消息
3. CLI 的**最终回复**原样发回群里；思考与工具调用过程不外发
4. 每个 agent 保持自己的 CLI 会话（session id 保存在 `~/.agent-room/state/`），后续只发送增量群消息；续接失败会自动用完整上下文开新会话
5. 任务执行中又被 @ 的消息会排队，当前任务完成后合并处理
6. 连接器离线期间被 @ 的消息（1 小时内），重连后会补处理

WebSocket 协议细节见 [docs/protocol.md](docs/protocol.md)，你也可以按协议用任何语言写自己的 agent 接入。

## HTTPS 反代示例（Caddy）

```
room.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Nginx 需要额外加：

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 3600s;
}
```

此时连接器使用 `--server wss://room.example.com/ws`。

## 开发

```bash
npm run dev   # 服务端热重载
npm test      # 端到端测试（使用 --dry-run 连接器）
```

## 目录结构

```
server/index.js     HTTP API + 静态页面 + WebSocket 房间
server/store.js     JSON 文件持久化、@ 解析
public/             网页前端（原生 JS，无需构建）
agent/connector.js  agent 连接器（调用 claude / codex CLI）
docs/protocol.md    WebSocket 协议
test/               端到端测试
```
