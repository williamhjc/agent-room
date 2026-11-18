#!/usr/bin/env node
// Agent Room 服务端：HTTP API + 静态网页 + WebSocket 房间
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store, newId, parseMentions, normBarkUrl } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // 为空则网页端无需登录（仅建议本地使用）
// 网页用户的 WS 连接必须带浏览器 Origin，防止脚本/agent 拿到令牌后冒充用户发言。设为 0 关闭。
const REQUIRE_ORIGIN = process.env.REQUIRE_ORIGIN !== '0';
const ACK_CHECK_MS = parseInt(process.env.ACK_CHECK_MS || '5000', 10);
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_TEXT = 100_000;
const MAX_UPLOAD = 20 * 1024 * 1024;
const SESSION_WORKING_TTL = 3600_000; // 会话模式下"工作中"状态的最长保留时间（每次 room 命令都会续期）
const WAIT_GRACE_MS = 150_000; // room wait 断开后多久内仍算"在监听"

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
/** 发给 agent / 广播时去掉 token 和 Bark 推送地址（相当于推送密钥） */
function publicProject(p) {
  const { barkUrl, ...rest } = p;
  return { ...rest, hasBark: !!barkUrl, agents: p.agents.map(({ token, ...a }) => a) };
}

// ---------- Bark 推送：只在需要用户本人处理时通知 ----------
// 1. agent 给出了验收二维码（链接或图片附件）——可以扫码验收了
// 2. agent 需要用户确认 / 决策：room send --ask，或在消息里 @用户 并提问
// 不再看【待验收】字样（agent 之间交接也常写，推送太多）
const QR_URL_RE = /https?:\/\/[^\s<>()\[\]"'`]*(?:qr-?code|\/qr\/|[?&]qr=)[^\s<>()\[\]"'`]*/i;
const IMG_URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+\.(?:png|jpe?g|webp|gif)\b[^\s<>()\[\]"'`]*/i;
function findQr(msg) {
  const text = msg.text || '';
  const m = text.match(QR_URL_RE);
  if (m) return m[0];
  const att = (msg.attachments || []).find((a) => a.type === 'image' && /qr|二维码/i.test(a.name));
  if (att) return (process.env.PUBLIC_URL || '').replace(/\/$/, '') + att.url;
  if (/二维码/.test(text)) {
    const img = text.match(IMG_URL_RE);
    if (img) return img[0];
    const a2 = (msg.attachments || []).find((a) => a.type === 'image');
    if (a2) return (process.env.PUBLIC_URL || '').replace(/\/$/, '') + a2.url;
  }
  return null;
}
/** 群里"用户"的称呼：默认的「用户」+ 在线网页用户的昵称 + 历史上发过言的用户 */
function userNames(projectId) {
  const names = new Set(['用户']);
  for (const ws of rooms.get(projectId)?.users || []) if (ws.ctx?.name) names.add(ws.ctx.name);
  for (const m of store.getMessages(projectId).slice(-300)) if (m.fromType === 'user') names.add(m.from);
  return names;
}
function needsConfirm(projectId, msg) {
  if (msg.meta?.kind === 'ask') return true;
  const text = msg.text || '';
  if (!/[?？]/.test(text)) return false;
  return [...userNames(projectId)].some((n) => text.includes('@' + n));
}
async function sendBark(barkUrl, { title, body, sound, group, url, image }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    const res = await fetch(barkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ title, body, sound: sound || 'birdsong', group, url, image, level: 'timeSensitive' }),
      signal: ctl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data.code !== undefined && data.code !== 200)) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}
function projectLink(p) {
  const base = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  return base ? `${base}/#/p/${p.id}` : undefined;
}
const lastPush = new Map(); // 防重复：projectId:agent -> ts；qr:<链接> -> ts（同一个二维码被几个 agent 转发只推一次）
function notifyUser(p, msg, { kind, qr }) {
  if (!p.barkUrl) return;
  const now = Date.now();
  const key = `${p.id}:${msg.from}`;
  if (now - (lastPush.get(key) || 0) < 60_000) return;
  if (qr && now - (lastPush.get(`qr:${qr}`) || 0) < 6 * 3600_000) return;
  lastPush.set(key, now);
  if (qr) lastPush.set(`qr:${qr}`, now);
  const body = msg.text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/【\s*待验收\s*】|!\[[^\]]*\]\(\s*\)|[#*`>_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  sendBark(p.barkUrl, {
    title: kind === 'qr' ? `【可以验收了】${p.name}` : `【需要你确认】${p.name}`,
    body: `@${msg.from}：${body || (kind === 'qr' ? '验收二维码已发到群里' : '有事需要你确认')}`,
    sound: p.barkSound,
    group: p.name,
    url: projectLink(p),
    image: qr && IMG_URL_RE.test(qr) ? qr : undefined,
  }).catch((e) => {
    console.error('[agent-room] Bark 推送失败', e.message);
    systemMessage(p.id, `Bark 推送失败：${e.message}。请在「编辑项目」里检查推送地址。`, { kind: 'ack-timeout' });
  });
}
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readBody(req) {
  const buf = await readRaw(req, 1_000_000);
  try {
    return buf.length ? JSON.parse(buf.toString('utf8')) : {};
  } catch {
    throw new Error('JSON 解析失败');
  }
}

