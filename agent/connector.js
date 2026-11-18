#!/usr/bin/env node
// Agent Room 连接器：把本机的 Claude Code / Codex CLI 作为一个 agent 接入 room。
// 常驻监听；被 @ 时在项目工作目录里调用 CLI 完成任务，只把最终回复发到群里（不转发思考/执行过程）。
//
// 用法：
//   node agent/connector.js --server ws://HOST:8787/ws --project <ID> --agent <名称> --token <TOKEN> \
//        [--workdir 路径] [--cli claude|codex] [--bin 可执行文件] [--permission 模式] [--yolo] \
//        [--model 模型] [--extra "额外参数"] [--timeout 分钟，默认 720] [--limit-retry 分钟] [--usage-interval 分钟，默认 5，0 关闭] [--progress-interval 分钟，默认 20，0 关闭] [--history 条数]
// 连接信息也可以来自环境变量 AGENT_ROOM_* 或当前目录的 .agent-room.json（room init 生成）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS, parseArgs, loadConn, httpBase, stateDir, readState, updateState, fmtMessage, ensureRoomShim, detectLimit, looksLikeLimitResult, fetchUsage, fmtUsage, detectModel } from './common.js';

const ROOM_TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'room.js');
const SHIM_DIR = ensureRoomShim(ROOM_TOOL); // 提供 `room` 短命令给 CLI 子进程
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';

// ---------- 参数 ----------
const args = parseArgs(process.argv.slice(2), [], ['extra']);
const env = process.env;
const conn = loadConn(args);
const cfg = {
  ...conn,
  workdir: path.resolve(args.workdir || env.AGENT_ROOM_WORKDIR || process.cwd()),
  cli: args.cli || env.AGENT_ROOM_CLI || '', // 为空则用项目里给该 agent 定义的类型
  bin: args.bin || env.AGENT_ROOM_BIN || '',
  permission: args.permission || env.AGENT_ROOM_PERMISSION || '',
  yolo: !!(args.yolo || env.AGENT_ROOM_YOLO === '1'),
  model: args.model || env.AGENT_ROOM_MODEL || '',
  extra: String(args.extra || env.AGENT_ROOM_EXTRA || '').split(/\s+/).filter(Boolean),
  // 单次任务上限（分钟）。默认 12 小时，只用来兜底卡死的进程；0 为不限制
  timeoutMin: parseFloat(args.timeout ?? env.AGENT_ROOM_TIMEOUT ?? '720'),
  limitRetryMin: parseFloat(args['limit-retry'] || env.AGENT_ROOM_LIMIT_RETRY || '30'), // 额度用完但不知道何时恢复时，多久重试一次
  // 多久查一次订阅额度（分钟），显示在网页上；额度用完时每 2 分钟查一次，发现恢复就提前重试
  usageMin: parseFloat(args['usage-interval'] ?? env.AGENT_ROOM_USAGE_INTERVAL ?? '5'),
  // 长任务执行中，每隔多少分钟自动在群里发一次进展（有变化才发）；0 关闭
  progressMin: parseFloat(args['progress-interval'] ?? env.AGENT_ROOM_PROGRESS ?? '20'),
  backlogHours: parseFloat(args['backlog-hours'] || env.AGENT_ROOM_BACKLOG_HOURS || '24'),
  historyN: parseInt(args.history || env.AGENT_ROOM_HISTORY || '40', 10),
  noResume: !!args['no-resume'],
  dryRun: !!args['dry-run'], // 不调用 CLI，原样回显（用于联调）
};
if (!cfg.project || !cfg.agent || !cfg.token) {
  console.error('缺少参数：--project --agent --token 必填（也可用环境变量 AGENT_ROOM_PROJECT / AGENT_ROOM_AGENT / AGENT_ROOM_TOKEN）');
  process.exit(1);
}
if (!fs.existsSync(cfg.workdir)) fs.mkdirSync(cfg.workdir, { recursive: true });
const base = httpBase(cfg.server);

