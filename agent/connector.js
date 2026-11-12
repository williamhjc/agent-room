#!/usr/bin/env node
// Agent Room 连接器：把本机的 Claude Code / Codex CLI 作为一个 agent 接入 room。
// 被 @ 时在项目工作目录里调用 CLI 完成任务，只把最终回复发到群里（不转发思考/执行过程）。
//
// 用法：
//   node agent/connector.js --server ws://HOST:8787/ws --project <ID> --agent <名称> --token <TOKEN> \
//        [--workdir 路径] [--cli claude|codex] [--bin 可执行文件] [--permission 模式] [--yolo] \
//        [--model 模型] [--extra "额外参数"] [--timeout 分钟] [--history 条数]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = globalThis.WebSocket ?? (await import('ws')).default;

// ---------- 参数 ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const env = process.env;
const cfg = {
  server: args.server || env.AGENT_ROOM_SERVER || 'ws://127.0.0.1:8787/ws',
  project: args.project || env.AGENT_ROOM_PROJECT,
  agent: args.agent || env.AGENT_ROOM_AGENT,
  token: args.token || env.AGENT_ROOM_TOKEN,
  workdir: path.resolve(args.workdir || env.AGENT_ROOM_WORKDIR || process.cwd()),
  cli: args.cli || env.AGENT_ROOM_CLI || '', // 为空则用项目里给该 agent 定义的类型
  bin: args.bin || env.AGENT_ROOM_BIN || '',
  permission: args.permission || env.AGENT_ROOM_PERMISSION || '',
  yolo: !!(args.yolo || env.AGENT_ROOM_YOLO === '1'),
  model: args.model || env.AGENT_ROOM_MODEL || '',
  extra: String(args.extra || env.AGENT_ROOM_EXTRA || '').split(/\s+/).filter(Boolean),
  timeoutMin: parseFloat(args.timeout || env.AGENT_ROOM_TIMEOUT || '30'),
  historyN: parseInt(args.history || env.AGENT_ROOM_HISTORY || '40', 10),
  noResume: !!args['no-resume'],
  dryRun: !!args['dry-run'], // 不调用 CLI，原样回显（用于联调）
};
if (!cfg.project || !cfg.agent || !cfg.token) {
  console.error('缺少参数：--project --agent --token 必填（也可用环境变量 AGENT_ROOM_PROJECT / AGENT_ROOM_AGENT / AGENT_ROOM_TOKEN）');
  process.exit(1);
}
if (!fs.existsSync(cfg.workdir)) fs.mkdirSync(cfg.workdir, { recursive: true });

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}] [${cfg.agent}]`, ...a);

// ---------- 本地状态（会话 id、已处理游标） ----------
const stateDir = path.join(os.homedir(), '.agent-room', 'state');
fs.mkdirSync(stateDir, { recursive: true });
const stateFile = path.join(stateDir, `${cfg.project}-${cfg.agent.replace(/[^\w-]/g, '_')}.json`);
let state = { sessionId: null, cursor: null, primed: false };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) };
} catch {}
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

// ---------- 运行时 ----------
let ws = null;
let project = null;
let self = null;
let history = [];
let pending = []; // 待处理的触发消息
let running = null; // { child, cancelled }
let backoff = 1000;
let lastPong = Date.now();

function send(data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}
function setStatus(status, note = '') {
  send({ type: 'status', status, note });
}

function connect() {
  log(`连接 ${cfg.server} ...`);
  ws = new WS(cfg.server);
  ws.onopen = () => {
    backoff = 1000;
    lastPong = Date.now();
    send({ type: 'hello', kind: 'agent', projectId: cfg.project, agent: cfg.agent, token: cfg.token, host: os.hostname() });
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
      // 处理离线期间 @ 我的消息（只看游标之后、1 小时以内的）
      const idx = state.cursor ? history.findIndex((m) => m.id === state.cursor) : -1;
      const backlog = history
        .slice(idx + 1)
        .filter((m) => isForMe(m) && Date.now() - m.ts < 3600_000 && !pending.find((p) => p.id === m.id));
      if (backlog.length && !running) {
        log(`发现 ${backlog.length} 条离线期间的 @ 消息，开始处理`);
        pending.push(...backlog);
      }
      setStatus(running ? 'working' : 'idle');
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
      if (history.length > 500) history = history.slice(-300);
      if (isForMe(m)) {
        log(`被 @：${m.from}: ${m.text.slice(0, 80)}`);
        pending.push(m);
        pump();
      }
      return;
    }
    case 'control':
      if (data.action === 'cancel') {
        log(`${data.by} 请求中止当前任务`);
        pending = [];
        if (killRunning()) post('（已按用户要求中止当前任务）');
      } else if (data.action === 'reset') {
        log(`${data.by} 请求重置会话`);
        state.sessionId = null;
        state.primed = false;
        saveState();
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
  if (running || !pending.length || !project) return;
  const triggers = pending;
  pending = [];
  const last = triggers[triggers.length - 1];
  const prompt = buildPrompt(triggers);
  state.cursor = history[history.length - 1]?.id || last.id;
  saveState();
  setStatus('working', `处理 ${last.from} 的消息`);
  let reply;
  try {
    reply = await runCli(prompt);
  } catch (e) {
    log('执行失败：', e.message);
    reply = e.cancelled ? null : `⚠️ 执行出错：${e.message.slice(0, 1500)}`;
    setStatus('error', e.message.slice(0, 120));
  }
  if (reply !== null) post(reply.trim() || '（无输出）', last.id);
  setStatus('idle');
  running = null;
  setImmediate(pump);
}

function fmt(m) {
  const t = new Date(m.ts).toLocaleString('zh-CN', { hour12: false });
  const who = m.fromType === 'user' ? `${m.from}（用户）` : m.fromType === 'system' ? '系统' : `@${m.from}`;
  return `[${t}] ${who}: ${m.text}`;
}

function buildPrompt(triggers) {
  const cliName = agentCli() === 'codex' ? 'Codex' : 'Claude Code';
  const roster = project.agents
    .map((a) => `- @${a.name}（${a.type}）${a.name === cfg.agent ? ' ← 你' : ''}：${a.role || '未定义分工'}`)
    .join('\n');
  const trig = triggers.map(fmt).join('\n');
  const rules = `协作规则：