// ---------- 房间（在线状态 / 派活回执） ----------
/**
 * projectId -> {
 *   users: Set<ws>,
 *   agents: Map<name, AgentState>,
 *   pending: Map<name, Map<msgId, {ts, from, text, warned}>>   // 已派发但未确认接单
 * }
 * AgentState = { conns:Set<ws>, status, note, since, host, lastActivity, idleSince, ackCapable }
 * 连接 mode：listener（connector/桥接，常驻） | wait（room wait，等待消息） | tool（一次性命令）
 */
const rooms = new Map();
function room(id) {
  if (!rooms.has(id)) rooms.set(id, { users: new Set(), agents: new Map(), pending: new Map() });
  return rooms.get(id);
}
function agentState(projectId, name) {
  const r = room(projectId);
  if (!r.agents.has(name)) {
    r.agents.set(name, { conns: new Set(), status: 'idle', note: '', since: null, host: '', lastActivity: 0, idleSince: Date.now(), ackCapable: false });
  }
  return r.agents.get(name);
}
const ACTIVE_CMDS = new Set(['send', 'inbox', 'show', 'history', 'get', 'recall', 'status']);
function cleanInfo(i) {
  if (!i || typeof i !== 'object') return null;
  const str = (v, n = 60) => (v == null ? '' : String(v).slice(0, n));
  return { cli: str(i.cli, 10), model: str(i.model), effort: str(i.effort, 20), source: str(i.source, 10), version: str(i.version, 30), ts: Date.now() };
}
function connsOf(st, ...modes) {
  return [...st.conns].filter((ws) => modes.includes(ws.ctx.mode));
}
function setAgentStatus(st, status, note = '', until = null) {
  status = ['idle', 'working', 'error', 'quota'].includes(status) ? status : 'idle';
  // quota：模型额度用完 / 限流，until 为预计恢复时间（毫秒时间戳）
  st.until = status === 'quota' && Number(until) > 0 ? Number(until) : null;
  if (status !== 'working' && st.status === 'working') st.idleSince = Date.now();
  if (status === 'working' && st.status !== 'working') st.workingSince = Date.now();
  st.status = status;
  st.note = String(note || '').slice(0, 200);
  st.statusAt = Date.now();
}
function pendingOf(projectId, name) {
  const r = room(projectId);
  if (!r.pending.has(name)) r.pending.set(name, new Map());
  return r.pending.get(name);
}

