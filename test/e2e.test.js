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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-test-'));
const procs = [];

function start(args, extraEnv = {}) {
  const p = spawn(process.execPath, args, {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ADMIN_TOKEN: 'secret', HOME: tmp, USERPROFILE: tmp, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', (d) => process.stderr.write(d));
  procs.push(p);
  return p;
}
const api = (p, opts = {}) =>
  fetch(BASE + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
    body: opts.body && JSON.stringify(opts.body),
  }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('waitFor timeout');
}

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

test('端到端：用户 @agent → agent 回复 → agent 互相 @ 接力并受上限保护', async () => {
  const { project } = await api('/api/projects', {
    method: 'POST',
    body: {
      name: '测试项目',
      maxHops: 3,
      agents: [
        { name: 'Alice', type: 'claude', role: '开发' },
        { name: 'Bob', type: 'codex', role: '测试' },
      ],
    },
  });
  assert.ok(project.id);
  const tok = Object.fromEntries(project.agents.map((a) => [a.name, a.token]));

  // 错误 token 被拒绝
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const badClose = new Promise((r) => bad.on('close', (code) => r(code)));
  bad.on('open', () => bad.send(JSON.stringify({ type: 'hello', kind: 'agent', projectId: project.id, agent: 'Alice', token: 'x' })));
  assert.equal(await badClose, 4003);

  // 用户连接
  const user = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const msgs = [];
  let presence = [];
  user.on('message', (raw) => {
    const d = JSON.parse(raw);
    if (d.type === 'message') msgs.push(d.message);
    if (d.type === 'presence') presence = d.agents;
  });
  await new Promise((r) => user.on('open', r));
  user.send(JSON.stringify({ type: 'hello', kind: 'user', projectId: project.id, token: 'secret', name: '老板' }));

  // 两个 dry-run 连接器
  for (const name of ['Alice', 'Bob']) {
    start(['agent/connector.js', '--server', `ws://127.0.0.1:${PORT}/ws`, '--project', project.id, '--agent', name, '--token', tok[name], '--workdir', path.join(tmp, 'wd'), '--dry-run']);
  }
  await waitFor(() => presence.filter((a) => a.online).length === 2);

  // 用户 @Alice，dry-run 回显中包含「@Bob」→ Bob 被触发 → Bob 回显里含 @Alice … 直到上限
  user.send(JSON.stringify({ type: 'message', text: '@Alice 请实现登录功能，然后交给 @Bob 测试' }));
  await waitFor(() => msgs.find((m) => m.from === 'Alice'));
  const a = msgs.find((m) => m.from === 'Alice');
  assert.equal(a.fromType, 'agent');
  assert.equal(a.depth, 1);
  assert.ok(a.replyTo);
  // 用户消息同时 @ 了两人，Bob 也会直接被触发
  await waitFor(() => msgs.find((m) => m.from === 'Bob'));
  // 接力上限：最终应出现系统提示，且没有 depth > maxHops 的消息
  await waitFor(() => msgs.find((m) => m.fromType === 'system' && m.text.includes('接力上限')), 15000);
  assert.ok(msgs.every((m) => (m.depth || 0) <= 3));

  // 持久化：REST 拉取历史
  const { messages } = await api(`/api/projects/${project.id}/messages`);
  assert.ok(messages.length >= msgs.length);
  user.close();
});
