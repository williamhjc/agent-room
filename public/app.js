// Agent Room 网页端
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ls = {
  get: (k, d = '') => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const S = {
  token: ls.get('ar_token'),
  userName: ls.get('ar_user', '用户'),
  projects: [],
  current: null, // 完整项目（含 token）
  presence: [],
  messages: [],
  hasMore: false,
  ws: null,
  wsProject: null,
  editing: null,
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.token}`, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin();
    throw new Error(data.error || '未授权');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- 登录 ----------
function showLogin() {
  const d = $('#loginDialog');
  if (!d.open) d.showModal();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  S.token = $('#loginToken').value.trim();
  try {
    await api('/api/projects');
    ls.set('ar_token', S.token);
    $('#loginDialog').close();
    boot();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

// ---------- 项目列表 ----------
async function loadProjects() {
  const { projects } = await api('/api/projects');
  S.projects = projects;
  renderProjectList();
}
function renderProjectList() {
  const cur = S.current?.id;
  $('#projectList').innerHTML =
    S.projects
      .map(
        (p) => `<a class="project-item ${p.id === cur ? 'active' : ''}" href="#/p/${p.id}">
        <span class="pname">${esc(p.name)}</span>
        <span class="badge" title="在线 agent / 总数">${p.online}/${p.agents.length}</span></a>`
      )
      .join('') || '<div class="muted small" style="padding:8px 10px">暂无项目</div>';
}

// ---------- 路由 ----------
async function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  $('#sidebar').classList.remove('open');
  if (!m) return showEmpty();
  await openProject(m[1]);
}
function showEmpty() {
  S.current = null;
  closeWs();
  $('#emptyState').classList.remove('hidden');
  for (const id of ['#chatHead', '#messages', '#composer', '#members', '#workingBar']) $(id).classList.add('hidden');
  $('#app').classList.add('no-members');
  renderProjectList();
}
async function openProject(id) {
  try {
    const { project, presence } = await api(`/api/projects/${id}`);
    S.current = project;
    S.presence = presence;
  } catch (e) {
    toast(e.message);
    location.hash = '';
    return;
  }
  $('#emptyState').classList.add('hidden');
  for (const s of ['#chatHead', '#messages', '#composer', '#members']) $(s).classList.remove('hidden');
  $('#app').classList.remove('no-members');
  renderHeader();
  renderMembers();
  renderChips();
  renderProjectList();
  if (S.wsProject !== id) {
    S.messages = [];
    $('#messages').innerHTML = '';
    connectWs(id);
  }
  $('#input').focus();
}

function renderHeader() {
  const p = S.current;
  $('#projTitle').textContent = p.name;
  $('#projSub').textContent = p.description || `${p.agents.length} 个 agent · 接力上限 ${p.maxHops} 轮`;
  $('#btnPause').textContent = p.paused ? '▶ 恢复' : '⏸ 暂停';
  $('#btnPause').title = p.paused ? '恢复后 @ 才会触发 agent' : '暂停后所有 @ 都不会触发 agent';
}

// ---------- WebSocket ----------
let retry = 0;
function closeWs() {
  if (S.ws) {
    S.ws.onclose = null;
    S.ws.close();
  }
  S.ws = null;
  S.wsProject = null;
}
function connectWs(id) {
  closeWs();
  S.wsProject = id;
  setConn('连接中…', '');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify({ type: 'hello', kind: 'user', projectId: id, token: S.token, name: S.userName }));
  };
  ws.onmessage = (ev) => onWs(JSON.parse(ev.data));
  ws.onclose = (ev) => {
    if (S.ws !== ws) return;
    setConn('已断开，重连中…', 'bad');
    if (ev.code === 4004) return toast('项目不存在或已删除');
    if (ev.code === 4001) return showLogin();
    setTimeout(() => S.wsProject === id && connectWs(id), Math.min(1000 * 2 ** retry++, 15000));
  };
}
function setConn(text, cls) {
  const el = $('#connState');
  el.textContent = text;
  el.className = `conn ${cls}`;
}
function onWs(d) {
  switch (d.type) {
    case 'welcome':
      setConn('实时', 'ok');
      S.messages = d.history;
      S.hasMore = d.hasMore;
      S.presence = d.presence;
      renderMessages(true);
      renderMembers();
      renderWorking();
      break;
    case 'message': {
      const atBottom = isAtBottom();
      S.messages.push(d.message);
      appendMessage(d.message);
      if (atBottom || d.message.fromType === 'user') scrollBottom();
      break;
    }
    case 'presence':
      S.presence = d.agents;
      renderMembers();
      renderWorking();
      const p = S.projects.find((x) => x.id === S.current?.id);
      if (p) {
        p.online = d.agents.filter((a) => a.online).length;
        renderProjectList();
      }
      break;
    case 'project':
      // agent 列表等变化：重新拉取完整项目（含 token）
      api(`/api/projects/${S.current.id}`).then(({ project }) => {
        S.current = project;
        renderHeader();
        renderMembers();
        renderChips();
      });
      break;
    case 'error':
      toast(d.error);
      break;
  }
}

// ---------- 消息渲染 ----------
function agentType(name) {
  return S.current?.agents.find((a) => a.name === name)?.type || 'claude';
}
function renderMarkdown(text, mentions = []) {
  // 先提取代码块，再转义，再做行内格式
  const blocks = [];
  let src = String(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  src = esc(src);
  const inline = (s) => {
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    const names = [...(S.current?.agents.map((a) => a.name) || []), 'all', '所有人'].sort((a, b) => b.length - a.length);
    if (names.length) {
      const re = new RegExp('@(' + names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
      s = s.replace(re, '<span class="mention">@$1</span>');
    }
    return s;
  };
  const lines = src.split('\n');
  let html = '';
  let list = null;
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  let para = [];
  const flush = () => {
    if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`;
    para = [];
  };
  for (const line of lines) {
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) {
      flush();
      closeList();
      html += blocks[+line.trim().slice(1, -1)];
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      flush();
      if (list !== 'ul') {
        closeList();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flush();
      if (list !== 'ol') {
        closeList();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^#{1,4}\s+(.*)/))) {
      flush();
      closeList();
      html += `<h4>${inline(m[1])}</h4>`;
    } else if (!line.trim()) {
      flush();
      closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flush();
  closeList();
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

function messageEl(m) {
  const el = document.createElement('div');
  if (m.fromType === 'system') {
    el.className = 'msg system';
    el.innerHTML = `<div class="sys">${esc(m.text)}</div>`;
    return el;
  }
  const isMe = m.fromType === 'user';
  const type = isMe ? 'user' : agentType(m.from);
  const t = new Date(m.ts);
  const time = t.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parent = m.replyTo && S.messages.find((x) => x.id === m.replyTo);
  el.className = `msg ${isMe ? 'me' : ''}`;
  el.innerHTML = `
    <div class="avatar ${type}" title="${esc(m.from)}">${esc([...m.from][0] || '?')}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="who">${esc(m.from)}</span>
        ${isMe ? '' : `<span class="tag ${type}">${type === 'codex' ? 'Codex' : 'Claude'}</span>`}
        <span>${time}</span>
      </div>
      ${parent ? `<div class="reply-ref">↪ 回复 ${esc(parent.from)}：${esc(parent.text.slice(0, 40))}${parent.text.length > 40 ? '…' : ''}</div>` : ''}
      <div class="bubble">${renderMarkdown(m.text, m.mentions)}</div>
    </div>`;
  const bubble = el.querySelector('.bubble');
  if (m.text.length > 1200 || m.text.split('\n').length > 18) {
    bubble.classList.add('collapsed');
    const b = document.createElement('button');
    b.className = 'expand';
    b.textContent = '展开全文';
    b.onclick = () => {
      const c = bubble.classList.toggle('collapsed');
      b.textContent = c ? '展开全文' : '收起';
    };
    el.querySelector('.msg-body').appendChild(b);
  }
  return el;
}
function renderMessages(toBottom) {
  const box = $('#messages');
  box.innerHTML = '';
  if (S.hasMore) {
    const b = document.createElement('button');
    b.className = 'btn sm load-more';
    b.textContent = '加载更早的消息';
    b.onclick = loadMore;
    box.appendChild(b);
  }
  const frag = document.createDocumentFragment();
  for (const m of S.messages) frag.appendChild(messageEl(m));
  box.appendChild(frag);
  if (toBottom) scrollBottom();
}
function appendMessage(m) {
  $('#messages').appendChild(messageEl(m));
}
async function loadMore() {
  const first = S.messages[0];
  if (!first) return;
  const box = $('#messages');
  const h = box.scrollHeight;
  const { messages, hasMore } = await api(`/api/projects/${S.current.id}/messages?before=${first.id}&limit=200`);
  S.messages = [...messages, ...S.messages];
  S.hasMore = hasMore;
  renderMessages(false);
  box.scrollTop = box.scrollHeight - h;
}
function isAtBottom() {
  const b = $('#messages');
  return b.scrollHeight - b.scrollTop - b.clientHeight < 80;
}
function scrollBottom() {
  const b = $('#messages');
  requestAnimationFrame(() => (b.scrollTop = b.scrollHeight));
}

function renderWorking() {
  const w = S.presence.filter((a) => a.status === 'working');
  const bar = $('#workingBar');
  bar.classList.toggle('hidden', !w.length);
  bar.innerHTML = w
    .map((a) => `<span class="w"><span class="dots"><i></i><i></i><i></i></span>@${esc(a.name)} 正在工作${a.note ? `（${esc(a.note)}）` : ''}</span>`)
    .join('');
}

// ---------- 成员面板 ----------
const STATUS_TEXT = { offline: '离线', idle: '在线 · 空闲', working: '工作中', error: '出错' };
function renderMembers() {
  const p = S.current;
  if (!p) return;
  const pres = new Map(S.presence.map((a) => [a.name, a]));
  $('#memberList').innerHTML = p.agents
    .map((a) => {
      const st = pres.get(a.name) || { status: 'offline' };
      return `<div class="member">
        <div class="member-top">
          <div class="avatar ${a.type}">${esc([...a.name][0])}<span class="status-dot ${st.status}"></span></div>
          <div style="flex:1;min-width:0">
            <div class="member-name">@${esc(a.name)} <span class="tag ${a.type}">${a.type === 'codex' ? 'Codex' : 'Claude'}</span></div>
            <div class="member-status">${STATUS_TEXT[st.status] || st.status}${st.host ? ` · ${esc(st.host)}` : ''}${st.note && st.status !== 'idle' ? ` · ${esc(st.note)}` : ''}</div>
          </div>
        </div>
        <div class="member-role">${esc(a.role || '（未定义分工）')}</div>
        <div class="member-actions">
          <button class="btn xs" data-act="at" data-name="${esc(a.name)}">@他</button>
          <button class="btn xs" data-act="connect" data-name="${esc(a.name)}">连接命令</button>
          ${st.status === 'working' ? `<button class="btn xs danger-text" data-act="cancel" data-name="${esc(a.name)}">中止</button>` : ''}
          ${st.online ? `<button class="btn xs" data-act="reset" data-name="${esc(a.name)}" title="清空该 agent 的 CLI 会话上下文">重置会话</button>` : ''}
        </div>
      </div>`;
    })
    .join('');
}
$('#memberList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const name = b.dataset.name;
  if (b.dataset.act === 'at') insertMention(name);
  if (b.dataset.act === 'connect') showConnect(name);
  if (b.dataset.act === 'cancel' || b.dataset.act === 'reset') {
    if (b.dataset.act === 'reset' && !confirm(`确定重置 @${name} 的会话上下文吗？`)) return;
    S.ws?.send(JSON.stringify({ type: 'control', agent: name, action: b.dataset.act }));
    toast('指令已发送');
  }
});

function renderChips() {
  const names = S.current.agents.map((a) => a.name);
  $('#mentionChips').innerHTML = [...names, 'all']
    .map((n) => `<button class="chip" data-name="${esc(n)}">@${esc(n === 'all' ? 'all 所有人' : n)}</button>`)
    .join('');
}
$('#mentionChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (b) insertMention(b.dataset.name);
});

// ---------- 连接命令 ----------
let connOs = 'unix';
let connAgent = null;
function connectCmd(a, os) {
  const p = S.current;
  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const wd = p.workdir || (os === 'ps' ? 'D:\\path\\to\\project' : '/path/to/project');
  const q = (s) => (os === 'ps' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  const nl = os === 'ps' ? ' `\n  ' : ' \\\n  ';
  return (
    `node agent/connector.js` +
    `${nl}--server ${wsUrl}` +
    `${nl}--project ${p.id}` +
    `${nl}--agent ${q(a.name)}` +
    `${nl}--token ${a.token}` +
    `${nl}--workdir ${q(wd)}`
  );
}
function showConnect(name) {
  connAgent = S.current.agents.find((a) => a.name === name);
  $('#connTitle').textContent = `连接 @${name}`;
  $('#connCli').textContent = connAgent.type === 'codex' ? 'codex' : 'claude';
  renderConnCmd();
  $('#connectDialog').showModal();
}
function renderConnCmd() {
  $('#connCmd').textContent = connectCmd(connAgent, connOs);
  document.querySelectorAll('#connTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.os === connOs));
}
$('#connTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  connOs = t.dataset.os;
  renderConnCmd();
});
$('#btnCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('#connCmd').textContent);
    toast('已复制');
  } catch {
    toast('复制失败，请手动选择');
  }
};
$('#btnConnClose').onclick = () => $('#connectDialog').close();

// ---------- 输入框 & @ 补全 ----------
const input = $('#input');
let pop = { open: false, items: [], idx: 0, start: 0 };
function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
function insertMention(name) {
  const v = input.value;
  const pos = input.selectionStart ?? v.length;
  const before = v.slice(0, pos);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const ins = `${pre}@${name} `;
  input.value = before + ins + v.slice(pos);
  input.focus();
  input.selectionStart = input.selectionEnd = pos + ins.length;
  autosize();
}
function updatePop() {
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos);
  const m = before.match(/@([\p{L}\p{N}_-]*)$/u);
  if (!m || !S.current) return closePop();
  const q = m[1].toLowerCase();
  const all = [
    ...S.current.agents.map((a) => ({ name: a.name, type: a.type, role: a.role })),
    { name: 'all', type: 'user', role: '所有 agent' },
  ];
  pop.items = all.filter((a) => a.name.toLowerCase().includes(q));
  if (!pop.items.length) return closePop();
  pop.start = pos - m[0].length;
  pop.idx = Math.min(pop.idx, pop.items.length - 1);
  pop.open = true;
  const el = $('#mentionPop');
  el.innerHTML = pop.items
    .map(
      (a, i) =>
        `<div class="opt ${i === pop.idx ? 'active' : ''}" data-i="${i}"><span class="avatar ${a.type}" style="width:22px;height:22px;font-size:11px;border-radius:6px">${esc([...a.name][0])}</span><b>@${esc(a.name)}</b><span class="r">${esc((a.role || '').split('\n')[0])}</span></div>`
    )
    .join('');
  el.classList.remove('hidden');
}
function closePop() {
  pop.open = false;
  pop.idx = 0;
  $('#mentionPop').classList.add('hidden');
}
function pickPop(i) {
  const a = pop.items[i];
  const pos = input.selectionStart;
  const v = input.value;
  const ins = `@${a.name} `;
  input.value = v.slice(0, pop.start) + ins + v.slice(pos);
  input.selectionStart = input.selectionEnd = pop.start + ins.length;
  closePop();
  input.focus();
}
$('#mentionPop').addEventListener('mousedown', (e) => {
  const o = e.target.closest('.opt');
  if (o) {
    e.preventDefault();
    pickPop(+o.dataset.i);
  }
});
input.addEventListener('input', () => {
  autosize();
  updatePop();
});
input.addEventListener('click', updatePop);
input.addEventListener('blur', () => setTimeout(closePop, 100));
input.addEventListener('keydown', (e) => {
  if (pop.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pop.idx = (pop.idx + (e.key === 'ArrowDown' ? 1 : -1) + pop.items.length) % pop.items.length;
      return updatePop();
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      return pickPop(pop.idx);
    }
    if (e.key === 'Escape') return closePop();
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMsg();
  }
});
$('#btnSend').onclick = sendMsg;
function sendMsg() {
  const text = input.value.trim();
  if (!text) return;
  if (!S.ws || S.ws.readyState !== 1) return toast('未连接到服务器');
  S.ws.send(JSON.stringify({ type: 'message', text }));
  input.value = '';
  autosize();
}

