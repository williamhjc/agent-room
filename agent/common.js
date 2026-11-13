// connector.js 与 room.js 共用的工具：配置、本地状态、消息格式化、WS 连接、上传
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let WSImpl = globalThis.WebSocket;
if (!WSImpl) {
  try {
    WSImpl = (await import('ws')).default;
  } catch {
    console.error('当前 Node 没有内置 WebSocket：请升级到 Node ≥ 22，或在本目录执行 npm i ws');
    process.exit(1);
  }
}
export const WS = WSImpl;

/** 解析命令行：--k v、--flag、可重复的 --attach，以及位置参数 */
export function parseArgs(argv, repeatable = [], valueKeys = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    const short = /^-[a-zA-Z]$/.test(a);
    if (!a.startsWith('--') && !short) {
      out._.push(a);
      continue;
    }
    const eq = short ? -1 : a.indexOf('=');
    let key = a.slice(short ? 1 : 2);
    let val;
    if (eq > 0) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      // valueKeys 中的参数总是吃掉下一个值（例如 --extra "--allowedTools Bash"）
      if (next === undefined || (next.startsWith('--') && !valueKeys.includes(key))) val = true;
      else {
        val = next;
        i++;
      }
    }
    if (repeatable.includes(key)) (out[key] ||= []).push(val);
    else out[key] = val;
  }
  return out;
}

/** 连接配置：命令行 > 环境变量 > --config 文件 > 当前目录 .agent-room.json */
export function loadConn(args) {
  const env = process.env;
  let file = {};
  const cfgPath = args.config || env.AGENT_ROOM_CONFIG || path.join(process.cwd(), '.agent-room.json');
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  return {
    server: args.server || env.AGENT_ROOM_SERVER || file.server || 'ws://127.0.0.1:8787/ws',
    project: args.project || env.AGENT_ROOM_PROJECT || file.project,
    agent: args.agent || env.AGENT_ROOM_AGENT || file.agent,
    token: args.token || env.AGENT_ROOM_TOKEN || file.token,
  };
}

export function httpBase(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  return u.toString().replace(/\/$/, '');
}

/**
 * 生成 room 命令包装（room / room.cmd），放到 PATH 前面，
 * 让 CLI 子进程直接用 `room inbox` 之类的短命令，也便于按命令前缀放行权限。
 */
export function ensureRoomShim(roomJs) {
  const dir = path.join(os.homedir(), '.agent-room', 'bin-shim');
  fs.mkdirSync(dir, { recursive: true });
  const node = process.execPath;
  const fwd = (p) => p.replace(/\\/g, '/');
  const sh = `#!/bin/sh\nexec "${fwd(node)}" "${fwd(roomJs)}" "$@"\n`;
  const cmd = `@echo off\r\n"${node}" "${roomJs}" %*\r\n`;
  const write = (f, c, mode) => {
    const p = path.join(dir, f);
    try {
      if (fs.readFileSync(p, 'utf8') === c) return;
    } catch {}
    fs.writeFileSync(p, c, { mode });
  };
  write('room', sh, 0o755);
  if (process.platform === 'win32') write('room.cmd', cmd);
  return dir;
}

