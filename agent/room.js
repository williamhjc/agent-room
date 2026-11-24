#!/usr/bin/env node
// room：让任意 agent（交互式 Codex / Claude Code 会话、脚本）收发 Agent Room 群消息的命令行工具。
//
//   node room.js init --server ws://HOST:8787/ws --project ID --agent 名称 --token TOKEN
//   node room.js wait [--timeout 600]     阻塞等待下一条 @你 的消息（会话模式的核心：干完活就再 wait）
//   node room.js send "内容" [--attach 图片.png] [--reply 消息id] [--done] [--ask 需要用户确认，会推送到手机]
//   node room.js inbox [--peek]           查看上次之后的新消息（不阻塞）
//   node room.js show <消息id>            查看某条消息全文
//   node room.js history [-n 20]          最近的群聊记录
//   node room.js status working|idle [说明]
//   node room.js who                      成员与在线状态
//   node room.js usage [--json]           查看本机 Claude/Codex 订阅额度（并同步到网页）
//   node room.js model "模型名" [--effort high]  告诉群里你当前用的模型（会话模式用）
//   node room.js recall <消息id>          撤回自己发的消息
//   node room.js get <附件URL> [-o 文件]  下载附件
//
// 会话模式下 room wait / send 会顺带在后台启动一个监视进程（每个会话一个）：把会话窗口里的思考和执行过程
// 实时显示到网页工位卡片上；CLI 进程退出（被关掉、内存不足被系统结束）时马上通知群里。设 AGENT_ROOM_NO_WATCH=1 关闭
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  loadConn,
  connectAgent,
  readState,
  updateState,
  fmtMessage,
  httpBase,
  uploadFile,
  fetchUsage,
  fmtUsage,
  detectModel,
  setClientCmd,
  stateDir,
  pidAlive,
  findCliProcess,
  findTranscript,
  claudeActivity,
  makeCodexActivity,
  activitySender,
} from './common.js';

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'help';
const args = parseArgs(argv, ['attach'], [], ['ask', 'review', 'done', 'peek', 'stdin', 'json']);
const conn = loadConn(args);
const base = conn.server ? httpBase(conn.server) : '';
const out = (s = '') => process.stdout.write(s + '\n');
const die = (s, code = 1) => {
  process.stderr.write(s + '\n');
  process.exit(code);
};

