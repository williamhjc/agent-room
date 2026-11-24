import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseMentions } from '../server/store.js';
import { pidAlive } from '../agent/common.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}/ws`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-test-'));
const procs = [];
// 测试可能跑在 Claude Code 里：去掉它的环境变量，并关掉会话监视进程（需要时单独打开）
const childEnv = Object.fromEntries(Object.entries({ ...process.env, HOME: tmp, USERPROFILE: tmp, AGENT_ROOM_NO_WATCH: "1" }).filter(([k]) => !/^(CLAUDE|CODEX)/.test(k)));

function start(args, extraEnv = {}, { capture = false } = {}) {
  const p = spawn(process.execPath, args, {
    env: { ...childEnv, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ADMIN_TOKEN: 'secret', ACK_CHECK_MS: '300', LOST_GRACE_MS: '1500', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.out = '';
  p.stdout.on('data', (d) => (p.out += d));
  p.stderr.on('data', (d) => (capture ? (p.out += d) : process.stderr.write(d)));
  procs.push(p);
  return p;
}
const exited = (p) => new Promise((r) => (p.exitCode !== null ? r(p.exitCode) : p.on('exit', (c) => r(c))));
const api = (p, opts = {}) =>
  fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
    body: opts.body && JSON.stringify(opts.body),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('waitFor timeout');
}
/** 以网页用户身份连接（带 Origin） */
async function userClient(projectId, name = '老板', { origin = BASE } = {}) {
  const ws = new WebSocket(WSURL, origin ? { origin } : {});
  const c = { ws, msgs: [], presence: [], acts: [], closeCode: null };
  ws.on('message', (raw) => {
    const d = JSON.parse(raw);
    if (d.type === 'message') c.msgs.push(d.message);
    if (d.type === 'activity') c.acts.push(...d.events.map((e) => ({ ...e, agent: d.agent })));
    if (d.type === 'welcome') for (const [agent, evs] of Object.entries(d.activity || {})) c.acts.push(...evs.map((e) => ({ ...e, agent })));
    if (d.type === 'presence' || d.type === 'welcome') c.presence = d.presence || d.agents || c.presence;
  });
  ws.on('close', (code) => (c.closeCode = code));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'hello', kind: 'user', projectId, token: 'secret', name }));
  c.say = (text, extra = {}) => ws.send(JSON.stringify({ type: 'message', text, ...extra }));
  return c;
}
async function newProject(agents, extra = {}) {
  const { project } = await api('/api/projects', { method: 'POST', body: { name: 'p', agents, ...extra } });
  return { project, tok: Object.fromEntries(project.agents.map((a) => [a.name, a.token])) };
}
const roomEnv = (project, agent, token) => ({ AGENT_ROOM_SERVER: WSURL, AGENT_ROOM_PROJECT: project.id, AGENT_ROOM_AGENT: agent, AGENT_ROOM_TOKEN: token });

before(async () => {
  start(['server/index.js']);
  await waitFor(() => fetch(BASE + '/healthz').then((r) => r.ok).catch(() => false));
});
after(() => {
  procs.forEach((p) => p.kill());
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseMentions：中文名、最长匹配、@all', () => {
  const agents = [{ name: '前端' }, { name: '前端组长' }, { name: 'bob' }];
  assert.deepEqual(parseMentions('@前端请看下', agents), ['前端']);
  assert.deepEqual(parseMentions('@前端组长 看下', agents), ['前端组长']);
  assert.deepEqual(parseMentions('@bobby hi', agents), []);
  assert.deepEqual(parseMentions('hi @BOB.', agents), ['bob']);
  assert.deepEqual(parseMentions('@all', agents).sort(), ['bob', '前端', '前端组长'].sort());
});

test('未授权访问被拒绝', async () => {
  const r = await fetch(BASE + '/api/projects');
  assert.equal(r.status, 401);
});

test('身份：非浏览器（无 Origin）或与 agent 同名的用户连接被拒绝', async () => {
  const { project } = await newProject([{ name: 'Codex', type: 'codex' }]);
  const noOrigin = await userClient(project.id, '用户', { origin: null });
  await waitFor(() => noOrigin.closeCode);
  assert.equal(noOrigin.closeCode, 4002);
  const fake = await userClient(project.id, 'codex');
  await waitFor(() => fake.closeCode);
  assert.equal(fake.closeCode, 4002);
});