// 待接单记录持久化到 DATA_DIR/pending.json，服务重启后仍能提醒 / 补派
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
let pendingSaveTimer = null;
function markPendingDirty() {
  if (pendingSaveTimer) return;
  pendingSaveTimer = setTimeout(() => {
    pendingSaveTimer = null;
    const out = {};
    for (const [pid, r] of rooms) {
      for (const [name, m] of r.pending) {
        if (!m.size) continue;
        (out[pid] ||= {})[name] = Object.fromEntries(m);
      }
    }
    try {
      fs.writeFileSync(PENDING_FILE + '.tmp', JSON.stringify(out));
      fs.renameSync(PENDING_FILE + '.tmp', PENDING_FILE);
    } catch (e) {
      console.error('[agent-room] 保存 pending 失败', e.message);
    }
  }, 300);
}
try {
  const saved = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  for (const [pid, agents] of Object.entries(saved)) {
    if (!store.getProject(pid)) continue;
    for (const [name, entries] of Object.entries(agents)) {
      // 重启后重新计时，避免一启动就批量报超时
      const m = pendingOf(pid, name);
      for (const [id, e] of Object.entries(entries)) m.set(id, { ...e, ts: Math.max(e.ts, Date.now() - 1000) , origTs: e.origTs || e.ts });
    }
  }
} catch {}
function presence(projectId) {
  const p = store.getProject(projectId);
  const r = room(projectId);
  return (p?.agents || []).map((a) => {
    const st = r.agents.get(a.name);
    const listeners = st ? connsOf(st, 'listener') : [];
    const waits = st ? connsOf(st, 'wait') : [];
    // 会话模式 room wait 超时后要由 agent 重新运行，中间有几秒到一两分钟的空档，不算离线
    const waitGrace = !!st && !listeners.length && st.lastMode === 'wait' && Date.now() - (st.waitGoneAt || 0) < WAIT_GRACE_MS;
    const listening = listeners.length > 0 || waits.length > 0 || waitGrace;
    // 会话模式（room wait）在处理任务时没有常驻连接，但仍算"工作中"
    const sessionWorking = st && st.status === 'working' && Date.now() - (st.statusAt || 0) < SESSION_WORKING_TTL;
    const online = listening || !!sessionWorking;
    return {
      name: a.name,
      type: a.type,
      online,
      listening,
      mode: listeners.length ? 'connector' : st?.lastMode === 'wait' ? 'session' : '',
      status: online ? st.status : 'offline',
      note: online ? st.note : '',
      until: online && st.status === 'quota' ? st.until : null,
      since: st?.since || null,
      host: st?.host || '',
      pending: r.pending.get(a.name)?.size || 0,
      usage: st?.usage || null, // 订阅额度（离线也保留最后一次，网页标注时间）
      info: st?.info || null, // 当前模型 / CLI 版本
      lastActivity: st?.lastActivity || null,
      workingSince: online && st.status === 'working' ? st.workingSince || null : null,
    };
  });
}
function broadcast(projectId, data, { usersOnly = false } = {}) {
  const r = rooms.get(projectId);
  if (!r) return;
  const raw = JSON.stringify(data);
  for (const ws of r.users) if (ws.readyState === 1) ws.send(raw);
  if (!usersOnly) for (const st of r.agents.values()) for (const ws of st.conns) if (ws.readyState === 1) ws.send(raw);
}
let presenceTimer = new Map();
function broadcastPresence(projectId) {
  // 合并短时间内的多次更新
  if (presenceTimer.has(projectId)) return;
  presenceTimer.set(
    projectId,
    setTimeout(() => {
      presenceTimer.delete(projectId);
      broadcast(projectId, { type: 'presence', agents: presence(projectId) }, { usersOnly: true });
    }, 50)
  );
}

function systemMessage(projectId, text, meta) {
  return postMessage(projectId, { from: 'system', fromType: 'system', text, meta });
}