function need() {
  if (conn.project && conn.agent && !conn.token) {
    die(`缺少 @${conn.agent} 的 token（项目 ${conn.project}）。如果是在连接器启动的 CLI 里运行，请用 node "${process.env.AGENT_ROOM_TOOL || 'room.js'}"，或检查环境变量 AGENT_ROOM_CONFIG 指向的连接文件；不要改用其他目录里的 .agent-room.json（那可能是另一个项目的）。`);
  }
  if (!conn.project || !conn.agent || !conn.token) {
    die('缺少连接信息：先运行 room init --server ... --project ... --agent ... --token ...，或设置环境变量 AGENT_ROOM_SERVER / AGENT_ROOM_PROJECT / AGENT_ROOM_AGENT / AGENT_ROOM_TOKEN');
  }
}
const isForMe = (m) => !m.recalled && m.from !== conn.agent && Array.isArray(m.dispatch) && m.dispatch.includes(conn.agent);
/** 会话模式上报当前模型：room model 手动设置的优先，否则读 CLI 配置 */
function sendInfo(c) {
  const type = args.cli || c.welcome.self?.type;
  if (!['claude', 'codex'].includes(type)) return;
  const st = readState(conn);
  const info = st.model ? { cli: type, model: st.model, effort: st.effort || '', source: 'self' } : { cli: type, ...detectModel(type) };
  c.send({ type: 'info', info });
}
/** 查本机订阅额度并上报（会话模式靠 room wait 顺带上报，5 分钟最多一次） */
async function reportUsage(c, force = false) {
  const type = args.cli || c.welcome.self?.type;
  if (!['claude', 'codex'].includes(type)) return null;
  if (!force && Date.now() - (readState(conn).usageAt || 0) < 5 * 60_000) return null;
  updateState(conn, { usageAt: Date.now() });
  const u = await fetchUsage(type);
  await c.request({ type: 'usage', usage: u }).catch(() => {});
  return u;
}
const show = (m, full = false) => out(fmtMessage(m, { base, me: conn.agent, maxLen: full ? 0 : 3000 }) + '\n');

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const commands = {
  async init() {
    if (!conn.project || !conn.agent || !conn.token) die('用法：room init --server ws://HOST:8787/ws --project ID --agent 名称 --token TOKEN [--file 路径]');
    const { welcome, close } = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    close();
    const file = path.resolve(args.file || '.agent-room.json');
    fs.writeFileSync(file, JSON.stringify(conn, null, 2));
    // 避免把 token 提交进仓库
    try {
      const gitExclude = path.join(path.dirname(file), '.git', 'info', 'exclude');
      if (fs.existsSync(gitExclude) && !fs.readFileSync(gitExclude, 'utf8').includes(path.basename(file))) {
        fs.appendFileSync(gitExclude, `\n${path.basename(file)}\n`);
      }
    } catch {}
    out(`已保存连接信息到 ${file}`);
    out(`项目「${welcome.project.name}」，你是 @${conn.agent}（${welcome.self.type}）：${welcome.self.role || '未定义分工'}`);
  },

  async wait() {
    need();
    ensureWatcher();
    const timeoutSec = parseFloat(args.timeout ?? '600');
    const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;
    const timeoutExit = () => {
      out(`（${timeoutSec} 秒内没有 @你 的新消息。请再次运行 room wait 继续等待。）`);
      process.exit(3);
    };
    // 服务端重启 / 网络抖动时自动重连，直到等到消息或超时
    let backoff = 1000;
    for (;;) {
      let r;
      try {
        r = await waitOnce(deadline); // 定义在文件末尾
      } catch (e) {
        if (/code=40(03|04|09)|token|不存在|不正确/.test(e.message)) throw e; // 鉴权失败 / 被新连接替换：不重连
        r = 'closed';
      }
      if (r === 'done') return;
      if (r === 'timeout' || Date.now() + backoff >= deadline) return timeoutExit();
      if (r === 'replaced') return out('（本次 room wait 被同一 agent 的新连接替换，已退出。）');
      process.stderr.write(`（与服务器的连接断开，${backoff / 1000} 秒后重连…）\n`);
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, 10_000);
    }
  },

  async _waitOnceBody(deadline) {
    const st = readState(conn);
    const seenTs = st.seenTs || 0;
    const buffer = [];
    let resolveHit;
    const hit = new Promise((r) => (resolveHit = r));
    let resolveClosed;
    const closed = new Promise((r) => (resolveClosed = r));
    const c = await connectAgent(conn, {
      mode: 'wait',
      historyLimit: 200,
      keepalive: true, // 网络静默断开时能察觉并重连，而不是"终端在监听、网页显示离线"
      onMessage: (d) => {
        if (d.type === 'recall') {
          for (const m of buffer) if (m.id === d.id) Object.assign(m, { recalled: true, text: '' });
          return;
        }
        if (d.type !== 'message') return;
        buffer.push(d.message);
        if (isForMe(d.message)) resolveHit();
      },
      onClose: (ev) => resolveClosed(ev.code === 4009 ? 'replaced' : 'closed'),
    });
    sendInfo(c);
    reportUsage(c).catch(() => {});
    const pendingIds = new Set(c.welcome.pending || []);
    const hist = c.welcome.history;
    // 首次使用（无游标）只取未接单的派发 + 少量上下文，避免把整段历史当新消息
    let fresh = seenTs ? hist.filter((m) => m.ts > seenTs) : hist.filter((m) => pendingIds.has(m.id));
    if (!seenTs && fresh.length) fresh = hist.slice(Math.max(0, hist.indexOf(fresh[0]) - 5));
    const ready = () => [...fresh, ...buffer].some((m) => isForMe(m) || pendingIds.has(m.id));
    if (!ready()) {
      let timer;
      const timedOut = new Promise((r) => {
        if (deadline !== Infinity) timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()));
      });
      const r = await Promise.race([hit, timedOut, closed]);
      clearTimeout(timer);
      if (r === 'timeout') {
        c.close();
        return 'timeout';
      }
      if (r === 'closed' || r === 'replaced') return r;
    }
    const all = [...fresh, ...buffer].filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
    const mine = all.filter((m) => isForMe(m) || pendingIds.has(m.id));
    out(`=== 新消息 ${all.length} 条，其中需要你处理 ${mine.length} 条（标记【@你】）===\n`);
    for (const m of all) show(m);
    if (mine.length > 1) out('提示：多条任务时以最新消息为准，被后续消息取代的旧任务（例如更新了提交号）不要重复做。\n');
    out('处理完后用 `room send "回复内容"` 发到群里（需要别人接手就 @ 对方），然后再次运行 `room wait`。');
    await c.request({ type: 'ack', ids: mine.map((m) => m.id), note: `处理 ${mine[mine.length - 1].from} 的消息` }).catch(() => {});
    updateState(conn, { seenTs: Math.max(seenTs, ...all.map((m) => m.ts)), lastTrigger: mine[mine.length - 1].id });
    c.close();
    return 'done';
  },

  async inbox() {
    need();
    const st = readState(conn);
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 200 });
    c.close();
    const hist = c.welcome.history;
    const fresh = st.seenTs ? hist.filter((m) => m.ts > st.seenTs) : hist.slice(-10);
    if (!fresh.length) return out('没有新消息。');
    out(`=== ${fresh.length} 条新消息 ===\n`);
    fresh.forEach((m) => show(m));
    const mine = fresh.filter(isForMe);
    if (!args.peek) {
      updateState(conn, { seenTs: Math.max(st.seenTs || 0, ...fresh.map((m) => m.ts)), ...(mine.length ? { lastTrigger: mine.at(-1).id } : {}) });
    }
    if (mine.length) {
      const c2 = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
      await c2.request({ type: 'ack', ids: mine.map((m) => m.id) }).catch(() => {});
      c2.close();
    }
  },

  async send() {
    need();
    ensureWatcher();
    let text = args._.join(' ');
    if (args.file) text = fs.readFileSync(args.file, 'utf8');
    if (args.stdin || (!text && !args.attach)) text = (await readStdin()) || text;
    text = text.trim();
    // 需要用户本人确认 / 决策：标记后服务端推送 Bark 到用户手机（--review 为旧写法，同义）
    const meta = args.ask || args.review ? { kind: 'ask' } : undefined;
    const attachments = [];
    for (const f of args.attach || []) attachments.push(await uploadFile(conn, f));
    if (!text && !attachments.length) die('消息为空：room send "内容" 或 --attach 文件');
    const st = readState(conn);
    const replyTo = args.reply && args.reply !== true ? args.reply : st.lastTrigger;
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    const r = await c.request({ type: 'message', text, attachments, replyTo, ...(meta ? { meta } : {}) });
    if (args.done) await c.request({ type: 'status', status: 'idle' }).catch(() => {});
    c.close();
    out(`已发送到项目「${c.welcome.project.name}」（id=${r.id}${attachments.length ? `，附件 ${attachments.length} 个` : ''}）`);
  },

  async show() {
    need();
    const id = args._[0];
    if (!id) die('用法：room show <消息id>');
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 500 });
    c.close();
    const m = c.welcome.history.find((x) => x.id === id);
    if (!m) die(`最近 500 条里没有找到消息 ${id}`);
    show(m, true);
  },

  async history() {
    need();
    const n = parseInt(args.n || args._[0] || '20', 10);
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: n });
    c.close();
    c.welcome.history.forEach((m) => show(m));
  },

  async status() {
    need();
    const [status = 'idle', ...note] = args._;
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    await c.request({ type: 'status', status, note: note.join(' ') });
    c.close();
    out(`状态已更新为 ${status}`);
  },

  async recall() {
    need();
    const id = args._[0];
    if (!id) die('用法：room recall <消息id>（只能撤回自己发的消息）');
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    await c.request({ type: 'recall', id }).finally(() => c.close());
    out(`已撤回 ${id}`);
  },

  async model() {
    need();
    const name = args._.join(' ').trim();
    if (!name) die('用法：room model "你当前使用的模型名" [--effort high]');
    updateState(conn, { model: name.slice(0, 60), effort: args.effort && args.effort !== true ? String(args.effort).slice(0, 20) : '' });
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    const effort = readState(conn).effort || '';
    await c.request({ type: 'info', info: { cli: args.cli || c.welcome.self?.type, model: name, effort, source: 'self' } }).finally(() => c.close());
    out(`已更新：@${conn.agent} 当前模型 ${name}`);
  },

  async who() {
    need();
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    c.close();
    const { project, presence } = c.welcome;
    const pres = new Map((presence || []).map((a) => [a.name, a]));
    out(`项目「${project.name}」${project.paused ? '（已暂停）' : ''}\n${project.description || ''}\n`);
    for (const a of project.agents) {
      const p = pres.get(a.name) || {};
      out(`@${a.name}（${a.type}）${a.name === conn.agent ? ' ← 你' : ''} [${p.status || 'offline'}${p.pending ? `，待接单 ${p.pending}` : ''}]\n  ${a.role || '未定义分工'}`);
    }
  },

  async usage() {
    need();
    const c = await connectAgent(conn, { mode: 'tool', historyLimit: 1 });
    const u = await reportUsage(c, true);
    c.close();
    if (!u) die(`不知道 @${conn.agent} 用的是哪个 CLI，请加 --cli claude 或 --cli codex`);
    out(args.json ? JSON.stringify(u, null, 2) : fmtUsage(u));
  },

  async get() {
    const u = args._[0];
    if (!u) die('用法：room get <附件URL或/files/路径> [-o 文件]');
    const url = u.startsWith('http') ? u : base + u;
    const res = await fetch(url);
    if (!res.ok) die(`下载失败：HTTP ${res.status}`);
    const file = path.resolve(args.o || decodeURIComponent(path.basename(new URL(url).pathname)));
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    out(`已保存到 ${file}`);
  },

  async help() {
    const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
    const end = lines.findIndex((l) => !l.startsWith('//'));
    out(lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  },
};