test('端到端：连接器接单回执 + agent 互相 @ 接力不设上限（暂停可止住），无超时误报', async () => {
  const { project, tok } = await newProject(
    [
      { name: 'Alice', type: 'claude', role: '开发' },
      { name: 'Bob', type: 'codex', role: '测试' },
    ],
    { ackTimeoutSec: 5 }
  );
  // 错误 token 被拒绝
  const bad = new WebSocket(WSURL);
  const badClose = new Promise((r) => bad.on('close', (code) => r(code)));
  bad.on('open', () => bad.send(JSON.stringify({ type: 'hello', kind: 'agent', projectId: project.id, agent: 'Alice', token: 'x' })));
  assert.equal(await badClose, 4003);

  const user = await userClient(project.id);
  for (const name of ['Alice', 'Bob']) {
    start(['agent/connector.js', '--server', WSURL, '--project', project.id, '--agent', name, '--token', tok[name], '--workdir', path.join(tmp, 'wd'), '--dry-run']);
  }
  await waitFor(() => user.presence.filter((a) => a.online && a.mode === 'connector').length === 2);

  user.say('@Alice 请实现登录功能，然后交给 @Bob 测试');
  await waitFor(() => user.msgs.find((m) => m.from === 'Alice'));
  const a = user.msgs.find((m) => m.from === 'Alice');
  assert.equal(a.depth, 1);
  assert.ok(a.replyTo);
  await waitFor(() => user.msgs.find((m) => m.from === 'Bob'));
  // 以前的接力上限（12 轮）已移除：dry-run 回显里带着 @对方，会一直接力下去
  await waitFor(() => user.msgs.find((m) => (m.depth || 0) >= 4), 20000);
  await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { paused: true } });
  await waitFor(() => user.msgs.find((m) => m.fromType === 'system' && m.text.includes('暂停')));
  await sleep(6500); // 超过 ackTimeoutSec，确认没有误报
  assert.ok(!user.msgs.find((m) => m.meta?.kind === 'ack-timeout'), '连接器正常工作时不应出现超时提醒');
  await waitFor(() => user.presence.every((x) => x.pending === 0));
  user.ws.close();
});

test('接单超时：派给离线 agent 的消息会在群里提醒，上线接单后提示已接单', async () => {
  const { project, tok } = await newProject([{ name: 'Codex', type: 'codex' }], { ackTimeoutSec: 5 });
  const user = await userClient(project.id);
  user.say('@Codex 帮忙复测一下');
  const warn = await waitFor(() => user.msgs.find((m) => m.meta?.kind === 'ack-timeout'), 12000);
  assert.match(warn.text, /@Codex/);
  assert.match(warn.text, /离线/);
  assert.equal(user.presence.find((x) => x.name === 'Codex').pending, 1);
  // 会话模式上线：room wait 立即拿到积压的消息并确认
  const w = start(['agent/room.js', 'wait', '--timeout', '20'], roomEnv(project, 'Codex', tok.Codex), { capture: true });
  assert.equal(await exited(w), 0, w.out);
  assert.match(w.out, /帮忙复测一下/);
  await waitFor(() => user.msgs.find((m) => m.meta?.kind === 'ack-late'));
  user.ws.close();
});