/** 写入并广播一条消息，计算 @提及与派发对象 */
function postMessage(projectId, { from, fromType, text, replyTo, attachments, meta }) {
  const p = store.getProject(projectId);
  if (!p) throw new Error('项目不存在');
  text = String(text || '').slice(0, MAX_TEXT);
  const history = store.getMessages(projectId);
  let depth = 0;
  if (fromType === 'agent') {
    const parent = replyTo && findMessage(history, replyTo);
    depth = parent ? (parent.depth || 0) + 1 : 1;
  }
  // 系统消息和 agent 的自动进展消息只展示，不派活
  const mentions = fromType === 'system' || meta?.kind === 'progress' ? [] : parseMentions(text, p.agents).filter((n) => n !== from);
  let dispatch = mentions;
  let notice = null;
  if (p.paused && mentions.length) {
    dispatch = [];
    notice = '项目已暂停，@提及不会触发 agent。点击「恢复」后重新发送。';
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
  if (attachments?.length) msg.attachments = attachments;
  if (meta) msg.meta = meta;
  // 需要用户本人处理的消息：给出验收二维码 → review；需要用户确认 → ask。这两种推送 Bark
  let push = null;
  if (fromType === 'agent' && !['progress', 'quota', 'quota-ok'].includes(meta?.kind)) {
    const qr = findQr(msg);
    if (qr) push = { kind: 'qr', qr };
    else if (needsConfirm(projectId, msg)) push = { kind: 'ask' };
    if (push) msg.meta = { ...(msg.meta || {}), kind: push.kind === 'qr' ? 'review' : 'ask', ...(push.qr ? { qr: push.qr } : {}) };
  }
  store.addMessage(projectId, msg);
  if (push) notifyUser(p, msg, push);
  const quotaNotes = [];

  // 发送者是 agent：更新活跃时间；不支持回执的旧客户端，发言即视为已接单
  if (fromType === 'agent') {
    const st = agentState(projectId, from);
    st.lastActivity = Date.now();
    if (meta?.kind !== 'progress') st.lastPostAt = Date.now();
    if (!st.ackCapable && pendingOf(projectId, from).size) {
      pendingOf(projectId, from).clear();
      markPendingDirty();
    }
  }
  for (const name of dispatch) {
    pendingOf(projectId, name).set(msg.id, { ts: msg.ts, from, text: text.slice(0, 60), warned: false });
    // 派给额度用完的 agent：提醒发消息的人先做别的（同一 agent 10 分钟内只提醒一次）
    const st = room(projectId).agents.get(name);
    if (st?.status === 'quota' && st.conns.size && Date.now() - (st.quotaNoticeAt || 0) > 10 * 60_000) {
      st.quotaNoticeAt = Date.now();
      quotaNotes.push(`@${name} 的模型额度暂时用完了${st.until ? `，预计${fmtLeft(st.until)}恢复` : ''}。消息已排队，恢复后它会自动处理；在此之前不用等它，可以先推进不依赖它的工作。`);
    }
  }
  if (dispatch.length) markPendingDirty();

  broadcast(projectId, { type: 'message', message: msg });
  if (dispatch.length || fromType === 'agent') broadcastPresence(projectId);
  if (notice) systemMessage(projectId, notice);
  for (const t of quotaNotes) systemMessage(projectId, t, { kind: 'quota' });
  return msg;
}
/** "约 2 小时 5 分钟后" —— 用相对时间，避免服务器和读者时区不同 */
function fmtLeft(until) {
  const min = Math.max(1, Math.round((until - Date.now()) / 60_000));
  if (min < 60) return `约 ${min} 分钟后`;
  const h = Math.floor(min / 60);
  if (h < 48) return `约 ${h} 小时${min % 60 ? ` ${min % 60} 分钟` : ''}后`;
  return `约 ${Math.round(h / 24)} 天后`;
}
function findMessage(history, id) {
  for (let i = history.length - 1; i >= 0; i--) if (history[i].id === id) return history[i];
  return null;
}

/** 撤回：清空内容、取消派发（还没接单的不再派；正在处理的连接器会收到通知自行停止） */
function recallMessage(projectId, m, by) {
  if (m.recalled) return;
  const targets = m.dispatch || [];
  const updated = store.updateMessage(projectId, m.id, { recalled: true, recalledBy: by, recalledAt: Date.now(), text: '', attachments: [], mentions: [], dispatch: [] });
  for (const name of targets) pendingOf(projectId, name).delete(m.id);
  markPendingDirty();
  broadcast(projectId, { type: 'recall', id: m.id, message: updated });
  broadcastPresence(projectId);
}

function ackMessages(projectId, agent, ids) {
  const pend = pendingOf(projectId, agent);
  const warnedOnes = [];
  for (const id of ids) {
    const e = pend.get(id);
    if (!e) continue;
    if (e.warned) warnedOnes.push(e);
    pend.delete(id);
  }
  markPendingDirty();
  if (warnedOnes.length) systemMessage(projectId, `@${agent} 已接单（此前超时未响应的 ${warnedOnes.length} 条消息）。`, { kind: 'ack-late', agent });
  broadcastPresence(projectId);
}

/** 定期检查：派发后长时间无人接单就在群里提示，让用户知道 agent "停了" */
function checkAcks() {
  const now = Date.now();
  for (const [projectId, r] of rooms) {
    const p = store.getProject(projectId);
    if (!p) continue;
    const T = (p.ackTimeoutSec || 60) * 1000;
    for (const [name, pend] of r.pending) {
      if (!p.agents.find((a) => a.name === name)) {
        r.pending.delete(name);
        continue;
      }
      const st = r.agents.get(name);
      const hasListener = st && connsOf(st, 'listener').length > 0;
      const hasWait = st && connsOf(st, 'wait').length > 0;
      const working = st?.status === 'working';
      const due = [];
      for (const [id, e] of pend) {
        if (e.warned) continue;
        if (hasWait) continue; // 等待中的会话马上会拿到
        if (hasListener && (working || st.status === 'quota')) continue; // 连接器正忙或等额度恢复，排队中
        if (hasListener && !st.ackCapable) continue; // 旧客户端不会回执，在线时无法判断，不误报
        // 连接器空闲：从它空闲时开始计时；会话模式忙碌时放宽到 10 倍
        let start = e.ts;
        if (hasListener) start = Math.max(e.ts, st.idleSince || 0);
        const limit = !hasListener && working ? T * 10 : T;
        if (now - start >= limit) due.push([id, e]);
      }
      if (!due.length) continue;
      for (const [, e] of due) e.warned = true;
      markPendingDirty();
      let reason;
      if (hasListener) reason = '连接器在线但没有开始处理，可能卡住了，可以在成员面板「中止」后重试';
      else if (working) reason = '它还在处理之前的任务，且没有在监听新消息（会话模式需在完成后运行 room wait）';
      else if (st && st.lastMode === 'wait') reason = '它的会话没有在监听（完成上一轮后没有再运行 room wait），需要唤醒它';
      else reason = '它当前离线，请启动它的连接器';
      const secs = Math.round((now - (due[0][1].origTs || due[0][1].ts)) / 1000);
      systemMessage(
        projectId,
        `⚠️ @${name} 有 ${due.length} 条派发 ${secs} 秒未接单：${reason}。消息已保留，它上线 / 监听后会收到。`,
        { kind: 'ack-timeout', agent: name, ids: due.map(([id]) => id) }
      );
    }
  }
}
setInterval(checkAcks, ACK_CHECK_MS).unref();

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};
const INLINE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.log', '.json', '.pdf']);
const EXT_BY_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'text/plain': '.txt', 'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json' };