1. 你的最终回复会原样发到项目群聊，所有成员和用户都能看到。只输出要发到群里的内容（结论、进展、需要别人做的事），不要复述思考过程或逐条罗列执行日志。
2. 需要其他成员接手或配合时，在回复里 @对方名字 并写清楚具体任务和验收标准；一条消息可以 @多人。
3. 不需要别人处理时不要 @任何人，避免无意义的来回接力；不要 @自己。
4. 用户（人类）是最终决策者。需求不明确或有重大取舍时，直接在群里向用户提问，不要 @agent。
5. 只做你分工内的事；在当前工作目录中直接读写代码、运行命令来完成任务，完成后简要汇报改了什么、结果如何。`;

  const resumed = state.primed && state.sessionId && !cfg.noResume;
  if (resumed) {
    // 已有会话上下文：只发送上次之后的新消息
    const idx = state.lastSeen ? history.findIndex((m) => m.id === state.lastSeen) : -1;
    const fresh = history.slice(idx + 1).filter((m) => m.from !== cfg.agent);
    state.lastSeen = history[history.length - 1]?.id;
    return `【群聊新消息】\n${fresh.map(fmt).join('\n') || trig}\n\n【需要你回复的消息】\n${trig}\n\n（提醒：${rules.split('\n')[1].slice(3)}）\n请给出你要发到群里的回复：`;
  }
  const recent = history.slice(-cfg.historyN).map(fmt).join('\n');
  state.lastSeen = history[history.length - 1]?.id;
  return `你是多 agent 协作项目「${project.name}」中的成员 @${cfg.agent}，由 ${cliName} 驱动。

【你的分工角色】
${self?.role || '未定义，请根据项目需要合理承担工作'}

【项目说明】
${project.description || '（无）'}

【团队成员】
${roster}

${rules}

【最近群聊记录】
${recent}

【需要你回复的消息】
${trig}