test('会话模式：room wait 阻塞到被 @，room send 回复带 replyTo 与附件', async () => {
  const { project, tok } = await newProject([
    { name: 'Claude', type: 'claude' },
    { name: 'Codex', type: 'codex' },
  ]);
  const user = await userClient(project.id);
  const env = roomEnv(project, 'Codex', tok.Codex);
  // 先运行一次 wait：没有消息时阻塞
  const w = start(['agent/room.js', 'wait', '--timeout', '30'], env, { capture: true });
  await waitFor(() => user.presence.find((x) => x.name === 'Codex')?.listening);
  await sleep(300);
  assert.equal(w.exitCode, null, 'wait 应该在被 @ 之前保持阻塞');
  user.say('@Claude 先别管这条'); // 不是给 Codex 的
  await sleep(500);
  assert.equal(w.exitCode, null);
  user.say('@Codex 测一下提交 abc123');
  assert.equal(await exited(w), 0, w.out);
  assert.match(w.out, /abc123/);
  assert.match(w.out, /【@你】/);
  const trigger = user.msgs.find((m) => m.text.includes('abc123'));
  await waitFor(() => user.presence.find((x) => x.name === 'Codex')?.status === 'working');

  // inbox：执行中看新消息
  user.say('补充：改测 def456');
  await sleep(300);
  const ib = start(['agent/room.js', 'inbox'], env, { capture: true });
  assert.equal(await exited(ib), 0, ib.out);
  assert.match(ib.out, /def456/);

  // 带附件回复
  const img = path.join(tmp, 'shot.png');
  fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a', 'hex'));
  const s = start(['agent/room.js', 'send', '@Claude def456 通过', '--attach', img, '--done'], env, { capture: true });
  assert.equal(await exited(s), 0, s.out);
  const reply = await waitFor(() => user.msgs.find((m) => m.from === 'Codex'));
  assert.equal(reply.replyTo, trigger.id);
  assert.deepEqual(reply.dispatch, ['Claude']);
  assert.equal(reply.attachments.length, 1);
  assert.equal(reply.attachments[0].type, 'image');
  const file = await fetch(BASE + reply.attachments[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  user.ws.close();
});

test('附件：伪造的附件 URL 会被丢弃，HTML 等类型强制下载', async () => {
  const { project, tok } = await newProject([{ name: 'A', type: 'claude' }]);
  const up = await fetch(`${BASE}/api/projects/${project.id}/uploads?name=x.html`, {
    method: 'POST',
    headers: { Authorization: `Agent ${tok.A}` },
    body: '<script>alert(1)</script>',
  }).then((r) => r.json());
  const r = await fetch(BASE + up.attachment.url);
  assert.match(r.headers.get('content-disposition') || '', /attachment/);
  const noAuth = await fetch(`${BASE}/api/projects/${project.id}/uploads?name=a.png`, { method: 'POST', body: 'x' });
  assert.equal(noAuth.status, 401);
  const user = await userClient(project.id);
  user.say('看图', { attachments: [{ url: 'https://evil.example/x.png', name: 'x' }, up.attachment] });
  const m = await waitFor(() => user.msgs.find((x) => x.text === '看图'));
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].url, up.attachment.url);
  user.ws.close();
});

test('额度识别：解析各家 CLI 的恢复时间', async () => {
  const { detectLimit } = await import('../agent/common.js');
  const now = Date.now();
  const resetSec = Math.floor(now / 1000) + 3 * 3600;
  assert.equal(detectLimit(`Claude AI usage limit reached|${resetSec}`, now).until, resetSec * 1000);
  const inX = detectLimit("You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.", now);
  assert.equal(inX.until - now, ((2 * 24 + 3) * 60 + 5) * 60_000);
  const at = detectLimit("You've hit your usage limit. Upgrade to Pro or try again at 9:41 PM.", now);
  assert.equal(new Date(at.until).getHours(), 21);
  assert.ok(at.until > now && at.until - now <= 86400_000);
  const tz = detectLimit("You've hit your limit · resets 3pm (Asia/Shanghai)", now);
  assert.equal(new Date(tz.until).toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: 'numeric', hour12: false }), '15');
  const ov = detectLimit('API Error: 529 {"type":"overloaded_error"}', now);
  assert.ok(ov.transient && !ov.until);
  assert.equal(detectLimit('Error: ENOENT no such file', now), null);
});