// 给 CLI 子进程用的连接信息文件。只靠环境变量不够：Codex 默认会过滤名字含 TOKEN 的环境变量，
// room 拿不到 token 时以前会退回当前目录的 .agent-room.json——同一台电脑跑多个项目时可能是另一个项目的
const CONN_FILE = path.join(stateDir, `${cfg.project}-${String(cfg.agent).replace(/[^\w-]/g, '_')}.conn.json`);
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(CONN_FILE, JSON.stringify({ server: cfg.server, project: cfg.project, agent: cfg.agent, token: cfg.token }, null, 2), { mode: 0o600 });

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}] [${cfg.agent}]`, ...a);

// ---------- 本地状态（与 room 工具共享：sessionId、seenTs 已读游标、doneTs 已处理游标） ----------
let state = { sessionId: null, primed: false, ...readState(conn) };
const saveState = (patch = {}) => {
  // 先合并文件里的 seenTs（CLI 子进程可能通过 room inbox 推进过）
  state = updateState(conn, (cur) => ({ ...state, ...patch, seenTs: Math.max(cur.seenTs || 0, patch.seenTs ?? state.seenTs ?? 0) }));
};

// ---------- 运行时 ----------
let ws = null;
let project = null;
let self = null;
let history = [];
let pending = []; // 待处理的触发消息
let running = null; // { child, cancelled }
let currentTriggers = [];
let runNote = '';
let backoff = 1000;
let lastPong = Date.now();
// 额度用完：state.limited = { until, guessed, reason, since, ids, notified }，持久化，重启后继续等
let limitTimer = null;

function send(data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}
function setStatus(status, note = '') {
  if (status === 'idle' && isLimited()) return quotaStatus();
  send({ type: 'status', status, note });
}

function connect() {
  log(`连接 ${cfg.server} ...`);
  ws = new WS(cfg.server);
  ws.onopen = () => {
    backoff = 1000;
    lastPong = Date.now();
    send({ type: 'hello', kind: 'agent', mode: 'listener', caps: ['ack'], historyLimit: 200, projectId: cfg.project, agent: cfg.agent, token: cfg.token, host: os.hostname() });
  };
  ws.onmessage = (ev) => {
    let data;
    try {
      data = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    onServer(data);
  };
  ws.onclose = (ev) => {
    log(`连接断开 code=${ev.code} ${ev.reason || ''}`);
    if ([4003, 4004, 4009].includes(ev.code)) {
      log('服务端拒绝/替换了本连接，不再重连。');
      killRunning();
      process.exit(2);
    }
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  ws.onerror = () => {};
}

// 应用层心跳，检测半开连接
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  if (Date.now() - lastPong > 70_000) {
    log('心跳超时，重连');
    try {
      ws.close();
    } catch {}
    return;
  }
  send({ type: 'ping' });
}, 25_000);

function onServer(data) {
  switch (data.type) {
    case 'pong':
      lastPong = Date.now();
      return;
    case 'welcome': {
      project = data.project;
      self = data.self;
      history = data.history || [];
      log(`已加入项目「${project.name}」，角色：${self.type} — ${self.role.slice(0, 60) || '（未定义）'}`);
      log(`工作目录：${cfg.workdir}`);
      // 补处理：服务端记录的未接单派发 + 已处理游标之后 1 小时内 @ 我的消息
      const pendIds = new Set([...(data.pending || []), ...(state.limited?.ids || [])]);
      const doneTs = state.doneTs || 0;
      const backlog = history.filter(
        (m) =>
          isForMe(m) &&
          !pending.find((p) => p.id === m.id) &&
          !currentTriggers.find((p) => p.id === m.id) &&
          (pendIds.has(m.id) || (m.ts > doneTs && Date.now() - m.ts < cfg.backlogHours * 3600_000))
      );
      if (backlog.length) {
        log(`发现 ${backlog.length} 条未处理的 @ 消息`);
        pending.push(...backlog);
      }
      if (state.limited) {
        // 重启前在等额度恢复：继续等（时间已过就直接重试）
        if (isLimited()) log(`额度用完，等待恢复（预计 ${fmtClock(state.limited.until)}）`);
        scheduleLimitRetry();
      }
      if (running) setStatus('working', workingNote());
      else setStatus('idle');
      reportInfo();
      checkWorkdirShared();
      // 重连后把额度信息重新报给服务端（太旧就重新查）
      if (lastUsage && Date.now() - lastUsage.ts < 10 * 60_000) send({ type: 'usage', usage: lastUsage });
      else refreshUsage();
      pump();
      return;
    }
    case 'project':
      project = data.project;
      self = project.agents.find((a) => a.name === cfg.agent) || self;
      return;
    case 'message': {
      const m = data.message;
      history.push(m);
      if (history.length > 600) history = history.slice(-400);
      if (isForMe(m)) {
        log(`被 @：${m.from}: ${m.text.slice(0, 80)}`);
        pending.push(m);
        if (isLimited() && !running) {
          // 额度用完：先确认收到并排队；用户亲自 @ 时立即试一次（可能已经换了账号或额度提前恢复）
          send({ type: 'ack', ids: [m.id] });
          if (m.fromType === 'user') {
            log('用户 @ 我，立即重试一次');
            state.limited.until = Date.now();
          } else {
            log(`额度用完，消息排队（${pending.length} 条）`);
            quotaStatus();
          }
        } else if (running) {
          // 排队情况实时反映到群成员状态上（网页能看到"排队 N 条"）
          log(`正在执行任务，排队 ${pending.length} 条`);
          setStatus('working', workingNote());
        }
        pump();
      }
      return;
    }
    case 'recall': {
      // 消息被撤回：从排队里拿掉；正在处理的任务只剩被撤回的消息时，停止执行
      const id = data.id;
      for (const m of [...history, ...pending, ...currentTriggers]) if (m.id === id) Object.assign(m, { recalled: true, text: '', attachments: [] });
      const n = pending.length;
      pending = pending.filter((m) => m.id !== id);
      if (pending.length !== n) log(`排队中的消息 ${id} 被撤回，已移除`);
      if (state.limited?.ids?.includes(id)) saveState({ limited: { ...state.limited, ids: state.limited.ids.filter((x) => x !== id) } });
      if (running && currentTriggers.some((m) => m.id === id) && currentTriggers.every((m) => m.recalled)) {
        log('正在处理的消息被撤回，中止任务');
        running.recalled = true;
        killRunning();
      }
      return;
    }
    case 'control':
      if (data.action === 'cancel') {
        log(`${data.by} 请求中止当前任务`);
        const dropped = pending;
        pending = [];
        if (dropped.length) send({ type: 'ack', ids: dropped.map((m) => m.id) });
        if (killRunning()) post('（已按用户要求中止当前任务）');
        else if (state.limited && dropped.length) {
          post(`（已按用户要求清空等待额度恢复的 ${dropped.length} 条任务）`);
          saveState({ limited: { ...state.limited, ids: [] } });
          quotaStatus();
        }
      } else if (data.action === 'reset') {
        log(`${data.by} 请求重置会话`);
        saveState({ sessionId: null, primed: false });
        post('（会话已重置，下次将以全新上下文开始）');
      }
      return;
    case 'error':
      log('服务端错误：', data.error);
      return;
  }
}

function isForMe(m) {
  return m.from !== cfg.agent && Array.isArray(m.dispatch) && m.dispatch.includes(cfg.agent);
}

function post(text, replyTo) {
  send({ type: 'message', text, replyTo });
}

// ---------- 任务处理 ----------
async function pump() {
  if (running || !pending.length || !project || !ws || ws.readyState !== 1) return;
  if (isLimited()) return; // 等额度恢复，到点由 scheduleLimitRetry 再叫醒
  // 执行期间 CLI 已经通过 room inbox 看到（并确认）的消息，不再单独开一轮
  const seenByChild = readState(conn).seenTs || 0;
  const skipped = pending.filter((m) => m.ts <= seenByChild && state.lastRunEnd && m.ts > state.lastRunStart);
  const triggers = pending.filter((m) => !skipped.includes(m) && !m.recalled);
  pending = [];
  if (skipped.length) log(`${skipped.length} 条消息已在上一轮执行中通过 room inbox 处理，跳过`);
  if (!triggers.length) return;
  currentTriggers = triggers;
  const last = triggers[triggers.length - 1];
  running = { child: null, cancelled: false };
  // 确认接单：服务端据此判断 agent 没有"停"
  send({ type: 'ack', ids: triggers.map((m) => m.id) });
  runNote = `处理 ${last.from} 的消息`;
  actReset();
  setStatus('working', workingNote());
  const prompt = buildPrompt(triggers);
  const runStart = Date.now();
  if (state.limited) limitLastTry = runStart;
  saveState({ lastTrigger: last.id, lastRunStart: runStart, seenTs: history.at(-1)?.ts || last.ts });
  let reply;
  try {
    reply = await runCli(prompt);
    if (state.limited) {
      log('额度已恢复');
      const wasNotified = state.limited.notified;
      clearLimit();
      if (wasNotified) reply = `✅ 额度已恢复，接着处理之前排队的任务。\n\n${reply}`;
    }
  } catch (e) {
    if (e.limit) {
      // 额度用完：任务放回队列，到点自动重试；不推进已处理游标
      running = null;
      currentTriggers = [];
      pending = [...triggers, ...pending.filter((m) => !triggers.includes(m))];
      enterLimit(e.limit, triggers);
      return;
    }
    log('执行失败：', e.message);
    if (e.timedOut) {
      reply = `⚠️ 这次任务执行超过 ${fmtDuration(cfg.timeoutMin * 60_000)}，被连接器终止（--timeout 上限），结果可能不完整。需要继续请再 @我（会接着上次的会话），或调大连接器的 --timeout（0 为不限制）。`;
    } else if (e.cancelled) reply = running?.recalled ? '（对应的消息已被撤回，任务已停止）' : null;
    else reply = `⚠️ 执行出错：${e.message.slice(0, 1500)}`;
  }
  if (reply !== null) post(reply.trim() || '（无输出）', last.id);
  saveState({ doneTs: last.ts, lastRunEnd: Date.now() });
  running = null;
  act = null;
  currentTriggers = [];
  setStatus('idle');
  refreshUsage();
  setImmediate(pump);
}

// ---------- 执行过程：实时动作（显示在工位卡片上）+ 定期在群里发进展 ----------
let act = null; // { start, lastEventAt, action, text, todos, lastPostAt, lastPostKey }
let actTimer = null;
const short = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
function actReset() {
  const now = Date.now();
  act = { start: now, lastEventAt: now, action: '', text: '', todos: null, lastPostAt: now, lastPostKey: null };
}
function workingNote() {
  const parts = [runNote];
  if (act?.action) parts.push(act.action);
  if (pending.length) parts.push(`排队 ${pending.length} 条`);
  return parts.filter(Boolean).join(' · ');
}
/** CLI 有新动作：记下来，3 秒内合并成一次状态更新 */
function noteAction(action = '', text = '') {
  if (!act) return;
  act.lastEventAt = Date.now();
  if (action) act.action = short(action, 80);
  if (text) act.text = text;
  if (actTimer) return;
  actTimer = setTimeout(() => {
    actTimer = null;
    if (running && act) setStatus('working', workingNote());
  }, 3000);
}
function describeTool(name, i = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `运行 ${short(i.command, 70)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `编辑 ${base(i.file_path || i.notebook_path)}`;
    case 'Read':
      return `查看 ${base(i.file_path)}`;
    case 'Grep':
    case 'Glob':
      return `搜索 ${short(i.pattern, 40)}`;
    case 'WebFetch':
    case 'WebSearch':
      return `查资料 ${short(i.query || i.url, 50)}`;
    case 'Task':
    case 'Agent':
      return `派子任务 ${short(i.description, 40)}`;
    default:
      return `调用 ${name}`;
  }
}
function onClaudeEvent(ev) {
  if (ev.type === 'system' && ev.subtype === 'init' && ev.model) setModel(ev.model, 'cli');
  if (ev.type === 'assistant') {
    for (const c of ev.message?.content || []) {
      if (c.type === 'text' && c.text?.trim()) noteAction('', c.text);
      else if (c.type === 'tool_use' && c.name === 'TodoWrite' && act) {
        act.todos = (c.input?.todos || []).map((t) => ({ text: t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content, done: t.status === 'completed', active: t.status === 'in_progress' }));
        noteAction('更新任务清单');
      } else if (c.type === 'tool_use') noteAction(describeTool(c.name, c.input));
    }
  } else noteAction();
}
function onCodexEvent(ev) {
  const it = ev.item || {};
  const old = ev.msg || {}; // 旧版事件格式
  const t = it.type || it.item_type;
  if (t === 'command_execution') noteAction(`运行 ${short(it.command, 70)}`);
  else if (old.type === 'exec_command_begin') noteAction(`运行 ${short([].concat(old.command || []).join(' '), 70)}`);
  else if (t === 'file_change') noteAction(`编辑 ${(it.changes || []).map((c) => path.basename(String(c.path || ''))).slice(0, 3).join('、')}`);
  else if (t === 'agent_message' && it.text) noteAction('', it.text);
  else if (old.type === 'agent_message' && old.message) noteAction('', old.message);
  else if (t === 'todo_list' && act) {
    act.todos = (it.items || []).map((x) => ({ text: x.text, done: !!x.completed }));
    noteAction('更新任务清单');
  } else if (t === 'mcp_tool_call') noteAction(`调用 ${it.server || ''}.${it.tool || ''}`);
  else if (t === 'web_search') noteAction(`搜索 ${short(it.query, 50)}`);
  else if (t === 'reasoning') noteAction('思考中');
  else noteAction();
}
function todoSummary() {
  const t = act?.todos;
  if (!t?.length) return '';
  const done = t.filter((x) => x.done).length;
  const cur = t.find((x) => x.active) || t.find((x) => !x.done);
  return `任务清单 ${done}/${t.length} 完成${cur ? `，当前：${short(cur.text, 60)}` : ''}`;
}
/** 长任务定期在群里报一次进展；内容没变化就不发，长时间没输出时提示可能卡住 */
function maybePostProgress() {
  if (!running || !act || cfg.progressMin <= 0 || !project) return;
  const now = Date.now();
  if (now - act.lastPostAt < cfg.progressMin * 60_000) return;
  act.lastPostAt = now;
  const idle = now - act.lastEventAt;
  const stalled = idle > 15 * 60_000;
  const lines = [];
  const todo = todoSummary();
  if (todo) lines.push(`- ${todo}`);
  if (act.action) lines.push(`- 最近动作：${act.action}`);
  if (act.text) lines.push(`- 最新说明：${short(act.text, 300)}`);
  const key = lines.join('\n');
  if (key === act.lastPostKey && !stalled) return;
  act.lastPostKey = key;
  if (stalled) lines.push(`- ⚠️ 已经 ${fmtDuration(idle)}没有任何输出，可能卡住了；需要的话在工位卡片上点「中止」`);
  const last = currentTriggers.at(-1);
  // 进展消息不派活：把 @ 换成全角，避免误触发别人
  const text = `⏳ 进展：仍在处理 ${last?.from || ''} 的任务（已 ${fmtDuration(now - act.start)}）\n${lines.join('\n') || '- 正在思考 / 执行中'}`.replace(/@/g, '＠');
  send({ type: 'message', text, replyTo: last?.id, meta: { kind: 'progress' } });
}
setInterval(maybePostProgress, Math.max(500, Math.min(30_000, (cfg.progressMin * 60_000) / 2))).unref?.();

