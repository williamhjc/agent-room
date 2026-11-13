#!/usr/bin/env node
// Agent Room 连接器：把本机的 Claude Code / Codex CLI 作为一个 agent 接入 room。
// 常驻监听；被 @ 时在项目工作目录里调用 CLI 完成任务，只把最终回复发到群里（不转发思考/执行过程）。
//
// 用法：
//   node agent/connector.js --server ws://HOST:8787/ws --project <ID> --agent <名称> --token <TOKEN> \
//        [--workdir 路径] [--cli claude|codex] [--bin 可执行文件] [--permission 模式] [--yolo] \
//        [--model 模型] [--extra "额外参数"] [--timeout 分钟] [--history 条数]
// 连接信息也可以来自环境变量 AGENT_ROOM_* 或当前目录的 .agent-room.json（room init 生成）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WS, parseArgs, loadConn, httpBase, stateDir, readState, updateState, fmtMessage, ensureRoomShim } from './common.js';

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
  timeoutMin: parseFloat(args.timeout || env.AGENT_ROOM_TIMEOUT || '30'),
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
      const pendIds = new Set(data.pending || []);
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
      if (history.length > 600) history = history.slice(-400);
      if (isForMe(m)) {
        log(`被 @：${m.from}: ${m.text.slice(0, 80)}`);
        pending.push(m);
        if (running) {
          // 排队情况实时反映到群成员状态上（网页能看到"排队 N 条"）
          log(`正在执行任务，排队 ${pending.length} 条`);
          setStatus('working', `${runNote} · 排队 ${pending.length} 条`);
        }
        pump();
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
  // 执行期间 CLI 已经通过 room inbox 看到（并确认）的消息，不再单独开一轮
  const seenByChild = readState(conn).seenTs || 0;
  const skipped = pending.filter((m) => m.ts <= seenByChild && state.lastRunEnd && m.ts > state.lastRunStart);
  const triggers = pending.filter((m) => !skipped.includes(m));
  pending = [];
  if (skipped.length) log(`${skipped.length} 条消息已在上一轮执行中通过 room inbox 处理，跳过`);
  if (!triggers.length) return;
  currentTriggers = triggers;
  const last = triggers[triggers.length - 1];
  running = { child: null, cancelled: false };
  // 确认接单：服务端据此判断 agent 没有"停"
  send({ type: 'ack', ids: triggers.map((m) => m.id) });
  runNote = `处理 ${last.from} 的消息`;
  setStatus('working', runNote);
  const prompt = buildPrompt(triggers);
  const runStart = Date.now();
  saveState({ lastTrigger: last.id, lastRunStart: runStart, seenTs: history.at(-1)?.ts || last.ts });
  let reply;
  try {
    reply = await runCli(prompt);
  } catch (e) {
    log('执行失败：', e.message);
    if (e.timedOut) {
      reply = `⚠️ 这次任务执行超过 ${cfg.timeoutMin} 分钟，被连接器终止（--timeout 上限），结果可能不完整。需要继续请再 @我（会接着上次的会话），或调大连接器的 --timeout（0 为不限制）。`;
    } else reply = e.cancelled ? null : `⚠️ 执行出错：${e.message.slice(0, 1500)}`;
    setStatus('error', e.message.slice(0, 120));
  }
  if (reply !== null) post(reply.trim() || '（无输出）', last.id);
  saveState({ doneTs: last.ts, lastRunEnd: Date.now() });
  running = null;
  currentTriggers = [];
  setStatus('idle');
  setImmediate(pump);
}

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
7. 截图等图片用 room send --attach 发送，不要把 base64 贴进消息。`;

  const resumed = state.primed && state.sessionId && !cfg.noResume;
  if (resumed) {
    // 已有会话上下文：只发送上次看过之后的新消息
    const seenTs = Math.max(state.seenTs || 0, readState(conn).seenTs || 0);
    const trigIds = new Set(triggers.map((m) => m.id));
    const fresh = history.filter((m) => m.ts > seenTs && m.from !== cfg.agent && !trigIds.has(m.id));
    return `${fresh.length ? `【你上次之后群里的其他新消息】\n${fresh.map(fmt).join('\n\n')}\n\n` : ''}【需要你处理的消息】\n${trig}${multi}\n\n（提醒：最终输出会原样发到群里；需要别人接手就 @ 对方；可用 room inbox 查看执行期间的新消息。）\n请完成后给出你要发到群里的回复：`;
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
      // 把 room 工具的连接信息交给 CLI，让它执行中能看新消息、发进度
      env: {
        ...process.env,
        AGENT_ROOM_SERVER: cfg.server,
        AGENT_ROOM_PROJECT: cfg.project,
        AGENT_ROOM_AGENT: cfg.agent,
        AGENT_ROOM_TOKEN: cfg.token,
        AGENT_ROOM_TOOL: ROOM_TOOL,
        [pathKey]: SHIM_DIR + path.delimiter + (process.env[pathKey] || ''),
      },
      windowsHide: true,
    });
    running = { child, cancelled: running?.cancelled || false };
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
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

async function runCli(prompt) {
  if (cfg.dryRun) {
    await new Promise((r) => setTimeout(r, 800));
    return `（dry-run）我是 @${cfg.agent}，收到：${prompt.split('【需要你处理的消息】')[1]?.trim().slice(0, 300)}`;
  }
  return agentCli() === 'codex' ? runCodex(prompt) : runClaude(prompt);
}

// ---- Claude Code：claude -p，JSON 输出里拿 result 和 session_id ----
async function runClaude(prompt, allowResume = true) {
  const bin = cfg.bin || 'claude';
  const argv = ['-p', '--output-format', 'json'];
  if (cfg.yolo) argv.push('--dangerously-skip-permissions');
  // 默认放行 room 群聊工具，其余 shell 命令仍需 --yolo 或 --extra "--allowedTools ..."
  else argv.push('--permission-mode', cfg.permission || 'acceptEdits', '--allowedTools', 'Bash(room:*)', 'PowerShell(room:*)');
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
      saveState({ sessionId: null, primed: false });
      return runClaude(buildPrompt(currentTriggers), false);
    }
    throw new Error(`claude 退出码 ${code}：${(stderr || stdout).trim().slice(-1500)}`);
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
  const result = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : lastAgentMsg;
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
