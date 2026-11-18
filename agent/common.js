// connector.js 与 room.js 共用的工具：配置、本地状态、消息格式化、WS 连接、上传
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
export function parseArgs(argv, repeatable = [], valueKeys = [], flags = []) {
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
      if (next === undefined || flags.includes(key) || (next.startsWith("--") && !valueKeys.includes(key))) val = true; // flags 是开关，不吃后面的值
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

/**
 * 连接配置：命令行 > 环境变量 > --config / AGENT_ROOM_CONFIG 文件 > 当前目录 .agent-room.json
 * 防串项目：配置文件属于别的项目或别的 agent 时，不拿它的 token 拼凑身份（同一台电脑上跑多个项目时，
 * Codex 默认会过滤名字含 TOKEN 的环境变量，以前会退回到当前目录的 .agent-room.json，可能是另一个项目的）
 */
export function loadConn(args) {
  const env = process.env;
  let file = {};
  const cfgPath = args.config || env.AGENT_ROOM_CONFIG || path.join(process.cwd(), '.agent-room.json');
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  const project = args.project || env.AGENT_ROOM_PROJECT || file.project;
  const agent = args.agent || env.AGENT_ROOM_AGENT || file.agent;
  const fileMatches = (!file.project || file.project === project) && (!file.agent || file.agent === agent);
  return {
    server: args.server || env.AGENT_ROOM_SERVER || (fileMatches ? file.server : '') || 'ws://127.0.0.1:8787/ws',
    project,
    agent,
    token: args.token || env.AGENT_ROOM_TOKEN || (fileMatches ? file.token : undefined),
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
  const data = JSON.stringify(next, null, 2);
  // 每个进程用自己的临时文件；Windows 上杀毒软件 / 另一个进程占用时 rename 偶尔报 EPERM，重试几次，
  // 实在不行直接覆盖写。状态文件写失败绝不能让连接器崩溃或让 room wait 以为断线
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(tmp, f);
        break;
      } catch (e) {
        if (i >= 5) throw e;
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until); // 同步小等待，updateState 本身是同步接口
      }
    }
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(f, data);
    } catch (e2) {
      console.error(`[agent-room] 写状态文件失败：${e2.message}`);
    }
  }
  return next;
}