// ---------- 当前模型 / CLI 版本（显示在工位卡片上） ----------
let modelInfo = null;
let cliVersion = null;
function reportInfo() {
  if (!self) return;
  const cli = agentCli();
  if (!modelInfo || modelInfo.cli !== cli) modelInfo = { cli, ...detectModel(cli, { model: cfg.model, extra: cfg.extra }) };
  if (cliVersion === null && !cfg.dryRun) {
    cliVersion = '';
    try {
      const bin = cfg.bin || cli;
      const w = process.platform === 'win32' ? resolveWinBin(bin) : { file: bin, shell: false };
      const r = spawnSync(w.file, ['--version'], { encoding: 'utf8', timeout: 15000, shell: w.shell, windowsHide: true });
      cliVersion = short((r.stdout || '').match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] || '', 30);
    } catch {}
  }
  send({ type: 'info', info: { ...modelInfo, version: cliVersion || '' } });
}
function setModel(model, source) {
  if (!model || (modelInfo?.model === model && modelInfo?.source === source)) return;
  modelInfo = { ...(modelInfo || { cli: agentCli() }), model, source };
  reportInfo();
}

// ---------- 同一台电脑上多个项目共用工作目录：提醒一下（容易串项目） ----------
let workdirChecked = false;
function checkWorkdirShared() {
  if (workdirChecked) return;
  workdirChecked = true;
  saveState({ workdir: cfg.workdir });
  const others = [];
  try {
    for (const f of fs.readdirSync(stateDir)) {
      if (!f.endsWith('.json') || /\.(conn|tmp)\.json$/.test(f) || f.startsWith(`${cfg.project}-`)) continue;
      const st = (() => {
        try {
          return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
        } catch {
          return {};
        }
      })();
      if (st.workdir && path.resolve(st.workdir) === cfg.workdir) others.push(f.replace(/\.json$/, ''));
    }
  } catch {}
  if (!others.length) return;
  log(`⚠️ 本机另有连接器使用同一个工作目录：${others.join('、')}。不同项目请用不同的 --workdir，否则 CLI 会看到别的项目的文件和会话，容易串项目。`);
  post(`⚠️ 提醒：本机（${os.hostname()}）上还有别的项目的 agent（${others.join('、')}）和我共用工作目录 ${cfg.workdir}。不同项目共用目录容易串项目，建议给每个项目单独的 --workdir。`);
}

