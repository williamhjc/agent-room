#!/usr/bin/env node
// Agent Room 服务端：HTTP API + 静态网页 + WebSocket 房间
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store, newId, parseMentions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 为空则网页端无需登录（仅建议本地使用）
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_TEXT = 100_000;

const store = new Store(DATA_DIR);

// ---------- 工具 ----------
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function isAdmin(token) {
  return !ADMIN_TOKEN || (token && safeEqual(token, ADMIN_TOKEN));
}
/** 发给 agent / 广播时去掉 token */
function publicProject(p) {
  return { ...p, agents: p.agents.map(({ token, ...a }) => a) };
}
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 房间（在线状态） ----------
/** projectId -> { users:Set<ws>, agents:Map<name,{ws,status,note,since}> } */
const rooms = new Map();
function room(id) {
  if (!rooms.has(id)) rooms.set(id, { users: new Set(), agents: new Map() });
  return rooms.get(id);
}
function presence(projectId) {
  const p = store.getProject(projectId);
  const r = room(projectId);
  return (p?.agents || []).map((a) => {
    const c = r.agents.get(a.name);
    return {
      name: a.name,
      type: a.type,
      online: !!c,
      status: c ? c.status : 'offline',
      note: c?.note || '',
      since: c?.since || null,
      host: c?.host || '',
    };
  });
}
function broadcast(projectId, data, { usersOnly = false } = {}) {
  const r = rooms.get(projectId);
  if (!r) return;
  const raw = JSON.stringify(data);
  for (const ws of r.users) if (ws.readyState === 1) ws.send(raw);
  if (!usersOnly) for (const { ws } of r.agents.values()) if (ws.readyState === 1) ws.send(raw);
}
function broadcastPresence(projectId) {
  broadcast(projectId, { type: 'presence', agents: presence(projectId) }, { usersOnly: true });
}

/** 写入并广播一条消息，计算 @提及与派发对象 */
function postMessage(projectId, { from, fromType, text, replyTo }) {
  const p = store.getProject(projectId);
  if (!p) throw new Error('项目不存在');
  text = String(text || '').slice(0, MAX_TEXT);
  const history = store.getMessages(projectId);
  let depth = 0;
  if (fromType === 'agent') {
    const parent = replyTo && findMessage(history, replyTo);
    depth = parent ? (parent.depth || 0) + 1 : 1;
  }
  const mentions = fromType === 'system' ? [] : parseMentions(text, p.agents).filter((n) => n !== from);
  let dispatch = mentions;
  let notice = null;
  if (p.paused && mentions.length) {
    dispatch = [];
    notice = '项目已暂停，@提及不会触发 agent。点击「恢复」后重新发送。';
  } else if (fromType === 'agent' && depth >= p.maxHops && mentions.length) {
    dispatch = [];
    notice = `已达到 agent 自动接力上限（${p.maxHops} 轮），请用户介入后再继续。`;
  }
  const msg = {
    id: newId(12),
    projectId,
    from,
    fromType,
    text,
    mentions,
    dispatch,
    replyTo: replyTo || null,
    depth,
    ts: Date.now(),
  };
  store.addMessage(projectId, msg);
  broadcast(projectId, { type: 'message', message: msg });
  if (notice) postMessage(projectId, { from: 'system', fromType: 'system', text: notice });
  return msg;
}
function findMessage(history, id) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].id === id) return history[i];
  return null;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA：未知路径回退到 index.html
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, b2) => {
        if (e2) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(b2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'config' && req.method === 'GET') {
    return sendJson(res, 200, { authRequired: !!ADMIN_TOKEN });
  }
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!isAdmin(auth)) return sendJson(res, 401, { error: '未授权：请输入正确的访问令牌' });

  if (parts[1] !== 'projects') return sendJson(res, 404, { error: 'not found' });
  const id = parts[2];

  if (!id) {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        projects: store.listProjects().map((p) => ({
          ...publicProject(p),
          online: presence(p.id).filter((a) => a.online).length,
          messageCount: store.getMessages(p.id).length,
        })),
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const p = store.createProject(body);
      postMessage(p.id, {
        from: 'system',
        fromType: 'system',
        text: `项目「${p.name}」已创建，成员：${p.agents.map((a) => `@${a.name}（${a.type}）`).join('、')}`,
      });
      return sendJson(res, 201, { project: p });
    }
  }

  const p = store.getProject(id);
  if (!p) return sendJson(res, 404, { error: '项目不存在' });

  if (parts.length === 3) {
    if (req.method === 'GET') return sendJson(res, 200, { project: p, presence: presence(id) });
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const before = new Set(p.agents.map((a) => a.name));
      const wasPaused = p.paused;
      const updated = store.updateProject(id, body);
      // 被删除的 agent 断开连接
      const r = room(id);
      for (const [name, c] of r.agents) {
        if (!updated.agents.find((a) => a.name === name)) c.ws.close(4003, 'agent removed');
      }
      broadcast(id, { type: 'project', project: publicProject(updated) });
      broadcastPresence(id);
      if (body.paused !== undefined && wasPaused !== updated.paused) {
        postMessage(id, { from: 'system', fromType: 'system', text: updated.paused ? '项目已暂停。' : '项目已恢复。' });
      }
      const added = updated.agents.filter((a) => !before.has(a.name));
      if (added.length) {
        postMessage(id, { from: 'system', fromType: 'system', text: `新成员加入分工：${added.map((a) => '@' + a.name).join('、')}` });
      }
      return sendJson(res, 200, { project: updated });
    }
    if (req.method === 'DELETE') {
      const r = room(id);
      for (const c of r.agents.values()) c.ws.close(4004, 'project deleted');
      for (const ws of r.users) ws.close(4004, 'project deleted');
      rooms.delete(id);
      store.deleteProject(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (parts[3] === 'messages' && req.method === 'GET') {
    const all = store.getMessages(id);
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10));
    const before = url.searchParams.get('before');
    let end = all.length;
    if (before) {
      const idx = all.findIndex((m) => m.id === before);
      if (idx >= 0) end = idx;
    }
    return sendJson(res, 200, { messages: all.slice(Math.max(0, end - limit), end), hasMore: end - limit > 0 });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    sendJson(res, 400, { error: e.message || String(e) });
  }
});