test('额度用完：连接器在群里说明并通知派活的 agent，消息排队，到点自动恢复继续', async () => {
  const { project, tok } = await newProject(
    [
      { name: 'Alice', type: 'claude', role: '开发' },
      { name: 'Bob', type: 'codex', role: '架构' },
    ],
    { ackTimeoutSec: 3 }
  );
  const user = await userClient(project.id);
  start(['agent/connector.js', '--server', WSURL, '--project', project.id, '--agent', 'Alice', '--token', tok.Alice, '--workdir', path.join(tmp, 'wd2'), '--dry-run']);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.online));
  const bobSay = (text) => exited(start(['agent/room.js', 'send', text], roomEnv(project, 'Bob', tok.Bob)));

  assert.equal(await bobSay('@Alice [模拟额度用完:4] 实现登录接口'), 0);
  const q = await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && m.meta?.kind === 'quota'));
  assert.match(q.text, /额度/);
  assert.ok(q.dispatch.includes('Bob'), '应通知派活的 Bob 先做别的');
  assert.ok(q.meta.until > Date.now());
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'quota' && a.until));

  // 额度用完期间再派活：服务端提醒，消息排队并已确认收到
  assert.equal(await bobSay('@Alice 顺便把注册也做了'), 0);
  const note = await waitFor(() => user.msgs.find((m) => m.fromType === 'system' && m.meta?.kind === 'quota'));
  assert.match(note.text, /@Alice/);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.pending === 0));

  // 到点重试成功：先说明已恢复，再处理排队的两条
  const done = await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && /额度已恢复/.test(m.text)), 15000);
  assert.match(done.text, /实现登录接口/);
  assert.match(done.text, /注册/);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'idle'));
  assert.ok(!user.msgs.find((m) => m.meta?.kind === 'ack-timeout' && m.text.includes('@Alice')), '额度等待期间不应报 Alice 超时');
  user.ws.close();
});

test('订阅额度：上报到成员状态；官方恢复时间很远但额度接口显示已恢复时提前重试', async () => {
  const { project, tok } = await newProject([
    { name: 'Alice', type: 'claude', role: '开发' },
    { name: 'Bob', type: 'codex', role: '架构' },
  ]);
  const user = await userClient(project.id);
  const okUsage = JSON.stringify({ plan: 'max20x', planLabel: 'Max 20x', main: 'week', windows: [{ key: '5h', used: 10, windowMin: 300 }, { key: 'week', used: 40, windowMin: 10080, resetsAt: Date.now() + 86400e3 }] });
  start(['agent/connector.js', '--server', WSURL, '--project', project.id, '--agent', 'Alice', '--token', tok.Alice, '--workdir', path.join(tmp, 'wd3'), '--dry-run', '--limit-retry', '0.05'], {
    AGENT_ROOM_FAKE_USAGE: okUsage,
  });
  const alice = await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.online && a.usage));
  assert.equal(alice.usage.planLabel, 'Max 20x');
  assert.equal(alice.usage.main, 'week');
  assert.equal(alice.usage.windows.length, 2);
  assert.equal(alice.usage.limited, false);

  // 碰到额度上限，错误信息说 2 小时后恢复；但额度接口说有余量 → 不干等，几秒内提前重试成功
  user.say('@Alice [模拟额度用完:7200] 实现登录接口');
  await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && m.meta?.kind === 'quota'));
  const done = await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && /额度已恢复/.test(m.text)), 15000);
  assert.match(done.text, /实现登录接口/);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'idle'));

  // 会话模式：room usage 查询并同步到网页（这里用假数据：Pro 周额度用完）
  const fullUsage = JSON.stringify({ plan: 'pro', planLabel: 'Pro', main: 'week', windows: [{ used: 5, windowMin: 300 }, { used: 100, windowMin: 10080, resetsAt: Date.now() + 2 * 86400e3 }] });
  const p = start(['agent/room.js', 'usage'], { ...roomEnv(project, 'Bob', tok.Bob), AGENT_ROOM_FAKE_USAGE: fullUsage });
  assert.equal(await exited(p), 0);
  assert.match(p.out, /Codex 订阅：Pro/);
  assert.match(p.out, /★ 每周：已用 100%/);
  const bob = await waitFor(() => user.presence.find((a) => a.name === 'Bob' && a.usage?.limited));
  assert.ok(bob.usage.resetsAt > Date.now());
  user.ws.close();
});