// ---------- 额度用完 / 限流 ----------
function isLimited() {
  return !!state.limited && Date.now() < state.limited.until;
}
const fmtClock = (t) => new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function fmtDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} 小时${min % 60 ? ` ${min % 60} 分钟` : ''}`;
  return `${Math.round(h / 24)} 天`;
}
function quotaStatus() {
  const l = state.limited;
  if (!l) return;
  const q = pending.length ? ` · 排队 ${pending.length} 条` : '';
  const when = l.guessed ? `恢复时间未知，${fmtDuration(Math.max(0, l.until - Date.now()))}后重试` : `预计 ${fmtClock(l.until)} 恢复`;
  send({ type: 'status', status: 'quota', note: `额度用完 · ${when}${q}`, until: l.until });
}
function enterLimit(info, triggers) {
  const now = Date.now();
  const first = !state.limited;
  const retryMin = info.transient ? 5 : cfg.limitRetryMin;
  // 官方给的恢复时间多留 1 分钟余量（很短的限流只留 1 秒）
  const until = info.until ? info.until + (info.until - now > 300_000 ? 60_000 : 1000) : now + retryMin * 60_000;
  const ids = [...new Set([...(state.limited?.ids || []), ...pending.map((m) => m.id)])].slice(-50);
  saveState({
    limited: { until, guessed: !info.until, reason: info.text, since: state.limited?.since || now, ids, notified: state.limited?.notified || false },
  });
  limitLastTry = now;
  log(`额度用完 / 限流：${info.text}；${fmtClock(until)} 重试`);
  // 第一次碰到时在群里说一声；之后重试仍失败只更新状态，不刷屏。短暂限流（429/过载）先静默重试一次
  if (first && !info.transient) announceLimit(triggers);
  else if (!first && !state.limited.notified && now - state.limited.since > 10 * 60_000) announceLimit(triggers);
  quotaStatus();
  scheduleLimitRetry();
  refreshUsage(); // 用额度接口的重置时间校准（错误信息里常常没写什么时候恢复）
}
function announceLimit(triggers) {
  const l = state.limited;
  const cliName = agentCli() === 'codex' ? 'Codex' : 'Claude';
  // 把这件事告诉派活给我的 agent，让它先做别的，不要干等
  const askers = [...new Set(triggers.filter((m) => m.fromType === 'agent' && m.from !== cfg.agent).map((m) => m.from))];
  const when = l.guessed
    ? `恢复时间未知，我每 ${fmtDuration(l.until - Date.now())}自动重试一次`
    : `预计 ${fmtClock(l.until)} 恢复（${fmtDuration(l.until - Date.now())}后）`;
  const text = [
    `⏳ 我的 ${cliName} 模型额度暂时用完了，${when}。`,
    `手上的 ${pending.length} 条任务已保留，额度恢复后会自动接着做，完成后照常在群里回复。`,
    askers.length
      ? `${askers.map((a) => '@' + a).join(' ')} 先不用等我，请推进不依赖我的工作；必须由我做的部分留到恢复后。`
      : '其他成员先不用等我，可以推进不依赖我的工作。',
  ].join('\n');
  send({ type: 'message', text, replyTo: triggers.at(-1)?.id, meta: { kind: 'quota', until: l.until } });
  saveState({ limited: { ...l, notified: true } });
}
function clearLimit() {
  clearTimeout(limitTimer);
  limitTimer = null;
  saveState({ limited: null });
}
/** 没有排队任务时额度恢复了：清掉状态，并在群里说一声（之前通知过大家的话） */
function recoverIdle(why) {
  const l = state.limited;
  if (!l) return;
  log(`额度已恢复（${why}）`);
  clearLimit();
  setStatus('idle');
  if (l.notified) send({ type: 'message', text: `✅ 我的额度已恢复（${why}），可以继续派活了。`, meta: { kind: 'quota-ok' } });
}
function scheduleLimitRetry() {
  clearTimeout(limitTimer);
  if (!state.limited) return;
  const left = state.limited.until - Date.now();
  // 官方给的恢复时间可能很远（周额度要等几天），但额度可能提前回来（官方重置、换账号、窗口滚动）。
  // 所以不管多远，最多每 --limit-retry 分钟探一次：有额度接口先问接口，没有就拿排队任务直接试
  const probe = cfg.limitRetryMin > 0 ? cfg.limitRetryMin * 60_000 : Infinity;
  const wait = Math.max(1000, Math.min(left, probe, 2 ** 31 - 1));
  limitTimer = setTimeout(async () => {
    limitTimer = null;
    if (!state.limited || running) return;
    if (Date.now() < state.limited.until) {
      const u = await refreshUsage();
      if (!state.limited || running) return;
      if (u && !u.error && u.limited) return scheduleLimitRetry(); // 接口确认还没恢复
      if (!pending.length) {
        if (u && !u.error) return recoverIdle('额度接口显示已有余量');
        return scheduleLimitRetry(); // 没有接口也没有任务，没法验证，等下一次
      }
      log(u && !u.error ? '额度接口显示已有余量，提前重试排队的任务' : '提前重试一次排队的任务，看额度是否已恢复');
      state.limited.until = Date.now();
      return pump();
    }
    if (!pending.length) return recoverIdle('等待期已过');
    log('到达预计恢复时间，重试排队的任务');
    pump();
  }, wait);
}

// ---------- 订阅额度（显示在网页成员卡片上） ----------
let lastUsage = null;
let usageBusy = null;
let limitLastTry = 0;
function refreshUsage() {
  if ((cfg.usageMin <= 0 && !state.limited) || (cfg.dryRun && !env.AGENT_ROOM_FAKE_USAGE)) return Promise.resolve(null);
  if (usageBusy) return usageBusy;
  usageBusy = (async () => {
    const u = await fetchUsage(agentCli());
    const prevErr = lastUsage?.error;
    lastUsage = u;
    if (u.error && u.error !== prevErr) log(fmtUsage(u));
    send({ type: 'usage', usage: u });
    onUsage(u);
    return u;
  })().finally(() => (usageBusy = null));
  return usageBusy;
}
function onUsage(u) {
  const l = state.limited;
  if (!l || u.error || running) return;
  if (u.limited) {
    // 错误信息里没写恢复时间时，用额度接口给的重置时间
    if (u.resetsAt && l.guessed && u.resetsAt > Date.now()) {
      saveState({ limited: { ...l, until: u.resetsAt + 60_000, guessed: false } });
      quotaStatus();
      scheduleLimitRetry();
    }
    return;
  }
  // 接口说有余量了，但 CLI 刚刚还报额度用完：10 分钟内不重复提前重试，避免两边说法不一时来回空转
  if (isLimited() && Date.now() - limitLastTry > 10 * 60_000) {
    if (!pending.length) return recoverIdle('额度接口显示已有余量');
    log('额度接口显示已有余量，提前重试排队的任务');
    state.limited.until = Date.now();
    scheduleLimitRetry();
  }
}
setInterval(() => {
  if (!ws || ws.readyState !== 1 || !project) return;
  const every = state.limited ? 2 : cfg.usageMin;
  if (every > 0 && (!lastUsage || Date.now() - lastUsage.ts >= every * 60_000 - 5000)) refreshUsage();
}, 60_000).unref?.();

const fmt = (m) => fmtMessage(m, { base, me: cfg.agent, maxLen: 3000 });

function toolHelp() {
  return `【群聊工具 room（shell 里直接可用，连接信息已在环境变量里；若找不到 room 命令，用 node "${ROOM_TOOL}" 代替）】