// ---------- 消息格式化 ----------
export function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
export function fmtMessage(m, { base = '', maxLen = 3000, me = '' } = {}) {
  if (m.recalled) return `[${fmtTime(m.ts)}] (id=${m.id}) ${m.fromType === 'user' ? m.from + '（用户）' : '@' + m.from}: （此消息已撤回，忽略它）`;
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
// room 当前执行的命令名，随 hello 发给服务端：会话模式在两次 room wait 之间用 send/inbox 等命令，说明它正在干活
let clientCmd = '';
export function setClientCmd(c) {
  clientCmd = String(c || '').slice(0, 20);
}
/**
 * 连接并完成 hello，返回 { welcome, send, request, onMessage, close }
 * request(data) 会附带 clientId，等待服务端回执（sent/acked/error）
 */
export function connectAgent(conn, { mode = 'tool', historyLimit = 100, onMessage, onClose, timeoutMs = 15000, keepalive = false, info } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WS(conn.server);
    const waiters = new Map();
    let welcomed = false;
    let closedFired = false;
    const fireClose = (ev) => {
      if (closedFired) return;
      closedFired = true;
      clearInterval(pinger);
      onClose?.(ev);
    };
    // 长连接（room wait）做应用层心跳：网络断了但本地没察觉（电脑休眠、NAT 超时）时，
    // 以前会一直"在监听"而服务端早已把它当离线；现在 70 秒收不到 pong 就当断线，由调用方重连
    let lastPong = Date.now();
    const pinger = keepalive
      ? setInterval(() => {
          if (!welcomed) return;
          if (Date.now() - lastPong > 70_000) {
            try {
              ws.close();
            } catch {}
            return fireClose({ code: 4999, reason: 'heartbeat timeout' });
          }
          send({ type: 'ping' });
        }, 25_000)
      : null;
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
      send({ type: 'hello', kind: 'agent', mode, caps: ['ack', 'recall'], historyLimit, projectId: conn.project, agent: conn.agent, token: conn.token, host: os.hostname(), ...(info ? { info } : {}), ...(clientCmd ? { cmd: clientCmd } : {}) });
    ws.onmessage = (ev) => {
      let d;
      try {
        d = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (d.type === 'pong') {
        lastPong = Date.now();
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
        return resolve({
          welcome: d,
          send,
          request,
          close: () => {
            clearInterval(pinger);
            ws.close();
          },
          ws,
        });
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
      clearInterval(pinger);
      if (!welcomed) reject(new Error(`连接被关闭 code=${ev.code} ${ev.reason || ''}`));
      for (const w of waiters.values()) w.rej(new Error('连接已关闭'));
      waiters.clear();
      if (welcomed) fireClose(ev);
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

// ---------- 订阅额度查询 ----------
// 先认订阅级别（决定看哪个窗口），再查当前窗口的用量。只读本机 CLI 的登录信息，不刷新令牌、不上传令牌。
// Codex：~/.codex/auth.json（或 $CODEX_HOME）→ chatgpt.com/backend-api/wham/usage；失败时读最近会话日志里的 rate_limits
// Claude：~/.claude/.credentials.json（macOS 为钥匙串 "Claude Code-credentials"）→ api.anthropic.com/api/oauth/usage
const readJsonFile = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
function jwtPayload(t) {
  try {
    return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
async function getJson(url, headers) {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? '：' + text.replace(/\s+/g, ' ').slice(0, 160) : ''}`);
  return JSON.parse(text);
}
const PLAN_LABEL = { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', max: 'Max' };
const planLabel = (p) => PLAN_LABEL[p] || (p ? p[0].toUpperCase() + p.slice(1) : '未知');
/** 窗口归类：≤6 小时算 5 小时窗口，≥6 天算周窗口 */
function mkWindow({ key, label, used, resetsAt, windowMin }) {
  const w = { key, label, used: Math.max(0, Math.min(100, Number(used) || 0)), resetsAt: resetsAt || null, windowMin: windowMin || null };
  if (!w.key) w.key = windowMin && windowMin <= 360 ? '5h' : windowMin && windowMin >= 8640 ? 'week' : `w${windowMin || 0}`;
  if (!w.label) w.label = w.key === '5h' ? '5 小时' : w.key === 'week' ? '每周' : windowMin ? `${Math.round(windowMin / 60)} 小时` : '窗口';
  // 本地缓存的数据可能是旧的：重置时间已过就当作已清零
  if (w.resetsAt && w.resetsAt < Date.now()) w.used = 0;
  return w;
}
function finishUsage(u) {
  u.windows = (u.windows || []).filter(Boolean);
  if (!u.windows.some((w) => w.key === u.main)) u.main = u.windows[0]?.key || u.main;
  const full = u.windows.filter((w) => w.used >= 100);
  u.limited = !!u.limitReached || full.length > 0;
  // 用完时什么时候能恢复：所有用满窗口里最晚的重置时间
  u.resetsAt = full.length ? Math.max(...full.map((w) => w.resetsAt || 0)) || null : null;
  delete u.limitReached;
  return u;
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}
async function codexUsage() {
  const auth = readJsonFile(path.join(codexHome(), 'auth.json'));
  const tok = auth?.tokens;
  const claims = jwtPayload(tok?.id_token)?.['https://api.openai.com/auth'] || jwtPayload(tok?.access_token)?.['https://api.openai.com/auth'] || {};
  let plan = String(claims.chatgpt_plan_type || '').toLowerCase();
  const u = { cli: 'codex', plan, windows: [], source: '' };
  let apiErr = null;
  if (tok?.access_token) {
    try {
      const accountId = tok.account_id || claims.chatgpt_account_id;
      const d = await getJson('https://chatgpt.com/backend-api/wham/usage', {
        Authorization: `Bearer ${tok.access_token}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        'User-Agent': 'codex_cli_rs',
      });
      plan = String(d.plan_type || plan).toLowerCase();
      const rl = d.rate_limit || {};
      const conv = (w) =>
        w &&
        mkWindow({
          used: w.used_percent,
          windowMin: w.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : null,
          resetsAt: w.reset_at ? w.reset_at * 1000 : w.reset_after_seconds != null ? Date.now() + w.reset_after_seconds * 1000 : null,
        });
      u.windows = [conv(rl.primary_window), conv(rl.secondary_window)];
      u.limitReached = rl.limit_reached === true || rl.allowed === false;
      u.source = 'api';
    } catch (e) {
      apiErr = e;
    }
  } else if (auth?.OPENAI_API_KEY) {
    throw new Error('Codex 用的是 API Key 登录，没有订阅额度窗口');
  }
  if (!u.source) {
    // 退路：Codex 每次请求后会把 rate_limits 写进会话日志
    const r = codexRateLimitsFromSessions();
    if (!r) throw apiErr || new Error(`没找到 Codex 登录信息（${path.join(codexHome(), 'auth.json')}）`);
    const conv = (w) =>
      w &&
      mkWindow({
        used: w.used_percent,
        windowMin: w.window_minutes,
        resetsAt: w.resets_at ? w.resets_at * 1000 : w.resets_in_seconds != null ? r.ts + w.resets_in_seconds * 1000 : null,
      });
    u.windows = [conv(r.limits.primary), conv(r.limits.secondary)];
    u.source = 'sessions';
    u.asOf = r.ts;
    if (apiErr) u.note = `接口查询失败（${apiErr.message.slice(0, 80)}），显示的是最近一次会话记录`;
  }
  u.plan = plan;
  u.planLabel = planLabel(plan);
  // Pro 的 5 小时窗口很宽裕，真正卡人的是周额度；Plus 等其他档位先撞 5 小时窗口
  u.main = plan === 'pro' ? 'week' : '5h';
  return finishUsage(u);
}
function codexRateLimitsFromSessions() {
  const root = path.join(codexHome(), 'sessions');
  const files = [];
  const walk = (dir, depth) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // 目录按 年/月/日 命名，倒序只看最近的几个
    ents.sort((a, b) => b.name.localeCompare(a.name));
    for (const e of ents) {
      if (files.length >= 8) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root, 0);
  const mtime = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  files.sort((a, b) => mtime(b) - mtime(a));
  for (const f of files) {
    let text;
    try {
      const size = fs.statSync(f).size;
      const len = Math.min(size, 2_000_000);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const o = JSON.parse(lines[i]);
        const limits = o.payload?.rate_limits || o.rate_limits || o.msg?.rate_limits;
        if (limits && (limits.primary || limits.secondary)) return { limits, ts: Date.parse(o.timestamp) || mtime(f) };
      } catch {}
    }
  }
  return null;
}

function readClaudeCreds() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let c = readJsonFile(path.join(dir, '.credentials.json'))?.claudeAiOauth;
  if (!c && process.platform === 'darwin') {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      c = JSON.parse(raw.trim())?.claudeAiOauth;
    } catch {}
  }
  return c || null;
}
async function claudeUsage() {
  const c = readClaudeCreds();
  if (!c?.accessToken) throw new Error('没找到 Claude Code 的订阅登录信息（API Key 方式没有订阅额度窗口）');
  const sub = String(c.subscriptionType || '').toLowerCase();
  const mult = String(c.rateLimitTier || '').match(/(\d+)x/)?.[1];
  const u = { cli: 'claude', plan: sub + (mult ? mult + 'x' : ''), planLabel: planLabel(sub) + (mult ? ` ${mult}x` : ''), windows: [], source: 'api' };
  // Max 档的 5 小时窗口很宽，先撞的是周额度；Pro 先撞 5 小时
  u.main = sub === 'max' ? 'week' : '5h';
  if (c.expiresAt && c.expiresAt < Date.now()) throw new Error('Claude 登录令牌已过期，Claude CLI 下次运行时会自动刷新');
  const d = await getJson('https://api.anthropic.com/api/oauth/usage', {
    Authorization: `Bearer ${c.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'agent-room',
  });
  const conv = (w, key, label, windowMin) =>
    w && w.utilization != null && mkWindow({ key, label, windowMin, used: w.utilization, resetsAt: w.resets_at ? Date.parse(w.resets_at) : null });
  u.windows = [
    conv(d.five_hour, '5h', '5 小时', 300),
    conv(d.seven_day, 'week', '每周', 10080),
    conv(d.seven_day_opus, 'week-opus', '每周 · Opus', 10080),
    conv(d.seven_day_sonnet, 'week-sonnet', '每周 · Sonnet', 10080),
  ];
  return finishUsage(u);
}

/**
 * 查询本机某个 CLI 的订阅额度。不会抛错：失败时返回 { cli, error }。
 * 返回 { cli, plan, planLabel, main, windows:[{key,label,used,resetsAt,windowMin}], limited, resetsAt, source, ts }
 * 测试用：环境变量 AGENT_ROOM_FAKE_USAGE 为 JSON 时直接用它
 */
export async function fetchUsage(cli) {
  const ts = Date.now();
  try {
    if (process.env.AGENT_ROOM_FAKE_USAGE) {
      const f = JSON.parse(process.env.AGENT_ROOM_FAKE_USAGE);
      return { ...finishUsage({ cli, source: 'fake', ...f, windows: (f.windows || []).map(mkWindow) }), ts };
    }
    const u = cli === 'codex' ? await codexUsage() : cli === 'claude' ? await claudeUsage() : null;
    if (!u) return { cli, error: `不支持查询 ${cli} 的额度`, ts };
    return { ...u, ts };
  } catch (e) {
    return { cli, error: String(e.message || e).slice(0, 200), ts };
  }
}

/** 多行文字描述（命令行 / 日志用） */
export function fmtUsage(u) {
  if (!u) return '（无额度信息）';
  if (u.error) return `额度查询失败：${u.error}`;
  const left = (t) => {
    const min = Math.max(0, Math.round((t - Date.now()) / 60000));
    return min < 60 ? `${min} 分钟后重置` : min < 2880 ? `${Math.floor(min / 60)} 小时 ${min % 60} 分后重置` : `${Math.round(min / 1440)} 天后重置`;
  };
  const name = u.cli === 'codex' ? 'Codex' : 'Claude';
  return [
    `${name} 订阅：${u.planLabel || '未知'}（★ 为该档位主要看的窗口${u.source === 'sessions' ? '；数据来自最近一次会话记录' : ''}）`,
    ...u.windows.map(
      (w) => `${w.key === u.main ? '★' : '  '} ${w.label}：已用 ${Math.round(w.used)}%，剩余 ${Math.round(100 - w.used)}%${w.resetsAt ? '，' + left(w.resetsAt) : ''}`
    ),
    u.note || '',
    u.limited ? `⚠️ 额度已用完${u.resetsAt ? '，' + left(u.resetsAt) : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------- 当前模型 ----------
/** 从命令行参数里找 -m/--model 或 -c model=... */
function modelFromArgs(extra = []) {
  for (let i = 0; i < extra.length; i++) {
    const a = extra[i];
    if ((a === '-m' || a === '--model') && extra[i + 1]) return extra[i + 1];
    const m = a.match(/^(?:--model=|model=)(.+)$/);
    if (m) return m[1].replace(/^["']|["']$/g, '');
    if (a === '-c' && /^model=/.test(extra[i + 1] || '')) return extra[i + 1].slice(6).replace(/^["']|["']$/g, '');
  }
  return '';
}
/** 读 TOML 顶层（第一个 [section] 之前）的字符串键 */
function tomlTop(text, key) {
  const top = text.split(/^\s*\[/m)[0];
  const m = top.match(new RegExp('^\s*' + key + '\s*=\s*["\']([^"\']+)["\']', 'm'));
  return m ? m[1] : '';
}
/**
 * 推测 CLI 会用哪个模型：命令行指定 > CLI 配置文件 > 未知（用 CLI 默认）。
 * 返回 { model, effort, source }；source = args | config | default
 */
export function detectModel(cli, { model = '', extra = [] } = {}) {
  const fromArgs = model || modelFromArgs(extra);
  if (cli === 'codex') {
    let text = '';
    try {
      text = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8');
    } catch {}
    const effort = tomlTop(text, 'model_reasoning_effort');
    if (fromArgs) return { model: fromArgs, effort, source: 'args' };
    const m = tomlTop(text, 'model');
    return m ? { model: m, effort, source: 'config' } : { model: '', effort, source: 'default' };
  }
  if (fromArgs) return { model: fromArgs, effort: '', source: 'args' };
  if (process.env.ANTHROPIC_MODEL) return { model: process.env.ANTHROPIC_MODEL, effort: '', source: 'config' };
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const st = readJsonFile(path.join(dir, 'settings.json'));
  if (st?.model) return { model: st.model, effort: st.effortLevel || '', source: 'config' };
  return { model: '', effort: '', source: 'default' };
}