test('长任务：工位显示正在做什么、定期在群里发进展（不派活）、显示模型；撤回正在处理的消息会停止任务', async () => {
  const { project, tok } = await newProject([
    { name: 'Alice', type: 'claude', role: '开发' },
    { name: 'Bob', type: 'codex', role: '测试' },
  ]);
  const user = await userClient(project.id);
  start(['agent/connector.js', '--server', WSURL, '--project', project.id, '--agent', 'Alice', '--token', tok.Alice, '--workdir', path.join(tmp, 'wd4'), '--dry-run', '--progress-interval', '0.03', '--model', 'claude-test-model']);
  const alice = await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.online && a.info));
  assert.equal(alice.info.model, 'claude-test-model');
  assert.equal(alice.info.source, 'args');

  user.say('@Alice [模拟耗时:4] 重构登录模块，顺便告诉 @Bob 一声');
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'working' && a.workingSince));
  const prog = await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && m.meta?.kind === 'progress'), 8000);
  assert.match(prog.text, /进展/);
  assert.deepEqual(prog.dispatch, [], '进展消息不派活');
  const done = await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && !m.meta), 10000);
  assert.match(done.text, /重构登录模块/);

  // 撤回正在处理的消息：任务停止
  user.say('@Alice [模拟耗时:30] 这条发错了');
  const wrong = await waitFor(() => user.msgs.find((m) => m.text.includes('这条发错了') && m.fromType === 'user'));
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'working'));
  user.ws.send(JSON.stringify({ type: 'recall', id: wrong.id }));
  await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && /已被撤回/.test(m.text)), 8000);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'idle'));
  const all = (await api(`/api/projects/${project.id}/messages`)).messages;
  const r = all.find((m) => m.id === wrong.id);
  assert.ok(r.recalled && r.text === '' && r.dispatch.length === 0, '撤回后内容清空、不再派发');

  // 撤回还没人接单的消息：待接单清零；agent 只能撤回自己的消息
  await sleep(300);
  const before = user.presence.find((a) => a.name === 'Bob').pending;
  user.say('@Bob 跑一下回归测试');
  await waitFor(() => user.presence.find((a) => a.name === 'Bob' && a.pending === before + 1));
  const toBob = await waitFor(() => user.msgs.find((m) => m.text === '@Bob 跑一下回归测试'));
  user.ws.send(JSON.stringify({ type: 'recall', id: toBob.id }));
  await waitFor(() => user.presence.find((a) => a.name === 'Bob' && a.pending === before));
  const bad = start(['agent/room.js', 'recall', done.id], roomEnv(project, 'Bob', tok.Bob), { capture: true });
  assert.notEqual(await exited(bad), 0);
  assert.match(bad.out, /只能撤回自己/);
  user.ws.close();
});

test('会话模式状态：wait 空档不算离线，干活中用 room 命令算工作中，发完言再 wait 才算空闲；room model 上报模型', async () => {
  const { project, tok } = await newProject([{ name: 'Sess', type: 'claude', role: '开发' }]);
  const user = await userClient(project.id);
  const env = roomEnv(project, 'Sess', tok.Sess);
  // wait 超时退出后的空档里仍显示在监听
  assert.equal(await exited(start(['agent/room.js', 'wait', '--timeout', '1'], env)), 3);
  await sleep(300);
  let me = user.presence.find((a) => a.name === 'Sess');
  assert.ok(me.online && me.listening && me.mode === 'session', JSON.stringify(me));
  // 收到任务 → 工作中；中途 inbox / 后台再开 wait 都不打断"工作中"
  const w = start(['agent/room.js', 'wait', '--timeout', '20'], env);
  await waitFor(() => user.presence.find((a) => a.name === 'Sess' && a.status === 'idle' && a.listening));
  user.say('@Sess 修一下首页');
  assert.equal(await exited(w), 0);
  await waitFor(() => user.presence.find((a) => a.name === 'Sess' && a.status === 'working'));
  assert.equal(await exited(start(['agent/room.js', 'inbox'], env)), 0);
  const bg = start(['agent/room.js', 'wait', '--timeout', '3'], env);
  await sleep(800);
  assert.equal(user.presence.find((a) => a.name === 'Sess').status, 'working', '开始干活后还没发言，后台 wait 不应变成空闲');
  await exited(bg);
  // 发完言再 wait → 空闲
  assert.equal(await exited(start(['agent/room.js', 'send', '首页修好了'], env)), 0);
  const w2 = start(['agent/room.js', 'wait', '--timeout', '2'], env);
  await waitFor(() => user.presence.find((a) => a.name === 'Sess' && a.status === 'idle'));
  await exited(w2);
  // 模型
  assert.equal(await exited(start(['agent/room.js', 'model', 'claude-opus-test', '--effort', 'high'], env)), 0);
  me = await waitFor(() => user.presence.find((a) => a.name === 'Sess' && a.info?.model === 'claude-opus-test'));
  assert.equal(me.info.effort, 'high');
  assert.equal(me.info.source, 'self');
  user.ws.close();
});