- \`room inbox\`：查看你开始执行后群里的新消息。长任务中途、以及给出最终回复前建议看一眼，需求可能有变化（例如有了更新的提交号），过时的工作不要继续做。
- \`room send "进度说明"\`：在群里发进度或中间结果（可加 \`--attach 截图.png\` 发图片/文件）。最终回复不用 send，直接作为你的最终输出即可。
- \`room show <消息id>\`：查看被截断消息的全文；\`room get <附件URL>\`：下载附件（如截图）。`;
}

function buildPrompt(triggers) {
  const cliName = agentCli() === 'codex' ? 'Codex' : 'Claude Code';
  const roster = project.agents
    .map((a) => `- @${a.name}（${a.type}）${a.name === cfg.agent ? ' ← 你' : ''}：${a.role || '未定义分工'}`)
    .join('\n');
  const trig = triggers.map(fmt).join('\n\n');
  const multi =
    triggers.length > 1
      ? `\n\n注意：以上 ${triggers.length} 条是在你忙碌期间先后到达的。以最新的为准，被后续消息取代或已经过时的任务（例如更早的提交号、已修复的问题）不要重复做，在回复里简单说明即可。`
      : '';
  const rules = `协作规则：
1. 你的最终回复会原样发到项目群聊，所有成员和用户都能看到。只输出要发到群里的内容（结论、进展、需要别人做的事），不要复述思考过程或逐条罗列执行日志。
2. 需要其他成员接手或配合时，在回复里 @对方名字 并写清楚具体任务和验收标准；一条消息可以 @多人。
3. 不需要别人处理时不要 @任何人，避免无意义的来回接力；不要 @自己。
4. 用户（人类）是最终决策者。需求不明确或有重大取舍时，直接在群里向用户提问，不要 @agent。
5. 只做你分工内的事；在当前工作目录中直接读写代码、运行命令来完成任务，完成后简要汇报改了什么、结果如何。
6. 只用你自己的身份 @${cfg.agent} 发言，绝不冒充用户或其他成员。
7. 截图等图片用 room send --attach 发送，不要把 base64 贴进消息。
8. 如果群里提示某个成员"额度用完"，不要干等或反复 @它：先推进不依赖它的工作，必须由它做的部分等它恢复后自己接着做。
9. 用户手机推送只在两种情况发出：① 消息里给出了验收二维码链接（出包后把二维码链接单独一行贴出来）；② 需要用户本人确认或决策——@用户 并用问句写清楚要确认什么（选项、影响、你的建议）。请用户验收时写清楚：做了什么、怎么验收（打开哪里、操作步骤、预期结果）、已知问题。不要为了引起注意而 @用户 提问，进度同步不要用问句 @用户。
10. 及时反馈进展：预计超过 10 分钟的任务，开始时用 room send 说一句计划（做什么、大概多久）；之后每完成一个阶段或遇到阻塞，用 room send 发一句进展（做完了什么、下一步、卡在哪）。进展消息不要 @ 别人。
11. 你只属于项目「${project.name}」。room 命令只会收发本项目的消息；如果看到明显属于其他项目的内容（别的仓库、别的成员名），不要处理，在回复里说明。`;

  const resumed = state.primed && state.sessionId && !cfg.noResume;
  if (resumed) {
    // 已有会话上下文：只发送上次看过之后的新消息
    const seenTs = Math.max(state.seenTs || 0, readState(conn).seenTs || 0);
    const trigIds = new Set(triggers.map((m) => m.id));
    const fresh = history.filter((m) => m.ts > seenTs && m.from !== cfg.agent && !trigIds.has(m.id));
    return `【项目「${project.name}」· 你是 @${cfg.agent} · 工作目录 ${cfg.workdir}】只处理本项目的事。\n\n${fresh.length ? `【你上次之后群里的其他新消息】\n${fresh.map(fmt).join('\n\n')}\n\n` : ''}【需要你处理的消息】\n${trig}${multi}\n\n（提醒：最终输出会原样发到群里；需要别人接手就 @ 对方；需要用户确认时 @用户 并提问；长任务用 room send 及时发进展；可用 room inbox 查看执行期间的新消息。）\n请完成后给出你要发到群里的回复：`;
  }
  const recent = history.slice(-cfg.historyN).map(fmt).join('\n\n');
  return `你是多 agent 协作项目「${project.name}」中的成员 @${cfg.agent}，由 ${cliName} 驱动。

【你的分工角色】
${self?.role || '未定义，请根据项目需要合理承担工作'}

【项目说明】
${project.description || '（无）'}

【团队成员】
${roster}

${rules}

${toolHelp()}

【最近群聊记录】
${recent}

【需要你处理的消息】
${trig}${multi}

请完成你负责的部分，然后给出你要发到群里的回复：`;
}