// ---------- 昵称 ----------
$('#userName').value = S.userName;
$('#userName').addEventListener('change', () => {
  S.userName = $('#userName').value.trim() || '用户';
  $('#userName').value = S.userName;
  ls.set('ar_user', S.userName);
  if (S.current) connectWs(S.current.id); // 重新握手以使用新昵称
});

// ---------- 新建 / 编辑项目 ----------
const PRESETS = {
  fullstack: [
    { name: '架构师', type: 'claude', role: '负责需求拆解、技术方案与接口设计，把任务分派给 @前端 和 @后端，并在完成后安排 @测试 验收。不亲自写大量业务代码。' },
    { name: '后端', type: 'codex', role: '负责服务端 API、数据库与业务逻辑实现，按架构师给出的接口约定开发，完成后通知 @前端 联调。' },
    { name: '前端', type: 'claude', role: '负责页面与交互实现，对接后端接口，完成后通知 @测试。' },
    { name: '测试', type: 'codex', role: '负责编写并运行测试、复现与定位缺陷，发现问题 @对应开发者 并附上复现步骤。' },
  ],
  review: [
    { name: 'Dev', type: 'codex', role: '负责编码实现，每完成一个功能点 @Reviewer 请求代码评审，并根据评审意见修改。' },
    { name: 'Reviewer', type: 'claude', role: '负责代码评审：检查正确性、安全性、可维护性。有问题 @Dev 给出具体修改建议；通过则向用户汇报。' },
  ],
  solo: [
    { name: 'Claude', type: 'claude', role: '主程，负责设计与核心实现，必要时把独立子任务交给 @Codex。' },
    { name: 'Codex', type: 'codex', role: '协作开发，完成 @Claude 分派的子任务并汇报结果。' },
  ],
};
function roleRow(a = { name: '', type: 'claude', role: '' }) {
  const row = document.createElement('div');
  row.className = 'role-row';
  row.innerHTML = `
    <input class="input" name="rname" placeholder="名称（用于 @）" maxlength="32" value="${esc(a.name)}" required />
    <select class="input" name="rtype">
      <option value="claude" ${a.type === 'claude' ? 'selected' : ''}>Claude Code</option>
      <option value="codex" ${a.type === 'codex' ? 'selected' : ''}>Codex</option>
    </select>
    <textarea class="input" name="rrole" rows="2" placeholder="分工角色 / 职责 / 协作方式">${esc(a.role)}</textarea>
    <button type="button" class="icon-btn" title="移除">✕</button>`;
  row.querySelector('button').onclick = () => row.remove();
  return row;
}
function setRoles(list) {
  const box = $('#rolesEditor');
  box.innerHTML = '';
  list.forEach((a) => box.appendChild(roleRow(a)));
}
function openProjectDialog(project) {
  S.editing = project || null;
  const f = $('#projectForm');
  f.reset();
  $('#formError').textContent = '';
  $('#dlgTitle').textContent = project ? '编辑项目' : '新建项目';
  $('#btnSave').textContent = project ? '保存' : '创建';
  f.name.value = project?.name || '';
  f.description.value = project?.description || '';
  f.workdir.value = project?.workdir || '';
  f.maxHops.value = project?.maxHops || 12;
  setRoles(project ? project.agents : PRESETS.fullstack);
  $('#projectDialog').showModal();
  f.name.focus();
}
document.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => setRoles(PRESETS[b.dataset.preset])));
$('#btnAddRole').onclick = () => $('#rolesEditor').appendChild(roleRow());
$('#btnCancel').onclick = () => $('#projectDialog').close();
$('#projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const agents = [...document.querySelectorAll('#rolesEditor .role-row')].map((r) => ({
    name: r.querySelector('[name=rname]').value.trim(),
    type: r.querySelector('[name=rtype]').value,
    role: r.querySelector('[name=rrole]').value.trim(),
  }));
  const body = {
    name: f.name.value,
    description: f.description.value,
    workdir: f.workdir.value,
    maxHops: f.maxHops.value,
    agents,
  };
  try {
    const { project } = S.editing
      ? await api(`/api/projects/${S.editing.id}`, { method: 'PATCH', body })
      : await api('/api/projects', { method: 'POST', body });
    $('#projectDialog').close();
    await loadProjects();
    if (S.editing) {
      S.current = project;
      renderHeader();
      renderMembers();
      renderChips();
    } else location.hash = `#/p/${project.id}`;
  } catch (err) {
    $('#formError').textContent = err.message;
  }
});
$('#btnNew').onclick = () => openProjectDialog();
$('#btnNew2').onclick = () => openProjectDialog();
$('#btnEdit').onclick = () => openProjectDialog(S.current);
$('#btnDelete').onclick = async () => {
  if (!confirm(`确定删除项目「${S.current.name}」及全部聊天记录吗？此操作不可恢复。`)) return;
  await api(`/api/projects/${S.current.id}`, { method: 'DELETE' });
  closeWs();
  location.hash = '';
  await loadProjects();
};
$('#btnPause').onclick = async () => {
  const { project } = await api(`/api/projects/${S.current.id}`, { method: 'PATCH', body: { paused: !S.current.paused } });
  S.current = project;
  renderHeader();
};

// ---------- 移动端 ----------
$('#btnMenu').onclick = () => $('#sidebar').classList.toggle('open');
$('#btnMembers').onclick = () => $('#members').classList.add('open');
$('#btnCloseMembers').onclick = () => $('#members').classList.remove('open');

// ---------- 启动 ----------
async function boot() {
  try {
    await loadProjects();
  } catch {
    return;
  }
  route();
}
window.addEventListener('hashchange', route);
setInterval(() => S.current || loadProjects().catch(() => {}), 15000);
boot();