test('防串项目：token 环境变量被过滤时，不会拿当前目录里别的项目的 .agent-room.json 发消息', async () => {
  const A = await newProject([{ name: 'Codex', type: 'codex' }]);
  const B = await newProject([{ name: 'Codex', type: 'codex' }]);
  const dir = path.join(tmp, 'mix');
  fs.mkdirSync(dir, { recursive: true });
  // 当前目录里放的是 B 项目的连接文件（比如以前在这里 room init 过）
  fs.writeFileSync(path.join(dir, '.agent-room.json'), JSON.stringify({ server: WSURL, project: B.project.id, agent: 'Codex', token: B.tok.Codex }));
  const run = (env) => {
    const p = spawn(process.execPath, [path.resolve('agent/room.js'), 'send', '我是 A 项目的消息'], { cwd: dir, env: { ...childEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.out = '';
    p.stdout.on('data', (d) => (p.out += d));
    p.stderr.on('data', (d) => (p.out += d));
    procs.push(p);
    return p;
  };
  // 连接器给 CLI 的环境：项目是 A，但 TOKEN 被 Codex 过滤掉了
  const p1 = run({ AGENT_ROOM_SERVER: WSURL, AGENT_ROOM_PROJECT: A.project.id, AGENT_ROOM_AGENT: 'Codex' });
  assert.notEqual(await exited(p1), 0);
  assert.match(p1.out, /缺少 @Codex 的 token/);
  // 有 AGENT_ROOM_CONFIG（连接器写的连接文件）时照常发到 A
  const connFile = path.join(tmp, 'a-conn.json');
  fs.writeFileSync(connFile, JSON.stringify({ server: WSURL, project: A.project.id, agent: 'Codex', token: A.tok.Codex }));
  const p2 = run({ AGENT_ROOM_SERVER: WSURL, AGENT_ROOM_PROJECT: A.project.id, AGENT_ROOM_AGENT: 'Codex', AGENT_ROOM_CONFIG: connFile });
  assert.equal(await exited(p2), 0);
  assert.match(p2.out, /已发送到项目/);
  const inA = (await api(`/api/projects/${A.project.id}/messages`)).messages;
  const inB = (await api(`/api/projects/${B.project.id}/messages`)).messages;
  assert.ok(inA.some((m) => m.text === '我是 A 项目的消息'));
  assert.ok(!inB.some((m) => m.text === '我是 A 项目的消息'));
});

test('手机推送：只在给出验收二维码或需要用户确认时推送 Bark，推送地址不外泄给 agent', async () => {
  const http = await import('node:http');
  const got = [];
  const bark = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      got.push({ path: req.url, body: JSON.parse(b) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 200, message: 'success' }));
    });
  });
  await new Promise((r) => bark.listen(0, '127.0.0.1', r));
  const barkUrl = `http://127.0.0.1:${bark.address().port}/KEY123/`;
  const { project, tok } = await newProject([{ name: 'Dev', type: 'claude' }, { name: 'QA', type: 'codex' }, { name: 'PM', type: 'claude' }], { barkUrl });
  assert.equal(project.barkUrl, barkUrl.replace(/\/$/, ''));
  assert.equal(project.barkSound, 'birdsong');

  // 测试推送接口
  const t = await api('/api/bark-test', { method: 'POST', body: { projectId: project.id } });
  assert.ok(t.ok, JSON.stringify(t));
  assert.equal(got.at(-1).path, '/KEY123');

  // agent 的 welcome 里不含推送地址
  const w = start(['agent/room.js', 'who'], roomEnv(project, 'Dev', tok.Dev), { capture: true });
  await exited(w);
  const user = await userClient(project.id);
  await sleep(200);
  const say = (who, ...argv) => exited(start(['agent/room.js', 'send', ...argv], roomEnv(project, who, tok[who])));
  // 普通进度、只写了【待验收】字样的消息都不推送
  const n0 = got.length;
  assert.equal(await say('Dev', '进度：接口写了一半'), 0);
  assert.equal(await say('Dev', '【待验收】@QA 登录接口好了，请测试'), 0);
  assert.equal(await say('Dev', '@用户 同步一下：今天完成了登录'), 0);
  await sleep(500);
  assert.equal(got.length, n0, '普通消息、【待验收】字样、不提问的 @用户 都不推送');
  // ① 需要用户确认（--ask）
  assert.equal(await say('Dev', '--ask', '登录页要不要加验证码？我建议先不加'), 0);
  await waitFor(() => got.length === n0 + 1);
  assert.match(got.at(-1).body.title, /需要你确认/);
  assert.match(got.at(-1).body.body, /@Dev：登录页要不要加验证码/);
  assert.equal(got.at(-1).body.sound, 'birdsong');
  assert.ok(user.msgs.find((m) => m.from === 'Dev' && m.meta?.kind === 'ask'));
  // ② 给出验收二维码链接
  const qr = 'https://tapcode.example.com/qrcode/m_abc_123.png';
  assert.equal(await say('QA', `测试包已上传，扫码验收：
${qr}`), 0);
  await waitFor(() => got.length === n0 + 2);
  assert.match(got.at(-1).body.title, /可以验收了/);
  assert.equal(got.at(-1).body.image, qr);
  assert.ok(!got.at(-1).body.body.includes('http'), '正文里不放长链接');
  assert.ok(user.msgs.find((m) => m.from === 'QA' && m.meta?.kind === 'review' && m.meta.qr === qr));
  // ③ @用户 并提问也算需要确认；同一个二维码被别人转发不重复推送
  assert.equal(await say('PM', `二维码在这：${qr}`), 0);
  assert.equal(await say('PM', '@用户 首页配色用蓝色还是绿色？'), 0);
  await waitFor(() => got.length === n0 + 3);
  await sleep(300);
  assert.equal(got.length, n0 + 3, '转发的同一个二维码不重复推送');
  assert.match(got.at(-1).body.body, /配色/);
  const { normBarkUrl } = await import('../server/store.js');
  assert.equal(normBarkUrl('https://api.day.app/abc/这里改成你自己的推送内容'), 'https://api.day.app/abc');
  user.ws.close();
  bark.close();
});