function agentCli() {
  return cfg.cli || self?.type || 'claude';
}

function quoteWin(s) {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function killRunning() {
  if (!running) return false;
  running.cancelled = true;
  if (!running.child) return true; // 还没启动 CLI：exec 看到 cancelled 就不会再启动
  const pid = running.child.pid;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
    else process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      running.child.kill('SIGKILL');
    } catch {}
  }
  return true;
}

/** Windows 上解析可执行文件：.exe 直接启动；.cmd/.bat（npm 全局安装）才走 shell */
const binCache = new Map();
function resolveWinBin(bin) {
  if (binCache.has(bin)) return binCache.get(bin);
  let found = { file: bin, shell: true };
  try {
    const r = spawnSync('where', [bin], { encoding: 'utf8', windowsHide: true });
    const hits = (r.stdout || '').split(/\r?\n/).filter(Boolean);
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) found = { file: exe, shell: false };
  } catch {}
  binCache.set(bin, found);
  return found;
}

/**
 * 启动 CLI。onEvent：每行 JSON 事件实时回调（用来更新"正在做什么"）；
 * keep(ev)：哪些 JSON 行留在返回的 stdout 里（工具输出可能很大，长任务全留会占满内存），默认全留
 */
function exec(bin, argv, input, { onEvent, keep } = {}) {
  return new Promise((resolve, reject) => {
    if (running?.cancelled) {
      const err = new Error('已中止');
      err.cancelled = true;
      return reject(err);
    }
    const isWin = process.platform === 'win32';
    const w = isWin ? resolveWinBin(bin) : { file: bin, shell: false };
    const child = spawn(w.file, w.shell ? argv.map(quoteWin) : argv, {
      cwd: cfg.workdir,
      shell: w.shell,
      detached: !isWin,
      // 把 room 工具的连接信息交给 CLI，让它执行中能看新消息、发进度
      env: {
        ...process.env,
        AGENT_ROOM_SERVER: cfg.server,
        AGENT_ROOM_PROJECT: cfg.project,
        AGENT_ROOM_AGENT: cfg.agent,
        AGENT_ROOM_TOKEN: cfg.token,
        AGENT_ROOM_CONFIG: CONN_FILE, // token 被过滤时 room 从这里读，不会退回到别的项目的配置
        AGENT_ROOM_TOOL: ROOM_TOOL,
        [pathKey]: SHIM_DIR + path.delimiter + (process.env[pathKey] || ''),
      },
      windowsHide: true,
    });
    running = { ...(running || { cancelled: false }), child };
    let stdout = '';
    let stderr = '';
    let partial = '';
    child.stdout.setEncoding('utf8'); // 避免多字节字符被切在两个数据块之间
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      if (!onEvent && !keep) return void (stdout += d);
      partial += d;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) handleLine(line);
    });
    const handleLine = (line) => {
      const t = line.trim();
      if (!t) return;
      let ev = null;
      if (t.startsWith('{')) {
        try {
          ev = JSON.parse(t);
        } catch {}
      }
      if (ev) {
        try {
          onEvent?.(ev);
        } catch {}
        if (!keep || keep(ev)) stdout += t + '\n';
      } else if (stdout.length < 500_000) stdout += line + '\n';
    };
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer =
      cfg.timeoutMin > 0
        ? setTimeout(() => {
            log(`执行超过 ${cfg.timeoutMin} 分钟，终止进程`);
            if (running) running.timedOut = true;
            killRunning();
          }, cfg.timeoutMin * 60_000)
        : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${bin}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (partial) handleLine(partial);
      if (running?.cancelled) {
        const err = new Error(running.timedOut ? '执行超时' : '已中止');
        err.cancelled = true;
        err.timedOut = !!running.timedOut;
        return reject(err);
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const simulatedLimits = new Set();
function throwIfLimit(text) {
  const info = detectLimit(text);
  if (!info) return;
  const e = new Error(`额度用完 / 限流：${info.text}`);
  e.limit = info;
  throw e;
}

async function runCli(prompt) {
  // 联调用：--dry-run 时消息里带 [模拟额度用完] 就假装碰到额度上限
  if (cfg.dryRun) {
    const t = currentTriggers.find((m) => /\[模拟额度用完(:\d+)?\]/.test(m.text) && !simulatedLimits.has(m.id));
    if (t) {
      simulatedLimits.add(t.id);
      throwIfLimit(`You've hit your usage limit. Try again in ${t.text.match(/\[模拟额度用完:(\d+)\]/)?.[1] || 3} seconds.`);
    }
  }
  if (cfg.dryRun) {
    // [模拟耗时:秒] 假装是长任务（可被中止 / 撤回打断），用来测试进展汇报
    const secs = parseFloat(currentTriggers.map((m) => m.text.match(/\[模拟耗时:(\d+(?:\.\d+)?)\]/)?.[1]).find(Boolean) || '0.8');
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      if (running?.cancelled) {
        const err = new Error('已中止');
        err.cancelled = true;
        throw err;
      }
    }
    return `（dry-run）我是 @${cfg.agent}，收到：${prompt.split('【需要你处理的消息】')[1]?.trim().slice(0, 300)}`;
  }
  return agentCli() === 'codex' ? runCodex(prompt) : runClaude(prompt);
}