// ---------- 本地状态（connector 与 room 工具共享，用于"已读游标"） ----------
export const stateDir = path.join(os.homedir(), '.agent-room', 'state');
export function stateFile(conn) {
  return path.join(stateDir, `${conn.project}-${String(conn.agent).replace(/[^\w-]/g, '_')}.json`);
}
export function readState(conn) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(conn), 'utf8'));
  } catch {
    return {};
  }
}
/** 读-改-写，尽量减少与另一个进程的覆盖冲突 */
export function updateState(conn, patch) {
  fs.mkdirSync(stateDir, { recursive: true });
  const cur = readState(conn);
  const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
  const f = stateFile(conn);
  fs.writeFileSync(f + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(f + '.tmp', f);
  return next;
}

// ---------- 消息格式化 ----------
export function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
export function fmtMessage(m, { base = '', maxLen = 3000, me = '' } = {}) {
  const who = m.fromType === 'user' ? `${m.from}（用户）` : m.fromType === 'system' ? '系统' : `@${m.from}`;
  let text = m.text || '';
  if (maxLen && text.length > maxLen) {
    text = text.slice(0, maxLen) + `\n…（已截断，全文 ${m.text.length} 字，可运行 room show ${m.id} 查看）`;
  }
  const att = (m.attachments || []).map((a) => `\n[附件${a.type === 'image' ? '·图片' : ''}] ${a.name} ${base}${a.url}`).join('');
  const forMe = me && Array.isArray(m.dispatch) && m.dispatch.includes(me) ? ' 【@你】' : '';
  return `[${fmtTime(m.ts)}] (id=${m.id}) ${who}${forMe}: ${text}${att}`;
}

// ---------- 一次性连接（room 工具用） ----------
/**
 * 连接并完成 hello，返回 { welcome, send, request, onMessage, close }
 * request(data) 会附带 clientId，等待服务端回执（sent/acked/error）
 */
export function connectAgent(conn, { mode = 'tool', historyLimit = 100, onMessage, onClose, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WS(conn.server);
    const waiters = new Map();
    let welcomed = false;
    const timer = setTimeout(() => {
      if (!welcomed) {
        try {
          ws.close();
        } catch {}
        reject(new Error(`连接 ${conn.server} 超时`));
      }
    }, timeoutMs);
    const send = (d) => ws.readyState === 1 && ws.send(JSON.stringify(d));
    let seq = 0;
    const request = (d) =>
      new Promise((res, rej) => {
        const clientId = `c${Date.now()}_${seq++}`;
        const t = setTimeout(() => {
          if (waiters.has(clientId)) {
            waiters.delete(clientId);
            rej(new Error('服务端无响应'));
          }
        }, timeoutMs);
        const done = (fn) => (v) => {
          clearTimeout(t);
          fn(v);
        };
        waiters.set(clientId, { res: done(res), rej: done(rej) });
        send({ ...d, clientId });
      });
    ws.onopen = () =>
      send({ type: 'hello', kind: 'agent', mode, caps: ['ack'], historyLimit, projectId: conn.project, agent: conn.agent, token: conn.token, host: os.hostname() });
    ws.onmessage = (ev) => {
      let d;
      try {
        d = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (d.clientId && waiters.has(d.clientId)) {
        const w = waiters.get(d.clientId);
        waiters.delete(d.clientId);
        return d.type === 'error' ? w.rej(new Error(d.error)) : w.res(d);
      }
      if (d.type === 'welcome' && !welcomed) {
        welcomed = true;
        clearTimeout(timer);
        return resolve({ welcome: d, send, request, close: () => ws.close(), ws });
      }
      if (d.type === 'error' && !welcomed) {
        clearTimeout(timer);
        return reject(new Error(d.error));
      }
      onMessage?.(d);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (!welcomed) reject(new Error(`连接被关闭 code=${ev.code} ${ev.reason || ''}`));
      for (const w of waiters.values()) w.rej(new Error('连接已关闭'));
      waiters.clear();
      if (welcomed) onClose?.(ev);
    };
  });
}

// ---------- 上传附件 ----------
export async function uploadFile(conn, filePath) {
  const buf = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  const res = await fetch(`${httpBase(conn.server)}/api/projects/${conn.project}/uploads?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Authorization: `Agent ${conn.token}`, 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`上传 ${name} 失败：${data.error || res.status}`);
  return data.attachment;
}

// ---------- 模型额度用完 / 限流识别 ----------
// 只在 CLI 报错时调用（正常输出里谈到 "rate limit" 不算）。返回 { until, transient, text } 或 null。
const LIMIT_RE =
  /usage limit|hit your (?:usage )?limit|limit (?:reached|exceeded)|rate[ _-]?limit|quota|too many requests|\b429\b|insufficient_quota|overloaded|\b529\b|额度|限额|用量上限/i;
const TRANSIENT_RE = /overloaded|\b529\b|too many requests|\b429\b/i;
export function detectLimit(text, now = Date.now()) {
  text = String(text || '');
  if (!LIMIT_RE.test(text)) return null;
  const transient = TRANSIENT_RE.test(text) && !/usage limit|hit your|quota|额度/i.test(text);
  let until = parseReset(text, now);
  if (until && (until < now || until > now + 8 * 86400_000)) until = null;
  return { until, transient, text: text.replace(/\s+/g, ' ').trim().slice(0, 240) };
}
/** CLI 正常退出但结果本身就是一句额度提示（旧版 claude -p 会这样） */
export function looksLikeLimitResult(text) {
  const t = String(text || '').trim();
  return t.length < 400 && /usage limit reached|hit your (?:usage )?limit|limit reached\s*[·∙•|-]\s*resets/i.test(t);
}

/** 墙上时间 h:m 在时区 tz 下、now 之后最近的一次 */
function nextWallClock(h, min, tz, now) {
  let offset = 0; // tz 相对本机的偏移
  if (tz) {
    try {
      const d = new Date(now);
      const inTz = new Date(d.toLocaleString('en-US', { timeZone: tz }));
      const local = new Date(d.toLocaleString('en-US'));
      offset = inTz - local;
    } catch {}
  }
  const d = new Date(now + offset);
  d.setHours(h, min, 0, 0);
  let t = d.getTime() - offset;
  if (t <= now) t += 86400_000;
  return t;
}

export function parseReset(text, now = Date.now()) {
  let m;
  // Claude 旧格式：Claude AI usage limit reached|1731500000
  if ((m = text.match(/\|(\d{10})\b/))) return +m[1] * 1000;
  if ((m = text.match(/retry[- ]after[:\s]+(\d+)\s*(?:s|sec|secs|seconds)?\b/i))) return now + +m[1] * 1000;
  // try again in 2 days 3 hours / in 45 minutes / 5h 3m
  if ((m = text.match(/\bin\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i))) {
    let ms = 0;
    for (const [, n, u] of m[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const k = u[0].toLowerCase();
      ms += +n * (k === 'd' ? 86400e3 : k === 'h' ? 3600e3 : k === 'm' ? 60e3 : 1e3);
    }
    if (ms) return now + ms;
  }
  const lead = /(?:try again at|resets?(?:\s+at)?|reset at|available (?:again )?at)\s+/.source;
  // 带日期：try again at Nov 20th, 2026 9:00 AM
  const dateRe = /([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,?(?: \d{4})?,?(?: at)? \d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)/.source;
  if ((m = text.match(new RegExp(lead + dateRe, 'i')))) {
    let s = m[1].replace(/(\d)(st|nd|rd|th)/i, '$1').replace(/ at /i, ' ').replace(/(\d)\s*([ap])\.?m\.?/i, '$1 $2M');
    if (!/\d{4}/.test(s)) s = s.replace(/^([A-Za-z]+\.? \d{1,2}),?/, `$1, ${new Date(now).getFullYear()}`);
    const t = Date.parse(s);
    if (!isNaN(t)) return t < now - 3600e3 ? t + 365 * 86400e3 : t;
  }
  // 只有时刻：try again at 9:41 PM / resets 3pm (Asia/Shanghai) / resets at 15:00
  const timeRe = /(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC)\))?/.source;
  if ((m = text.match(new RegExp(lead + timeRe, 'i')))) {
    let h = +m[1];
    const min = +(m[2] || 0);
    const ap = m[3]?.toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    if (h < 24 && min < 60 && (ap || m[2])) return nextWallClock(h, min, m[4], now);
  }
  return null;
}