// ---------- WebSocket ----------
// 协议见 docs/protocol.md
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.ctx = null;
  const send = (d) => ws.readyState === 1 && ws.send(JSON.stringify(d));
  const helloTimer = setTimeout(() => !ws.ctx && ws.close(4001, 'hello timeout'), 10_000);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return send({ type: 'error', error: '无效 JSON' });
    }
    try {
      if (!ws.ctx) return onHello(ws, data, send, req);
      onMessage(ws, data, send);
    } catch (e) {
      send({ type: 'error', error: e.message || String(e) });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    const ctx = ws.ctx;
    if (!ctx) return;
    const r = room(ctx.projectId);
    if (ctx.kind === 'user') r.users.delete(ws);
    else if (r.agents.get(ctx.agent)?.ws === ws) {
      r.agents.delete(ctx.agent);
      broadcastPresence(ctx.projectId);
    }
  });
});

function onHello(ws, data, send, req) {
  if (data.type !== 'hello') throw new Error('请先发送 hello');
  const p = store.getProject(data.projectId);
  if (!p) {
    send({ type: 'error', error: '项目不存在', fatal: true });
    return ws.close(4004, 'project not found');
  }
  const r = room(p.id);
  if (data.kind === 'agent') {
    const def = p.agents.find((a) => a.name === data.agent);
    if (!def || !data.token || !safeEqual(data.token, def.token)) {
      send({ type: 'error', error: 'agent 名称或 token 不正确', fatal: true });
      return ws.close(4003, 'bad agent credentials');
    }
    const old = r.agents.get(def.name);
    if (old && old.ws !== ws) {
      try {
        old.ws.send(JSON.stringify({ type: 'error', error: '同名 agent 在别处登录，本连接被替换', fatal: true }));
      } catch {}
      old.ws.close(4009, 'replaced');
    }
    ws.ctx = { kind: 'agent', projectId: p.id, agent: def.name };
    r.agents.set(def.name, {
      ws,
      status: 'idle',
      note: '',
      since: Date.now(),
      host: String(data.host || req.socket.remoteAddress || '').slice(0, 100),
    });
    const { token, ...self } = def;
    send({
      type: 'welcome',
      kind: 'agent',
      project: publicProject(p),
      self,
      history: store.getMessages(p.id).slice(-100),
    });
    broadcastPresence(p.id);
    return;
  }
  // 用户（网页端）
  if (!isAdmin(data.token)) {
    send({ type: 'error', error: '未授权', fatal: true });
    return ws.close(4001, 'unauthorized');
  }
  ws.ctx = { kind: 'user', projectId: p.id, name: String(data.name || '用户').slice(0, 32) };
  r.users.add(ws);
  const all = store.getMessages(p.id);
  send({
    type: 'welcome',
    kind: 'user',
    project: publicProject(p),
    history: all.slice(-200),
    hasMore: all.length > 200,
    presence: presence(p.id),
  });
}

function onMessage(ws, data, send) {
  const ctx = ws.ctx;
  switch (data.type) {
    case 'ping':
      return send({ type: 'pong', ts: Date.now() });
    case 'message': {
      const text = String(data.text || '').trim();
      if (!text) return;
      if (ctx.kind === 'agent') {
        postMessage(ctx.projectId, { from: ctx.agent, fromType: 'agent', text, replyTo: data.replyTo });
      } else {
        postMessage(ctx.projectId, { from: ctx.name, fromType: 'user', text });
      }
      return;
    }
    case 'status': {
      if (ctx.kind !== 'agent') return;
      const c = room(ctx.projectId).agents.get(ctx.agent);
      if (!c) return;
      c.status = ['idle', 'working', 'error'].includes(data.status) ? data.status : 'idle';
      c.note = String(data.note || '').slice(0, 200);
      broadcastPresence(ctx.projectId);
      return;
    }
    case 'control': {
      // 用户 -> agent 的控制指令（目前支持 cancel：中止正在执行的任务；reset：清空会话）
      if (ctx.kind !== 'user') return;
      const c = room(ctx.projectId).agents.get(data.agent);
      if (!c) return send({ type: 'error', error: `${data.agent} 不在线` });
      if (!['cancel', 'reset'].includes(data.action)) return;
      c.ws.send(JSON.stringify({ type: 'control', action: data.action, by: ctx.name }));
      return;
    }
    default:
      send({ type: 'error', error: `未知消息类型：${data.type}` });
  }
}

// 心跳：30 秒无响应断开
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`[agent-room] http://${HOST}:${PORT}  ws://${HOST}:${PORT}/ws`);
  console.log(`[agent-room] 数据目录：${DATA_DIR}`);
  if (!ADMIN_TOKEN) console.log('[agent-room] 警告：未设置 ADMIN_TOKEN，网页端无需登录。公网部署请务必设置！');
});

export { server };