// ---- Claude Code：claude -p，JSON 输出里拿 result 和 session_id ----
async function runClaude(prompt, allowResume = true) {
  const bin = cfg.bin || 'claude';
  // stream-json：边执行边拿到工具调用和文字，用来显示"正在做什么"、定期发进展；最后一行 type=result 和 json 格式一样
  const argv = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (cfg.yolo) argv.push('--dangerously-skip-permissions');
  // 默认放行 room 群聊工具，其余 shell 命令仍需 --yolo 或 --extra "--allowedTools ..."
  else argv.push('--permission-mode', cfg.permission || 'acceptEdits', '--allowedTools', 'Bash(room:*)', 'PowerShell(room:*)');
  if (cfg.model) argv.push('--model', cfg.model);
  const resume = allowResume && state.sessionId && !cfg.noResume;
  if (resume) argv.push('--resume', state.sessionId);
  argv.push(...cfg.extra);
  log(`执行：${bin} ${argv.join(' ')}`);
  const { code, stdout, stderr } = await exec(bin, argv, prompt, { onEvent: onClaudeEvent, keep: (ev) => ev.type === 'result' });
  let out = null;
  const plain = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (!line.trim().startsWith('{')) {
      plain.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line);
      if (o.type === 'result' || (!out && 'result' in o)) out = o;
    } catch {}
  }
  // 额度用完 / 限流：先于"续接失败重试"判断，避免白白丢掉会话
  const errText = out ? (out.is_error ? `${out.result || ''} ${out.subtype || ''}` : looksLikeLimitResult(out.result) ? out.result : '') : `${stderr}\n${plain.join('\n')}`;
  if (errText) throwIfLimit(errText);
  if (!out) {
    if (resume) {
      log('续接会话失败，改用新会话重试');
      saveState({ sessionId: null, primed: false });
      return runClaude(buildPrompt(currentTriggers), false);
    }
    throw new Error(`claude 退出码 ${code}：${(stderr || plain.join('\n')).trim().slice(-1500)}`);
  }
  if (out.session_id) saveState({ sessionId: out.session_id, primed: true });
  if (out.is_error) throw new Error(`claude 返回错误：${out.result || out.subtype || '未知错误'}`);
  return String(out.result ?? '');
}