请完成你负责的部分，然后给出你要发到群里的回复：`;
}

function agentCli() {
  return cfg.cli || self?.type || 'claude';
}

function quoteWin(s) {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function killRunning() {
  if (!running?.child) return false;
  running.cancelled = true;
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

function exec(bin, argv, input) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const w = isWin ? resolveWinBin(bin) : { file: bin, shell: false };
    const child = spawn(w.file, w.shell ? argv.map(quoteWin) : argv, {
      cwd: cfg.workdir,
      shell: w.shell,
      detached: !isWin,
      env: { ...process.env, AGENT_ROOM_AGENT: cfg.agent },
      windowsHide: true,
    });
    running = { child, cancelled: false };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    const timer = setTimeout(() => {
      log('执行超时，终止进程');
      killRunning();
    }, cfg.timeoutMin * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${bin}：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const cancelled = running?.cancelled;
      if (cancelled) {
        const err = new Error('已中止');
        err.cancelled = true;
        return reject(err);
      }
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function runCli(prompt) {
  if (cfg.dryRun) {
    await new Promise((r) => setTimeout(r, 800));
    return `（dry-run）我是 @${cfg.agent}，收到：${prompt.split('【需要你回复的消息】')[1]?.trim().slice(0, 300)}`;
  }
  return agentCli() === 'codex' ? runCodex(prompt) : runClaude(prompt);
}

// ---- Claude Code：claude -p，JSON 输出里拿 result 和 session_id ----
async function runClaude(prompt, allowResume = true) {
  const bin = cfg.bin || 'claude';
  const argv = ['-p', '--output-format', 'json'];
  if (cfg.yolo) argv.push('--dangerously-skip-permissions');
  else argv.push('--permission-mode', cfg.permission || 'acceptEdits');
  if (cfg.model) argv.push('--model', cfg.model);
  const resume = allowResume && state.sessionId && !cfg.noResume;
  if (resume) argv.push('--resume', state.sessionId);
  argv.push(...cfg.extra);
  log(`执行：${bin} ${argv.join(' ')}`);
  const { code, stdout, stderr } = await exec(bin, argv, prompt);
  let out = null;
  try {
    out = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  } catch {}
  if (!out) {
    if (resume) {
      log('续接会话失败，改用新会话重试');
      state.sessionId = null;
      state.primed = false;
      return runClaude(rebuildFresh(prompt), false);
    }
    throw new Error(`claude 退出码 ${code}：${(stderr || stdout).trim().slice(-1500)}`);
  }
  if (out.session_id) {
    state.sessionId = out.session_id;
    state.primed = true;
    saveState();
  }
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
  const { code, stdout, stderr } = await exec(bin, argv, prompt);
  let threadId = null;
  let lastAgentMsg = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      threadId = ev.thread_id || ev.session_id || ev.msg?.session_id || threadId;
      const item = ev.item || ev.msg;
      if (item && (item.type === 'agent_message' || item.item_type === 'agent_message') && item.text) lastAgentMsg = item.text;
    } catch {}
  }
  let result = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : lastAgentMsg;
  if (code !== 0 && !result.trim()) {
    if (resume) {
      log('续接会话失败，改用新会话重试');
      state.sessionId = null;
      state.primed = false;
      return runCodex(rebuildFresh(prompt), false);
    }
    throw new Error(`codex 退出码 ${code}：${stderr.trim().slice(-1500)}`);
  }
  if (threadId) {
    state.sessionId = threadId;
    state.primed = true;
    saveState();
  }
  return result;
}

/** 续接失败时，用完整上下文重新构造提示词 */
function rebuildFresh(prompt) {
  const trigPart = prompt.split('【需要你回复的消息】')[1]?.split('\n\n')[0]?.trim();
  const idx = trigPart ? history.findIndex((m) => trigPart.includes(m.text.slice(0, 50))) : -1;
  const triggers = idx >= 0 ? history.slice(idx).filter(isForMe) : history.slice(-1);
  state.primed = false;
  return buildPrompt(triggers.length ? triggers : history.slice(-1));
}

process.on('SIGINT', () => {
  log('退出');
  killRunning();
  process.exit(0);
});

connect();
