// 简单的文件持久化：projects.json + 每个项目一个 messages/<id>.jsonl
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const AGENT_TYPES = ['claude', 'codex'];
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

export function newId(len = 10) {
  return crypto.randomBytes(16).toString('base64url').slice(0, len);
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.msgDir = path.join(dataDir, 'messages');
    fs.mkdirSync(this.msgDir, { recursive: true });
    this.projectsFile = path.join(dataDir, 'projects.json');
    this.projects = new Map();
    this.messages = new Map(); // projectId -> array（内存缓存）
    if (fs.existsSync(this.projectsFile)) {
      const list = JSON.parse(fs.readFileSync(this.projectsFile, 'utf8'));
      for (const p of list) this.projects.set(p.id, p);
    }
  }

  saveProjects() {
    const tmp = this.projectsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.projects.values()], null, 2));
    fs.renameSync(tmp, this.projectsFile);
  }

  listProjects() {
    return [...this.projects.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  getProject(id) {
    return this.projects.get(id) || null;
  }

  validateAgents(agents) {
    if (!Array.isArray(agents) || agents.length === 0) throw new Error('至少需要定义一个 agent');
    const seen = new Set();
    return agents.map((a) => {
      const name = String(a.name || '').trim();
      if (!NAME_RE.test(name)) throw new Error(`agent 名称不合法：「${name}」（1-32 位字母/数字/中文/_/-，不能有空格）`);
      const key = name.toLowerCase();
      if (key === 'all' || key === 'user' || key === 'system') throw new Error(`agent 名称「${name}」是保留字`);
      if (seen.has(key)) throw new Error(`agent 名称重复：${name}`);
      seen.add(key);
      const type = AGENT_TYPES.includes(a.type) ? a.type : 'claude';
      return {
        name,
        type,
        role: String(a.role || '').trim().slice(0, 4000),
        token: a.token || newId(24),
      };
    });
  }

  createProject({ name, description, workdir, agents, maxHops, ackTimeoutSec, barkUrl, barkSound }) {
    name = String(name || '').trim();
    if (!name) throw new Error('项目名称不能为空');
    const project = {
      id: newId(8),
      name: name.slice(0, 80),
      description: String(description || '').trim().slice(0, 4000),
      workdir: String(workdir || '').trim(),
      maxHops: clampInt(maxHops, 1, 100, 12),
      ackTimeoutSec: clampInt(ackTimeoutSec, 5, 3600, 60),
      paused: false,
      barkUrl: normBarkUrl(barkUrl),
      barkSound: normSound(barkSound),
      agents: this.validateAgents(agents),
      createdAt: Date.now(),
    };
    this.projects.set(project.id, project);
    this.saveProjects();
    return project;
  }

  updateProject(id, patch) {
    const p = this.getProject(id);
    if (!p) throw new Error('项目不存在');
    if (patch.name !== undefined) p.name = String(patch.name).trim().slice(0, 80) || p.name;
    if (patch.description !== undefined) p.description = String(patch.description).slice(0, 4000);
    if (patch.workdir !== undefined) p.workdir = String(patch.workdir).trim();
    if (patch.maxHops !== undefined) p.maxHops = clampInt(patch.maxHops, 1, 100, p.maxHops);
    if (patch.ackTimeoutSec !== undefined) p.ackTimeoutSec = clampInt(patch.ackTimeoutSec, 5, 3600, p.ackTimeoutSec ?? 60);
    if (patch.paused !== undefined) p.paused = !!patch.paused;
    if (patch.barkUrl !== undefined) p.barkUrl = normBarkUrl(patch.barkUrl);
    if (patch.barkSound !== undefined) p.barkSound = normSound(patch.barkSound);
    if (patch.agents !== undefined) {
      // 保留已有 agent 的 token
      const old = new Map(p.agents.map((a) => [a.name.toLowerCase(), a.token]));
      p.agents = this.validateAgents(
        patch.agents.map((a) => ({ ...a, token: old.get(String(a.name || '').trim().toLowerCase()) }))
      );
    }
    this.saveProjects();
    return p;
  }

  deleteProject(id) {
    this.projects.delete(id);
    this.messages.delete(id);
    this.saveProjects();
    fs.rmSync(this.msgFile(id), { force: true });
    fs.rmSync(this.uploadDir(id), { recursive: true, force: true });
  }

  uploadDir(id) {
    return path.join(this.dataDir, 'uploads', id);
  }

  msgFile(id) {
    return path.join(this.msgDir, `${id}.jsonl`);
  }

  getMessages(id) {
    if (!this.messages.has(id)) {
      const f = this.msgFile(id);
      const arr = fs.existsSync(f)
        ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      this.messages.set(id, arr);
    }
    return this.messages.get(id);
  }

  addMessage(projectId, msg) {
    this.getMessages(projectId).push(msg);
    fs.appendFileSync(this.msgFile(projectId), JSON.stringify(msg) + '\n');
    return msg;
  }
}

/** Bark 推送地址：https://api.day.app/<key>（粘贴了带示例内容的完整链接也只取 key 部分） */
export function normBarkUrl(v) {
  v = String(v || '').trim();
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new Error('Bark 推送地址格式不对，应类似 https://api.day.app/你的key');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Bark 推送地址必须是 http(s) 链接');
  const segs = u.pathname.split('/').filter(Boolean);
  if (u.hostname === 'api.day.app') {
    if (!segs.length) throw new Error('Bark 推送地址缺少 key');
    return `${u.origin}/${segs[0]}`;
  }
  return `${u.origin}/${segs.join('/')}`.replace(/\/$/, '');
}
function normSound(v) {
  return String(v || 'birdsong').trim().replace(/[^\w.-]/g, '').slice(0, 40) || 'birdsong';
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 从文本中解析 @提及，返回命中的 agent 名称（规范大小写），@all 展开为全部 */
export function parseMentions(text, agents) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  // 名称按长度降序，优先匹配最长的名字；中文名后面可以直接接文字
  const cands = [
    ...agents.map((a) => ({ key: a.name.toLowerCase(), names: [a.name] })),
    { key: 'all', names: agents.map((a) => a.name) },
    { key: '所有人', names: agents.map((a) => a.name) },
  ].sort((a, b) => b.key.length - a.key.length);
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    const rest = lower.slice(i + 1);
    for (const c of cands) {
      if (!rest.startsWith(c.key)) continue;
      const next = rest[c.key.length];
      const lastIsAscii = /[a-z0-9_-]/.test(c.key[c.key.length - 1]);
      if (lastIsAscii && next && /[a-z0-9_-]/.test(next)) continue; // @bob 不应匹配 @bobby
      c.names.forEach((n) => out.add(n));
      break;
    }
  }
  return [...out];
}