// ---------- 会话监视进程 ----------
const ROOM_JS = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchLockFile = () => path.join(stateDir, `${conn.project}-${String(conn.agent).replace(/[^\w-]/g, '_')}.watch.json`);
function readLock() {
  try {
    return JSON.parse(fs.readFileSync(watchLockFile(), 'utf8'));
  } catch {
    return null;
  }
}
function writeLock(d) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(watchLockFile(), JSON.stringify(d));
  } catch {}
}
/** 会话模式：确保有一个后台监视进程盯着当前会话。已经有了就立即返回 */
function ensureWatcher() {
  const env = process.env;
  // 连接器启动的 CLI（会带 AGENT_ROOM_TOOL）：连接器自己会上报执行过程
  if (env.AGENT_ROOM_CONNECTOR || env.AGENT_ROOM_TOOL || env.AGENT_ROOM_NO_WATCH === '1') return;
  try {
    const lock = readLock();
    const sess = env.CLAUDECODE ? env.CLAUDE_CODE_SESSION_ID || '' : '';
    if (lock?.pid && pidAlive(lock.pid) && lock.cliPid && pidAlive(lock.cliPid) && (!sess || lock.session === sess) && (!+env.CLAUDE_PID || +env.CLAUDE_PID === lock.cliPid)) return;
    if (lock?.launching && Date.now() - lock.launching < 15_000) return;
    // 不在 Claude Code / Codex 里运行（脚本、普通终端）：同一个父进程 10 分钟内不再查进程树
    if (lock?.noCli && Date.now() - lock.at < 10 * 60_000 && lock.ppid === process.ppid) return;
    const cli = findCliProcess();
    if (!cli) return writeLock({ noCli: true, at: Date.now(), ppid: process.ppid });
    writeLock({ pid: 0, launching: Date.now(), cli: cli.cli, cliPid: cli.pid, session: cli.session });
    const argv = [ROOM_JS, '_watch-launch', '--cli', cli.cli, '--cli-pid', String(cli.pid), '--cwd', process.cwd()];
    if (cli.session) argv.push('--session', cli.session);
    // 连接信息走环境变量（不放命令行，免得 token 出现在进程列表里）
    const childEnv = { ...env, AGENT_ROOM_SERVER: conn.server, AGENT_ROOM_PROJECT: conn.project, AGENT_ROOM_AGENT: conn.agent, AGENT_ROOM_TOKEN: conn.token };
    spawn(process.execPath, argv, { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv }).unref();
  } catch {}
}