// ---- Codex：codex exec，--json 里拿 thread_id，-o 拿最终消息 ----
async function runCodex(prompt, allowResume = true) {
  const bin = cfg.bin || 'codex';
  const outFile = path.join(stateDir, `${cfg.project}-${cfg.agent.replace(/[^\w-]/g, '_')}-last.txt`);
  fs.rmSync(outFile, { force: true });
  const resume = allowResume && state.sessionId && !cfg.noResume;
  const argv = ['exec'];
  if (resume) argv.push('resume');
  argv.push('--json', '--skip-git-repo-check', '-o', outFile);
  if (cfg.yolo) argv.push('--dangerously-bypass-approvals-and-sandbox');
  else if (cfg.permission) argv.push('--sandbox', cfg.permission);
  else argv.push('--full-auto');
  if (cfg.model) argv.push('-m', cfg.model);
  argv.push(...cfg.extra);
  if (resume) argv.push(state.sessionId);
  argv.push('-'); // 从 stdin 读取提示词
  log(`执行：${bin} ${argv.join(' ')}`);
  // 只保留需要的事件行（命令输出可能很大）：会话 id、出错、agent 消息
  const keep = (ev) => {
    const t = ev.type || '';
    return !!(ev.thread_id || ev.session_id || ev.msg?.session_id || /error|failed/.test(t) || /error/.test(ev.msg?.type || '') || (ev.item || ev.msg)?.type === 'agent_message' || ev.item?.item_type === 'agent_message');
  };
  const { code, stdout, stderr } = await exec(bin, argv, prompt, { onEvent: onCodexEvent, keep });
  let threadId = null;
  let lastAgentMsg = '';
  let errEvents = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      threadId = ev.thread_id || ev.session_id || ev.msg?.session_id || threadId;
      const item = ev.item || ev.msg;
      if (item && (item.type === 'agent_message' || item.item_type === 'agent_message') && item.text) lastAgentMsg = item.text;
      // 出错事件：{type:'error',message} / {type:'turn.failed',error:{message}} / 旧版 {msg:{type:'error',message}}
      if (ev.type === 'error' || ev.type === 'turn.failed' || ev.msg?.type === 'error' || ev.msg?.type === 'stream_error')
        errEvents += ` ${ev.message || ev.error?.message || ev.msg?.message || JSON.stringify(ev.error || '')}`;
    } catch {}
  }
  const result = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : lastAgentMsg;
  if (errEvents && (code !== 0 || !result.trim())) throwIfLimit(errEvents);
  if (code !== 0 && !result.trim()) throwIfLimit(stderr);
  if (code !== 0 && !result.trim()) {
    if (resume) {
      log('续接会话失败，改用新会话重试');
      saveState({ sessionId: null, primed: false });
      return runCodex(buildPrompt(currentTriggers), false);
    }
    throw new Error(`codex 退出码 ${code}：${stderr.trim().slice(-1500)}`);
  }
  if (threadId) saveState({ sessionId: threadId, primed: true });
  return result;
}

process.on('SIGINT', () => {
  log('退出');
  killRunning();
  process.exit(0);
});

connect();
