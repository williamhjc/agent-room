import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { parseMentions } from '../server/store.js';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const WSURL = `ws://127.0.0.1:${PORT}/ws`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-test-'));
const procs = [];
const childEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp };

function start(args, extraEnv = {}, { capture = false } = {}) {
  const p = spawn(process.execPath, args, {
    env: { ...childEnv, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ADMIN_TOKEN: 'secret', ACK_CHECK_MS: '300', ...extraEnv },
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
  const c = { ws, msgs: [], presence: [], closeCode: null };
  ws.on('message', (raw) => {
    const d = JSON.parse(raw);
    if (d.type === 'message') c.msgs.push(d.message);
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

test('端到端：连接器接单回执 + agent 互相 @ 接力并受上限保护，无超时误报', async () => {
  const { project, tok } = await newProject(
    [
      { name: 'Alice', type: 'claude', role: '开发' },
      { name: 'Bob', type: 'codex', role: '测试' },
    ],
    { maxHops: 3, ackTimeoutSec: 5 }
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
  await waitFor(() => user.msgs.find((m) => m.fromType === 'system' && m.text.includes('接力上限')), 15000);
  assert.ok(user.msgs.every((m) => (m.depth || 0) <= 3));
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

test('验收通知：agent 发出【待验收】时推送 Bark，推送地址不外泄给 agent', async () => {
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
  const { project, tok } = await newProject([{ name: 'Dev', type: 'claude' }], { barkUrl });
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
  // 普通消息不推送；--review 推送
  const n0 = got.length;
  assert.equal(await exited(start(['agent/room.js', 'send', '进度：接口写了一半'], roomEnv(project, 'Dev', tok.Dev))), 0);
  assert.equal(await exited(start(['agent/room.js', 'send', '--review', '登录功能已完成，打开 /login 用 test/test 登录'], roomEnv(project, 'Dev', tok.Dev))), 0);
  await waitFor(() => got.length > n0);
  await sleep(300);
  assert.equal(got.length, n0 + 1, '只有待验收消息会推送');
  const push = got.at(-1).body;
  assert.match(push.title, /待验收/);
  assert.match(push.body, /@Dev：登录功能已完成/);
  assert.equal(push.sound, 'birdsong');
  const msg = user.msgs.find((m) => m.meta?.kind === 'review');
  assert.ok(msg && msg.text.startsWith('【待验收】'));
  const { normBarkUrl } = await import('../server/store.js');
  assert.equal(normBarkUrl('https://api.day.app/abc/这里改成你自己的推送内容'), 'https://api.day.app/abc');
  user.ws.close();
  bark.close();
});