const watchCommands = {
  /** 再起一层就退出：监视进程不挂在 CLI 的进程树下，CLI 按进程树清理工具调用时不会把它一起杀掉 */
  async '_watch-launch'() {
    spawn(process.execPath, [ROOM_JS, '_watch', ...process.argv.slice(3)], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env }).unref();
  },

  /** 监视进程本体：同步会话记录到网页；CLI 进程退出时通知服务端 */
  async _watch() {
    need();
    const cli = args.cli === 'codex' ? 'codex' : 'claude';
    const cliName = cli === 'codex' ? 'Codex' : 'Claude Code';
    const cliPid = parseInt(args['cli-pid'], 10) || 0;
    const session = typeof args.session === 'string' ? args.session : '';
    const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();
    writeLock({ pid: process.pid, cli, cliPid, session, startedAt: Date.now() });
    let c = null;
    let stopping = false;
    const sender = activitySender((d) => (c ? c.send(d) : false));
    const toAct = cli === 'codex' ? makeCodexActivity() : claudeActivity;
    const exit = (code = 0) => {
      if (readLock()?.pid === process.pid) fs.rmSync(watchLockFile(), { force: true });
      process.exit(code);
    };

    // 增量读取会话记录（jsonl，一行一个事件）
    let file = null;
    let offset = 0;
    let rest = Buffer.alloc(0);
    let skipPartial = false;
    const openFile = (f) => {
      file = f;
      rest = Buffer.alloc(0);
      let size = 0;
      try {
        size = fs.statSync(f).size;
      } catch {}
      offset = Math.max(0, size - 96 * 1024); // 带上最近的一小段，网页一打开就有上下文
      skipPartial = offset > 0;
    };
    const readNew = () => {
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        return [];
      }
      if (size < offset) {
        offset = 0; // 文件被重写
        rest = Buffer.alloc(0);
      }
      if (size === offset) return [];
      const len = Math.min(size - offset, 8 << 20);
      const buf = Buffer.alloc(len);
      let n = 0;
      try {
        const fd = fs.openSync(file, 'r');
        n = fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
      } catch {
        return [];
      }
      offset += n;
      const data = Buffer.concat([rest, buf.subarray(0, n)]);
      const nl = data.lastIndexOf(10);
      if (nl < 0) {
        rest = data.length > 32 << 20 ? Buffer.alloc(0) : data;
        return [];
      }
      rest = data.subarray(nl + 1);
      const lines = data.subarray(0, nl).toString('utf8').split('\n');
      if (skipPartial) {
        lines.shift();
        skipPartial = false;
      }
      const evs = [];
      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith('{')) continue;
        try {
          evs.push(...toAct(JSON.parse(t)));
        } catch {}
      }
      return evs;
    };

    // 与服务端的连接：断线自动重连；被新的监视进程替换（4009）或 agent 被删除时退出
    (async () => {
      let backoff = 1000;
      while (!stopping) {
        try {
          let onClosed;
          const closed = new Promise((r) => (onClosed = r));
          const cc = await connectAgent(conn, { mode: 'watch', historyLimit: 1, keepalive: true, onClose: (ev) => onClosed(ev) });
          if (cc.welcome.mode !== 'watch') {
            cc.close(); // 旧版服务端不认识 watch 连接
            exit(0);
          }
          c = cc;
          backoff = 1000;
          c.send({ type: 'session', state: 'alive', cli, pid: cliPid, transcript: file ? path.basename(file) : '' });
          sender.flush();
          const ev = await closed;
          c = null;
          if (!stopping && [4003, 4004, 4009].includes(ev.code)) exit(0);
        } catch (e) {
          if (/code=40(03|04|09)|token|不存在|不正确/.test(e.message)) exit(1);
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    })();

    const ended = async () => {
      stopping = true;
      sender.flush();
      const reason = `${cliName} 进程（pid ${cliPid}）已退出`;
      for (let i = 0; i < 5; i++) {
        try {
          const cc = c || (await connectAgent(conn, { mode: 'watch', historyLimit: 1 }));
          await cc.request({ type: 'session', state: 'ended', reason, cli });
          cc.close();
          break;
        } catch {
          await sleep(3000);
        }
      }
      exit(0);
    };

    const startedAt = Date.now();
    let lastFind = 0;
    let lastAlive = 0;
    let warnedNoFile = false;
    for (;;) {
      await sleep(1000);
      const l = readLock();
      if (l?.pid && l.pid !== process.pid) exit(0); // 别的监视进程接手了
      // 找会话记录；Codex 没有会话 id 时每 30 秒看一下有没有换成新的会话文件（/new 之类）
      if (!file || (cli === 'codex' && !session && Date.now() - lastFind > 30_000)) {
        lastFind = Date.now();
        const f = findTranscript(cli, { session, cwd });
        if (f && f !== file) {
          const first = !file;
          openFile(f);
          const evs = readNew();
          sender.push(first ? evs.filter((e) => e.kind !== 'think' || e.text).slice(-30) : evs);
          sender.push({ kind: 'sys', text: `已连上 ${cliName} 会话，实时同步思考和执行过程` });
        } else if (!f && !warnedNoFile && Date.now() - startedAt > 60_000) {
          warnedNoFile = true;
          sender.push({ kind: 'sys', text: `没找到 ${cliName} 的会话记录，只能检测会话进程是否退出` });
        }
      }
      if (file) sender.push(readNew());
      if (cliPid && Date.now() - lastAlive > 3000) {
        lastAlive = Date.now();
        if (pidAlive(cliPid) === false) await ended();
      }
    }
  },
};

const waitOnce = (deadline) => commands._waitOnceBody(deadline);
const fn = watchCommands[cmd] || (cmd.startsWith('_') ? null : commands[cmd]);
setClientCmd(cmd);
if (!fn) die(`未知命令：${cmd}\n运行 room help 查看用法`);
fn().catch((e) => die('错误：' + e.message));