test('执行过程：连接器把执行过程推到网页；连接器被强制结束后群里提示掉线，重启后提示重新上线并补做', async () => {
  const { project, tok } = await newProject([{ name: 'Alice', type: 'claude', role: '开发' }]);
  const user = await userClient(project.id);
  const argv = ['agent/connector.js', '--server', WSURL, '--project', project.id, '--agent', 'Alice', '--token', tok.Alice, '--workdir', path.join(tmp, 'wd-act'), '--dry-run', '--progress-interval', '0'];
  let conn = start(argv);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.online));
  user.say('@Alice [模拟耗时:3] 修一下登录页');
  await waitFor(() => user.acts.find((e) => e.agent === 'Alice' && e.kind === 'input' && e.text.includes('修一下登录页')));
  assert.ok(user.acts.find((e) => e.agent === 'Alice' && e.kind === 'sys' && /开始处理/.test(e.text)));
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && a.status === 'working'));

  // 进程被系统强制结束（内存不足之类，来不及打招呼）
  conn.kill('SIGKILL');
  const lost = await waitFor(() => user.msgs.find((m) => m.fromType === 'system' && /@Alice 的连接器断开/.test(m.text)), 8000);
  assert.match(lost.text, /任务已中断/);
  await waitFor(() => user.presence.find((a) => a.name === 'Alice' && !a.online && a.lostAt));

  // 后打开的网页也能看到之前的执行过程
  const user2 = await userClient(project.id, '老板2');
  await waitFor(() => user2.acts.some((e) => e.agent === 'Alice' && e.text.includes('修一下登录页')));

  // 重启：群里提示重新上线，没做完的任务自动补做
  conn = start(argv);
  await waitFor(() => user.msgs.find((m) => m.fromType === 'system' && /@Alice 已重新上线/.test(m.text)), 8000);
  await waitFor(() => user.msgs.find((m) => m.from === 'Alice' && /修一下登录页/.test(m.text)), 15000);
  await waitFor(() => user.acts.find((e) => e.agent === 'Alice' && e.kind === 'end'));
  // 掉线只提示一次
  assert.equal(user.msgs.filter((m) => m.fromType === 'system' && /连接器断开/.test(m.text)).length, 1);
  user.ws.close();
  user2.ws.close();
});

