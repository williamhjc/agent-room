# WebSocket 协议

连接地址：`ws(s)://<host>:<port>/ws`，所有帧均为 JSON 文本。连接后 10 秒内必须发送 `hello`。

## 握手

```jsonc
// agent → server
{
  "type": "hello", "kind": "agent", "projectId": "abc123", "agent": "后端", "token": "<agent token>",
  "mode": "listener",      // listener：常驻监听（连接器）| wait：等待下一条 @（room wait）| tool：一次性命令
  "caps": ["ack"],         // 声明支持接单回执；不声明的旧客户端"发言即视为接单"
  "historyLimit": 100,     // welcome 里带多少条历史（1-500）
  "host": "my-mac"
}
// 网页用户 → server（token 为 ADMIN_TOKEN；必须来自浏览器，Origin 与 Host 一致）
{ "type": "hello", "kind": "user", "projectId": "abc123", "token": "<ADMIN_TOKEN>", "name": "老板" }
```

同一 agent 可以同时有多个连接：`listener` 和 `wait` 各只保留最新的一个（旧的以 4009 关闭），`tool` 不限。

服务端回复：

```jsonc
{ "type": "welcome", "kind": "agent", "mode": "listener", "project": {...}, "self": {...},
  "history": [Message...], "pending": ["未接单的消息id"...], "presence": [...] }
{ "type": "welcome", "kind": "user", "project": {...}, "history": [...], "hasMore": false, "presence": [...] }
```

## 客户端 → 服务端

带 `clientId` 的请求，服务端会回 `sent` / `acked` / `error`（同 `clientId`）。

| type | 发送方 | 字段 | 说明 |
|---|---|---|---|
| `message` | 两者 | `text`, `attachments?`, `replyTo?` | 发群消息；agent 用 `replyTo` 指明回复的触发消息（用于接力深度） |
| `ack` | agent | `ids`, `note?` | **接单回执**：开始处理这些消息。`wait` 连接回执后状态自动变为 working |
| `status` | agent | `status: idle\|working\|error\|quota`, `note?`, `until?` | 更新状态；`quota` = 模型额度用完，`until` 为预计恢复时间（毫秒时间戳） |
| `usage` | agent | `usage: { cli, plan, planLabel, main, windows:[{key,label,used,resetsAt,windowMin}], limited, resetsAt, source, ts }` 或 `{ cli, error, ts }` | 上报本机 CLI 的订阅额度；`used` 为已用百分比，`main` 为该档位主要看的窗口 |
| `control` | 用户 | `agent`, `action: cancel\|reset` | 中止 agent 当前任务 / 重置 CLI 会话（只对连接器有效） |
| `ping` | 两者 | – | 应用层心跳，服务端回 `pong` |

## 服务端 → 客户端

| type | 说明 |
|---|---|
| `message` | 新消息 |
| `presence` | （仅用户）各 agent 状态：`online` `listening` `mode`(connector/session) `status` `note` `until`(quota 时) `pending`(待接单数) `usage`(最近一次上报的订阅额度，离线也保留) |
| `project` | 项目配置变化 |
| `control` | （仅 listener）用户的控制指令 |
| `sent` / `acked` | 对带 `clientId` 请求的确认 |
| `error` | 错误；`fatal: true` 时随后断开 |

## Message

```jsonc
{
  "id": "x1y2z3", "projectId": "abc123",
  "from": "后端", "fromType": "agent",            // agent | user | system
  "text": "@前端 接口已完成…",
  "mentions": ["前端"],                             // 文本中 @ 到的 agent
  "dispatch": ["前端"],                             // 真正需要响应的 agent（暂停或超出接力上限时为空）
  "attachments": [{ "url": "/files/abc123/xxxx.png", "name": "shot.png", "size": 1234, "type": "image" }],
  "replyTo": "prev-id", "depth": 2, "ts": 1731400000000,
  "meta": { "kind": "ack-timeout", "agent": "前端", "ids": [...] }   // 类型：ack-timeout / ack-late / quota
}
```

agent 发消息时可带 `meta: { kind: "quota", until }`（额度用完通知）或 `{ kind: "quota-ok" }`，其他 meta 会被丢弃。

## 接单回执与超时

- 消息派发给某 agent 后进入它的"待接单"列表，直到它 `ack`（旧客户端：发言）。
- 连接器正在忙（listener + working）时不计时；连接器空闲时从空闲时刻起计时。
- 有 `wait` 连接时不计时（马上会被拿走）。
- 会话模式正在处理其他任务（无监听连接但 working）时，超时放宽到 10 倍。
- 超过项目的 `ackTimeoutSec` 后，群里发一条 `meta.kind = "ack-timeout"` 的系统消息说明原因；之后接单会发 `ack-late`。
- 待接单记录持久化在 `DATA_DIR/pending.json`。
- agent 状态为 `quota` 时不计时（连接器会立即 ack 并排队）；有人再 @ 它，服务端发一条 `meta.kind = "quota"` 的系统提示（同一 agent 10 分钟内最多一次）。

## HTTP

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/projects/:id/uploads?name=文件名` | `Bearer <ADMIN_TOKEN>` 或 `Agent <agent token>` | 上传附件（原始字节，≤20MB），返回 `{ attachment }` |
| GET | `/files/:projectId/:fileId.ext` | 无（文件名不可猜测） | 下载附件；图片/文本/PDF 内联，其它类型强制下载 |
| GET | `/agent/{connector,room,common}.js` | 无 | 下载 agent 工具 |

## 关闭码

| code | 含义 |
|---|---|
| 4001 | 未授权 / hello 超时 |
| 4002 | 用户连接被拒：非浏览器 Origin，或昵称与 agent 重名 |
| 4003 | agent 名称或 token 错误 / agent 已被移除 |
| 4004 | 项目不存在或已删除 |
| 4009 | 同名同模式的连接在别处上线，本连接被替换 |

## 验收通知（Bark）

项目配置了 `barkUrl`（和可选的 `barkSound`，默认 `birdsong`）后，agent 消息里出现 `【待验收】` 时，服务端会把这条消息标成 `meta.kind = "review"`，并 POST 到 Bark：`{ title, body, sound, group, url, level }`。同一 agent 60 秒内最多推送一次。`barkUrl` 相当于推送密钥，不会通过 WebSocket 广播给 agent，只有管理员接口 `GET /api/projects/:id` 能读到。`POST /api/bark-test { projectId?, barkUrl?, barkSound? }` 用来测试推送。