function serveFile(res, file, { download = false, name } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': (download ? null : MIME[ext]) || 'application/octet-stream',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
    };
    if (download) {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name || path.basename(file))}`;
      headers['Cache-Control'] = 'private, max-age=86400';
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  // 方便远程机器直接下载连接器和 room 工具，无需克隆仓库
  const am = pathname.match(/^\/agent\/(connector|room|common)\.js$/);
  if (am) return serveFile(res, path.join(ROOT, 'agent', `${am[1]}.js`));
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
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

/** 上传的附件：/files/<projectId>/<fileId><ext>，文件名不可猜测，图片等安全类型内联显示，其余一律下载 */
function serveUpload(req, res, url) {
  const m = url.pathname.match(/^\/files\/([\w-]+)\/([\w-]+)(\.[a-z0-9]{1,8})?$/);
  if (!m) return sendJson(res, 404, { error: 'not found' });
  const file = path.join(store.uploadDir(m[1]), m[2] + (m[3] || ''));
  const ext = (m[3] || '').toLowerCase();
  serveFile(res, file, { download: !INLINE_TYPES.has(ext) || url.searchParams.has('download'), name: url.searchParams.get('name') || undefined });
}

/** 鉴权：管理员令牌 或 某个 agent 的 token（Authorization: Agent <token>） */
function authOf(req, project) {
  const h = req.headers.authorization || '';
  const m = h.match(/^(Bearer|Agent)\s+(.+)$/i);
  const kind = m?.[1].toLowerCase();
  const tok = m?.[2].trim() || '';
  if (kind === 'agent' && project) {
    const a = project.agents.find((x) => safeEqual(x.token, tok));
    return a ? { agent: a.name } : null;
  }
  return isAdmin(tok) ? { admin: true } : null;
}

/** POST /api/bark-test { projectId?, barkUrl?, barkSound? }：测试推送，可传入尚未保存的地址 */
async function barkTest(req, res) {
  if (!authOf(req, null)?.admin) return sendJson(res, 401, { error: '未授权：请输入正确的访问令牌' });
  const body = await readBody(req);
  const p = body.projectId ? store.getProject(body.projectId) : null;
  let barkUrl;
  try {
    barkUrl = body.barkUrl ? normBarkUrl(body.barkUrl) : p?.barkUrl;
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  if (!barkUrl) return sendJson(res, 400, { error: '请先填写 Bark 推送地址' });
  try {
    await sendBark(barkUrl, {
      title: 'Agent Room 测试推送',
      body: `${p ? `项目「${p.name}」` : '新项目'}：agent 完成开发测试、需要你验收时会这样通知你。`,
      sound: body.barkSound || p?.barkSound || 'birdsong',
      group: p?.name || 'Agent Room',
      url: p ? projectLink(p) : undefined,
    });
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    return sendJson(res, 502, { error: `推送失败：${e.message}` });
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'config' && req.method === 'GET') {
    return sendJson(res, 200, { authRequired: !!ADMIN_TOKEN, publicUrl: process.env.PUBLIC_URL || '' });
  }
  if (parts[1] === 'bark-test' && req.method === 'POST') return barkTest(req, res);
  if (parts[1] !== 'projects') return sendJson(res, 404, { error: 'not found' });
  const id = parts[2];
  const p = id ? store.getProject(id) : null;
  const auth = authOf(req, p);
  if (!auth) return sendJson(res, 401, { error: '未授权：请输入正确的访问令牌' });
  if (id && !p) return sendJson(res, 404, { error: '项目不存在' });

  // 上传附件：管理员和该项目的 agent 都可以
  if (parts[3] === 'uploads' && req.method === 'POST') {
    const buf = await readRaw(req, MAX_UPLOAD);
    if (!buf.length) return sendJson(res, 400, { error: '空文件' });
    const name = String(url.searchParams.get('name') || 'file').replace(/[\\/\0\r\n]/g, '_').slice(0, 120);
    let ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 9);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!ext) ext = EXT_BY_TYPE[type] || '';
    const fid = newId(20);
    fs.mkdirSync(store.uploadDir(id), { recursive: true });
    fs.writeFileSync(path.join(store.uploadDir(id), fid + ext), buf);
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
    return sendJson(res, 201, {
      attachment: { url: `/files/${id}/${fid}${ext}`, name, size: buf.length, type: isImage ? 'image' : 'file' },
    });
  }

  // 以下仅管理员
  if (!auth.admin) return sendJson(res, 403, { error: '该操作需要管理员令牌' });


  if (!id) {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        projects: store.listProjects().map((x) => ({
          ...publicProject(x),
          online: presence(x.id).filter((a) => a.online).length,
          messageCount: store.getMessages(x.id).length,
        })),
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const np = store.createProject(body);
      systemMessage(np.id, `项目「${np.name}」已创建，成员：${np.agents.map((a) => `@${a.name}（${a.type}）`).join('、')}`);
      return sendJson(res, 201, { project: np });
    }
  }

  if (parts.length === 3) {
    if (req.method === 'GET') return sendJson(res, 200, { project: p, presence: presence(id) });
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const before = new Set(p.agents.map((a) => a.name));
      const wasPaused = p.paused;
      const updated = store.updateProject(id, body);
      const r = room(id);
      for (const [name, st] of r.agents) {
        if (!updated.agents.find((a) => a.name === name)) {
          for (const ws of st.conns) ws.close(4003, 'agent removed');
          r.agents.delete(name);
          r.pending.delete(name);
        }
      }
      broadcast(id, { type: 'project', project: publicProject(updated) });
      broadcastPresence(id);
      if (body.paused !== undefined && wasPaused !== updated.paused) {
        systemMessage(id, updated.paused ? '项目已暂停。' : '项目已恢复。');
      }
      const added = updated.agents.filter((a) => !before.has(a.name));
      if (added.length) systemMessage(id, `新成员加入分工：${added.map((a) => '@' + a.name).join('、')}`);
      return sendJson(res, 200, { project: updated });
    }
    if (req.method === 'DELETE') {
      const r = room(id);
      for (const st of r.agents.values()) for (const ws of st.conns) ws.close(4004, 'project deleted');
      for (const ws of r.users) ws.close(4004, 'project deleted');
      rooms.delete(id);
      store.deleteProject(id);
      markPendingDirty();
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
    if (url.pathname.startsWith('/files/')) return serveUpload(req, res, url);
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (e) {
    if (!res.headersSent) sendJson(res, 400, { error: e.message || String(e) });
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
      send({ type: 'error', error: e.message || String(e), clientId: data.clientId });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    const ctx = ws.ctx;
    if (!ctx) return;
    const r = room(ctx.projectId);
    if (ctx.kind === 'user') return r.users.delete(ws);
    const st = r.agents.get(ctx.agent);
    if (!st) return;
    st.conns.delete(ws);
    if (ctx.mode === 'listener' && !connsOf(st, 'listener').length && st.status === 'working') setAgentStatus(st, 'idle');
    if (ctx.mode === 'wait' && !connsOf(st, 'wait').length) {
      st.waitGoneAt = Date.now();
      setTimeout(() => broadcastPresence(ctx.projectId), WAIT_GRACE_MS + 1000).unref?.();
    }
    if (ctx.mode !== 'tool') broadcastPresence(ctx.projectId);
  });
});

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const u = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return u.host === host;
  } catch {
    return false;
  }
}

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
    const mode = ['listener', 'wait', 'tool'].includes(data.mode) ? data.mode : 'listener';
    const st = agentState(p.id, def.name);
    // 同名常驻连接只保留一个（避免两个连接器重复干活）；等待连接也只保留最新的
    if (mode !== 'tool') {
      for (const old of connsOf(st, mode)) {
        try {
          old.send(JSON.stringify({ type: 'error', error: `同名 agent 的另一个 ${mode} 连接上线，本连接被替换`, fatal: true }));
        } catch {}
        old.close(4009, 'replaced');
        st.conns.delete(old);
      }
    }
    ws.ctx = { kind: 'agent', projectId: p.id, agent: def.name, mode };
    st.conns.add(ws);
    if (Array.isArray(data.caps) && data.caps.includes('ack')) st.ackCapable = true;
    else if (mode === 'listener') st.ackCapable = false;
    st.lastActivity = Date.now();
    if (mode !== 'tool') {
      st.since = Date.now();
      st.host = String(data.host || req.socket.remoteAddress || '').slice(0, 100);
      st.lastMode = mode;
    }
    if (data.info) st.info = cleanInfo(data.info);
    const noListener = !connsOf(st, 'listener').length;
    if (mode === 'wait') {
      // 正在干活的会话可能把 room wait 放到后台跑：开始干活后还没发过言，就继续算"工作中"（最多 30 分钟）
      const busy = st.status === 'working' && (st.lastPostAt || 0) < (st.workingSince || 0) && Date.now() - (st.workingSince || 0) < 30 * 60_000;
      if (!busy && st.status !== 'quota') setAgentStatus(st, 'idle', '等待新消息');
    } else if (mode === 'tool' && noListener && ACTIVE_CMDS.has(data.cmd) && st.status !== 'quota') {
      // 会话模式在两次 room wait 之间用 room send / inbox 等命令，说明它正在干活
      if (st.status === 'working') st.statusAt = Date.now();
      else setAgentStatus(st, 'working', '会话处理中');
      broadcastPresence(p.id);
    }
    const { token, ...self } = def;
    const n = Math.min(500, Math.max(1, parseInt(data.historyLimit || 100, 10)));
    send({
      type: 'welcome',
      kind: 'agent',
      mode,
      project: publicProject(p),
      self,
      history: store.getMessages(p.id).slice(-n),
      pending: [...pendingOf(p.id, def.name).keys()],
      presence: presence(p.id),
    });
    if (mode !== 'tool') broadcastPresence(p.id);
    return;
  }
  // 用户（网页端）
  if (!isAdmin(data.token)) {
    send({ type: 'error', error: '未授权', fatal: true });
    return ws.close(4001, 'unauthorized');
  }
  if (REQUIRE_ORIGIN && !sameOrigin(req)) {
    send({ type: 'error', error: '用户身份只能从网页端连接（缺少或不匹配的 Origin）。agent 请使用自己的 token 接入。', fatal: true });
    return ws.close(4002, 'origin required');
  }
  const name = String(data.name || '用户').trim().slice(0, 32) || '用户';
  const lower = name.toLowerCase();
  if (p.agents.some((a) => a.name.toLowerCase() === lower) || ['system', '系统', 'all', '所有人'].includes(lower)) {
    send({ type: 'error', error: `昵称「${name}」与 agent 或保留名重复，请换一个`, fatal: true });
    return ws.close(4002, 'bad name');
  }
  ws.ctx = { kind: 'user', projectId: p.id, name };
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

function cleanAttachments(projectId, list) {
  if (!Array.isArray(list)) return [];
  const re = new RegExp(`^/files/${projectId}/[\\w-]+(\\.[a-z0-9]{1,8})?$`);
  return list
    .slice(0, 10)
    .filter((a) => a && re.test(a.url) && fs.existsSync(path.join(store.uploadDir(projectId), path.basename(a.url))))
    .map((a) => ({
      url: a.url,
      name: String(a.name || path.basename(a.url)).slice(0, 120),
      size: Number(a.size) || 0,
      type: a.type === 'image' ? 'image' : 'file',
    }));
}

/** 订阅额度上报：只保留展示需要的字段 */
function cleanUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const str = (v, n = 40) => (v == null ? '' : String(v).slice(0, n));
  const out = { cli: str(u.cli, 10), ts: num(u.ts) || Date.now() };
  if (u.error) return { ...out, error: str(u.error, 200) };
  Object.assign(out, {
    plan: str(u.plan),
    planLabel: str(u.planLabel),
    main: str(u.main, 20),
    source: str(u.source, 20),
    note: str(u.note, 200),
    asOf: num(u.asOf),
    limited: !!u.limited,
    resetsAt: num(u.resetsAt),
    windows: (Array.isArray(u.windows) ? u.windows : []).slice(0, 6).map((w) => ({
      key: str(w?.key, 20),
      label: str(w?.label, 30),
      used: Math.max(0, Math.min(100, num(w?.used) ?? 0)),
      resetsAt: num(w?.resetsAt),
      windowMin: num(w?.windowMin),
    })),
  });
  return out;
}

/** agent 发言可附带的展示标记（白名单） */
function agentMeta(meta) {
  if (!meta || !['quota', 'quota-ok', 'progress', 'ask'].includes(meta.kind)) return undefined;
  return { kind: meta.kind, until: Number(meta.until) > 0 ? Number(meta.until) : undefined };
}

function onMessage(ws, data, send) {
  const ctx = ws.ctx;
  const st = ctx.kind === 'agent' ? agentState(ctx.projectId, ctx.agent) : null;
  if (st) st.lastActivity = Date.now();
  switch (data.type) {
    case 'ping':
      return send({ type: 'pong', ts: Date.now() });
    case 'message': {
      const text = String(data.text || '').trim();
      const attachments = cleanAttachments(ctx.projectId, data.attachments);
      if (!text && !attachments.length) return send({ type: 'error', error: '消息为空', clientId: data.clientId });
      const msg =
        ctx.kind === 'agent'
          ? postMessage(ctx.projectId, { from: ctx.agent, fromType: 'agent', text, replyTo: data.replyTo, attachments, meta: agentMeta(data.meta) })
          : postMessage(ctx.projectId, { from: ctx.name, fromType: 'user', text, attachments });
      if (data.clientId) send({ type: 'sent', clientId: data.clientId, id: msg.id });
      return;
    }
    case 'ack': {
      // agent 确认接单：ids 为开始处理的消息
      if (!st) return;
      const ids = (Array.isArray(data.ids) ? data.ids : [data.id]).filter(Boolean).map(String);
      ackMessages(ctx.projectId, ctx.agent, ids);
      if (ctx.mode === 'wait' && ids.length) setAgentStatus(st, 'working', data.note || '处理新消息');
      broadcastPresence(ctx.projectId);
      if (data.clientId) send({ type: 'acked', clientId: data.clientId });
      return;
    }
    case 'status': {
      if (!st) return;
      setAgentStatus(st, data.status, data.note, data.until);
      broadcastPresence(ctx.projectId);
      if (data.clientId) send({ type: 'acked', clientId: data.clientId });
      return;
    }
    case 'info': {
      if (!st) return;
      st.info = cleanInfo(data.info);
      broadcastPresence(ctx.projectId);
      if (data.clientId) send({ type: 'acked', clientId: data.clientId });
      return;
    }
    case 'recall': {
      // 撤回：网页用户可以撤回任何消息；agent 只能撤回自己的
      const m = findMessage(store.getMessages(ctx.projectId), String(data.id || ''));
      if (!m) return send({ type: 'error', error: '消息不存在', clientId: data.clientId });
      if (ctx.kind === 'agent' && !(m.fromType === 'agent' && m.from === ctx.agent)) return send({ type: 'error', error: '只能撤回自己发的消息', clientId: data.clientId });
      if (m.fromType === 'system') return send({ type: 'error', error: '系统消息不能撤回', clientId: data.clientId });
      recallMessage(ctx.projectId, m, ctx.kind === 'agent' ? ctx.agent : ctx.name);
      if (data.clientId) send({ type: 'acked', clientId: data.clientId });
      return;
    }
    case 'usage': {
      // agent 上报本机 CLI 的订阅额度（connector 定时查询 / room usage）
      if (!st) return;
      st.usage = cleanUsage(data.usage);
      broadcastPresence(ctx.projectId);
      if (data.clientId) send({ type: 'acked', clientId: data.clientId });
      return;
    }
    case 'control': {
      // 用户 -> agent 的控制指令（cancel：中止正在执行的任务；reset：清空会话）
      if (ctx.kind !== 'user') return;
      const target = room(ctx.projectId).agents.get(data.agent);
      const listeners = target ? connsOf(target, 'listener') : [];
      if (!listeners.length) return send({ type: 'error', error: `${data.agent} 没有在线的连接器，无法远程控制` });
      if (!['cancel', 'reset'].includes(data.action)) return;
      for (const l of listeners) l.send(JSON.stringify({ type: 'control', action: data.action, by: ctx.name }));
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