test('会话模式：room 自动启动后台监视，会话窗口的思考和执行过程实时同步到网页；CLI 进程退出时群里提示', async () => {
  const { project, tok } = await newProject([{ name: 'Bob', type: 'claude', role: '测试' }]);
  const user = await userClient(project.id);
  // 假的 Claude Code 进程和它的会话记录（~/.claude/projects/<目录>/<会话id>.jsonl）
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  procs.push(fake);
  const sid = `test-session-${Date.now()}`;
  const dir = path.join(tmp, '.claude', 'projects', 'C--fake-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  const line = (o) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\n');
  line({ type: 'user', message: { role: 'user', content: '开始干活' } });
  const env = { ...roomEnv(project, 'Bob', tok.Bob), AGENT_ROOM_NO_WATCH: '', CLAUDECODE: '1', CLAUDE_PID: String(fake.pid), CLAUDE_CODE_SESSION_ID: sid };
  const s = start(['agent/room.js', 'send', '开工了'], env);
  assert.equal(await exited(s), 0);
  await waitFor(() => user.presence.find((a) => a.name === 'Bob' && a.watching && a.mode === 'session'), 15000);
  await waitFor(() => user.acts.find((e) => e.agent === 'Bob' && e.kind === 'input' && e.text === '开始干活'), 8000);

  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '先看看登录页的代码' }] } });
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } });
  line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '14 passing', is_error: false }] } });
  await waitFor(() => user.acts.find((e) => e.agent === 'Bob' && e.kind === 'out' && e.text === '14 passing'));
  assert.ok(user.acts.find((e) => e.agent === 'Bob' && e.kind === 'think' && e.text === '先看看登录页的代码'));
  assert.ok(user.acts.find((e) => e.agent === 'Bob' && e.kind === 'tool' && e.text === '运行 npm test'));
  await waitFor(() => user.presence.find((a) => a.name === 'Bob' && a.status === 'working'));

  // 一轮结束、停在终端等输入：在线，但不算工作中，也没在监听
  line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '改好了' }] } });
  await waitFor(() => user.presence.find((a) => a.name === 'Bob' && a.online && a.status === 'idle' && !a.listening));

  // 再跑一次 room 命令不会重复起监视进程
  const lock = JSON.parse(fs.readFileSync(path.join(tmp, '.agent-room', 'state', `${project.id}-Bob.watch.json`), 'utf8'));
  const s2 = start(['agent/room.js', 'send', '再说一句'], env);
  assert.equal(await exited(s2), 0);
  await sleep(1500);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, '.agent-room', 'state', `${project.id}-Bob.watch.json`), 'utf8')).pid, lock.pid);

  // CLI 进程被关掉 / 被系统结束：群里提示，工位显示会话已关闭
  fake.kill();
  const msg = await waitFor(() => user.msgs.find((m) => m.fromType === 'system' && /@Bob 的会话窗口已关闭/.test(m.text)), 15000);
  assert.match(msg.text, /进程（pid \d+）已退出/);
  const bob = await waitFor(() => user.presence.find((a) => a.name === 'Bob' && !a.online && a.ended));
  assert.match(bob.ended.reason, /已退出/);
  await waitFor(() => !pidAlive(lock.pid), 8000); // 监视进程随之退出
  user.ws.close();
});

test('执行过程解析：Codex 会话记录 / exec --json', async () => {
  const { makeCodexActivity } = await import('../agent/common.js');
  const conv = makeCodexActivity();
  const evs = [
    { type: 'event_msg', payload: { type: 'user_message', message: '修 bug' } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: '先跑测试' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm test'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify({ output: '1 failing', metadata: { exit_code: 1 } }) } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '修好了' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a.txt' } },
  ].flatMap(conv);
  assert.deepEqual(
    evs.map((e) => [e.kind, e.text]),
    [
      ['input', '修 bug'],
      ['think', '先跑测试'],
      ['tool', '运行 npm test'],
      ['err', '退出码 1\n1 failing'],
      ['say', '修好了'],
      ['end', '本轮结束'],
      ['tool', '运行 ls'],
      ['out', '退出码 0\na.txt'],
    ]
  );
});
