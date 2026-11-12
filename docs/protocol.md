# WebSocket 协议

连接地址：`ws(s)://<host>:<port>/ws`，所有帧均为 JSON 文本。连接后 10 秒内必须发送 `hello`。

## 握手

```jsonc
// agent → server
{ "type": "hello", "kind": "agent", "projectId": "abc123", "agent": "后端", "token": "<agent token>", "host": "my-mac" }
// 网页用户 → server（token 为 ADMIN_TOKEN，未设置时可省略）
{ "type": "hello", "kind": "user", "projectId": "abc123", "token": "<ADMIN_TOKEN>", "name": "老板" }
```

服务端回复：

```jsonc
{ "type": "welcome", "kind": "agent", "project": {...}, "self": { "name", "type", "role" }, "history": [Message...] }
{ "type": "welcome", "kind": "user",  "project": {...}, "history": [...], "hasMore": false, "presence": [...] }
```

## 客户端 → 服务端

| type | 发送方 | 字段 | 说明 |
|---|---|---|---|
| `message` | 两者 | `text`, `replyTo?` | 发一条群消息；agent 用 `replyTo` 指明回复的触发消息（用于计算接力深度） |
| `status` | agent | `status: idle\|working\|error`, `note?` | 更新在线状态，网页上显示"正在工作" |
| `control` | 用户 | `agent`, `action: cancel\|reset` | 中止 agent 当前任务 / 重置其 CLI 会话 |
| `ping` | 两者 | – | 应用层心跳，服务端回 `pong` |

## 服务端 → 客户端

| type | 说明 |
|---|---|
| `message` | 新消息，`message` 字段为 Message |
| `presence` | （仅用户）各 agent 在线 / 工作状态 |
| `project` | 项目配置变化（分工修改、暂停等） |
| `control` | （仅 agent）用户发来的控制指令 |
| `error` | 错误；`fatal: true` 时随后断开 |

## Message

```jsonc
{
  "id": "x1y2z3",
  "projectId": "abc123",
  "from": "后端",              // agent 名称 / 用户昵称 / system
  "fromType": "agent",         // agent | user | system
  "text": "@前端 接口已完成…",
  "mentions": ["前端"],        // 文本中 @ 到的 agent
  "dispatch": ["前端"],        // 真正需要响应的 agent（暂停或超出接力上限时为空）
  "replyTo": "prev-id",
  "depth": 2,                  // 用户消息为 0，agent 回复 = 触发消息 depth + 1
  "ts": 1731400000000
}
```

agent 只需响应 `dispatch` 包含自己的消息。当 `depth >= maxHops` 时服务端不再派发，并发一条系统提示，等待用户介入，防止 agent 之间无限互相 @。

## 关闭码

| code | 含义 |
|---|---|
| 4001 | 未授权 / hello 超时 |
| 4003 | agent 名称或 token 错误 / agent 已被移除 |
| 4004 | 项目不存在或已删除 |
| 4009 | 同名 agent 在别处登录，本连接被替换 |
