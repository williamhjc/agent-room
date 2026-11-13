// Agent Room 网页端
import { headIcon, sceneSVG, sceneState, sceneCaption } from './scenes.js';
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
    if (ev.code === 4002) return setConn(ev.reason === 'bad name' ? '昵称冲突，请修改左下角昵称' : '连接被拒绝', 'bad');
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
    const k = m.meta?.kind;
    el.innerHTML = `<div class="sys ${k === 'ack-timeout' ? 'warn' : k === 'ack-late' ? 'ok' : k === 'quota' ? 'quota' : ''}">${esc(m.text)}</div>`;
    return el;
  }
  const isMe = m.fromType === 'user';
  const type = isMe ? 'user' : agentType(m.from);
  const t = new Date(m.ts);
  const time = t.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parent = m.replyTo && S.messages.find((x) => x.id === m.replyTo);
  el.className = `msg ${isMe ? 'me' : `agent-${type}`}${m.meta?.kind === 'quota' ? ' quota-msg' : ''}`;
  el.innerHTML = `
    <div class="avatar ${type}" title="${esc(m.from)}">${headIcon(type, esc([...m.from][0] || '?'))}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="who">${esc(m.from)}</span>
        ${isMe ? '' : `<span class="tag ${type}">${type === 'codex' ? 'Codex' : 'Claude'}</span>`}
        <span class="time">${time}</span>
      </div>
      ${parent ? `<div class="reply-ref">↪ 回复 ${esc(parent.from)}：${esc(parent.text.slice(0, 40))}${parent.text.length > 40 ? '…' : ''}</div>` : ''}
      ${m.text ? `<div class="bubble">${renderMarkdown(m.text, m.mentions)}</div>` : ''}
      ${renderAttachments(m.attachments)}
    </div>`;
  const bubble = el.querySelector('.bubble');
  if (bubble && (m.text.length > 1200 || m.text.split('\n').length > 18)) {
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
function renderAttachments(list) {
  if (!list?.length) return '';
  return `<div class="atts">${list
    .map((a) =>
      a.type === 'image'
        ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" title="${esc(a.name)}" loading="lazy" data-zoom />`
        : `<a class="att-file" href="${esc(a.url)}?download=1&name=${encodeURIComponent(a.name)}" target="_blank" rel="noopener">📄 ${esc(a.name)} <span class="muted small">${fmtSize(a.size)}</span></a>`
    )
    .join('')}</div>`;
}
function fmtSize(n) {
  if (!n) return '';
  return n > 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
}
$('#messages').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-zoom]');
  if (!img) return;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${esc(img.src)}" />`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
});
$('#messages').addEventListener('load', (e) => e.target.matches?.('img[data-zoom]') && isNearBottom(400) && scrollBottom(), true);
function isNearBottom(px) {
  const b = $('#messages');
  return b.scrollHeight - b.scrollTop - b.clientHeight < px;
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
    .map((a) => `<span class="w"><span class="mini">${headIcon(a.type)}</span><span class="dots"><i></i><i></i><i></i></span>@${esc(a.name)} 正在搬砖${a.note ? `（${esc(a.note)}）` : ''}</span>`)
    .join('');
}

// ---------- 成员面板 ----------
const STATUS_TEXT = { offline: '离线', idle: '在线 · 空闲', working: '工作中', error: '出错', quota: '额度用完 · 等待恢复' };
const MODE_TEXT = { connector: '连接器', session: '交互会话' };
// 卡片按 agent 复用；场景 SVG 只在状态变化时替换，避免每次在线状态更新都让动画重播
const memberCards = new Map(); // name -> { el, sceneKey }
let memberListKey = '';
function renderMembers() {
  const p = S.current;
  if (!p) return;
  const listKey = p.id + '|' + p.agents.map((a) => `${a.name}:${a.type}:${a.role}`).join('|');
  if (listKey !== memberListKey) {
    memberListKey = listKey;
    memberCards.clear();
    const box = $('#memberList');
    box.innerHTML = '';
    for (const a of p.agents) {
      const el = document.createElement('div');
      el.className = 'member';
      el.innerHTML = `
        <div class="stage"><div class="stage-scene"></div></div>
        <div class="stage-caption"></div>
        <div class="member-info">
          <div class="member-top">
            <div class="avatar ${a.type}">${headIcon(a.type)}<span class="status-dot"></span></div>
            <div style="flex:1;min-width:0">
              <div class="member-name"></div>
              <div class="member-status"></div>
            </div>
          </div>
          <div class="member-role">${esc(a.role || '（未定义分工）')}</div>
          <div class="member-actions"></div>
        </div>`;
      box.appendChild(el);
      memberCards.set(a.name, { el, sceneKey: '' });
    }
  }
  const pres = new Map(S.presence.map((a) => [a.name, a]));
  for (const a of p.agents) {
    const card = memberCards.get(a.name);
    const st = pres.get(a.name) || { status: 'offline' };
    const state = sceneState(st);
    const key = `${state}|${a.type}|${Math.min(st.pending || 0, 10)}`;
    const el = card.el;
    el.className = `member st-${state}`;
    if (card.sceneKey !== key) {
      card.sceneKey = key;
      el.querySelector('.stage-scene').innerHTML = sceneSVG(a.type, state, st);
    }
    el.querySelector('.stage-caption').textContent = sceneCaption(state, st);
    el.querySelector('.status-dot').className = `status-dot ${st.online ? st.status : 'offline'}`;
    el.querySelector('.member-name').innerHTML = `@${esc(a.name)} <span class="tag ${a.type}">${a.type === 'codex' ? 'Codex' : 'Claude'}</span>${
      st.mode ? `<span class="mode-tag">${MODE_TEXT[st.mode] || st.mode}</span>` : ''
    }${st.pending ? `<span class="pend" title="已派发但还没接单的消息">${st.status === 'working' ? '排队' : '待接单'} ${st.pending}</span>` : ''}`;
    el.querySelector('.member-status').textContent = `${statusText(st)}${st.host ? ` · ${st.host}` : ''}`;
    el.querySelector('.member-actions').innerHTML = `
      <button class="btn xs" data-act="at" data-name="${esc(a.name)}">@它</button>
      <button class="btn xs" data-act="connect" data-name="${esc(a.name)}">接入方式</button>
      ${(st.status === 'working' || st.status === 'quota') && st.mode === 'connector' ? `<button class="btn xs danger-text" data-act="cancel" data-name="${esc(a.name)}" title="${st.status === 'quota' ? '清空等额度恢复的排队任务' : '中止当前任务'}">${st.status === 'quota' ? '清空排队' : '中止'}</button>` : ''}
      ${st.mode === 'connector' && st.listening ? `<button class="btn xs" data-act="reset" data-name="${esc(a.name)}" title="清空该 agent 的 CLI 会话上下文">重置会话</button>` : ''}`;
  }
}
function statusText(st) {
  if (st.status === 'idle' && st.mode === 'session') return st.listening ? '在线 · 等待消息' : '未在监听';
  return STATUS_TEXT[st.status] || st.status;
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
let connMode = 'connector';
let connAgent = null;
function serverBase() {
  return (S.publicUrl || location.origin).replace(/\/$/, '');
}
function wsUrl() {
  return serverBase().replace(/^http/, 'ws') + '/ws';
}
function q(s, os) {
  return os === 'ps' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}
function dlCmd(os) {
  const b = serverBase();
  if (os === 'ps') {
    return (
      '$d = "$HOME\\.agent-room\\bin"; New-Item -ItemType Directory -Force $d | Out-Null\n' +
      `foreach ($f in 'connector','room','common') { Invoke-WebRequest "${b}/agent/$f.js" -OutFile "$d\\$f.js" }`
    );
  }
  return `mkdir -p ~/.agent-room/bin && for f in connector room common; do \\\n  curl -fsS "${b}/agent/$f.js" -o ~/.agent-room/bin/$f.js; done`;
}
function toolPath(os, file) {
  return os === 'ps' ? `$HOME\\.agent-room\\bin\\${file}` : `~/.agent-room/bin/${file}`;
}
function runCmd(a, os, mode) {
  const p = S.current;
  const wd = p.workdir || (os === 'ps' ? 'D:\\path\\to\\project' : '/path/to/project');
  const nl = os === 'ps' ? ' `\n  ' : ' \\\n  ';
  const common = `${nl}--server ${wsUrl()}${nl}--project ${p.id}${nl}--agent ${q(a.name, os)}${nl}--token ${a.token}`;
  if (mode === 'connector') return `node ${toolPath(os, 'connector.js')}${common}${nl}--workdir ${q(wd, os)}`;
  return `cd ${q(wd, os)}\nnode ${toolPath(os, 'room.js')} init${common}`;
}
function sessionPrompt(a, os) {
  const p = S.current;
  const room = `node ${toolPath(os, 'room.js')}`;
  const others = p.agents
    .filter((x) => x.name !== a.name)
    .map((x) => `@${x.name}（${(x.role || '未定义').split('\n')[0].slice(0, 40)}）`)
    .join('、');
  return `你现在是 Agent Room 多 agent 协作群「${p.name}」里的成员 @${a.name}。
你的分工：${a.role || '未定义'}
其他成员：${others || '无'}

在项目目录里用下面的命令和团队协作（连接信息已由 room init 保存在当前目录的 .agent-room.json）：
- 等任务：${room} wait —— 会一直阻塞到有人 @你 才返回。请把这条命令的超时设成工具允许的最大值（如 10 分钟）；如果超时、被中断或返回码为 3，直接再运行一次。
- 回复：${room} send "内容"（需要别人接手就在内容里 @对方；截图/文件用 --attach 路径，不要贴 base64）
- 干活中途看新消息：${room} inbox（需求可能变了，例如有了更新的提交号；过时的任务不要继续做）
- 其他：${room} who 看成员状态；${room} show <id> 看长消息全文；${room} get <附件URL> 下载附件

工作循环（务必遵守）：
1. 运行 room wait 拿到任务；
2. 完成你分工内的工作；
3. 用 room send 把结论发到群里；
4. 立刻回到第 1 步继续 room wait。不要结束对话、不要停下来等我输入——群里的人只能通过 @你 找到你，你不 wait 就收不到消息。

只用你自己的身份 @${a.name} 发言，绝不冒充用户或其他成员。现在开始：运行 room wait。`;
}
function showConnect(name) {
  connAgent = S.current.agents.find((a) => a.name === name);
  $('#connTitle').textContent = `接入 @${name}`;
  renderConnCmd();
  $('#connectDialog').showModal();
}
function renderConnCmd() {
  const cli = connAgent.type === 'codex' ? 'codex' : 'claude';
  $('#connDesc').innerHTML =
    connMode === 'connector'
      ? `常驻进程监听群消息，被 @ 时自动调用本机 <code>${cli}</code> CLI 在项目目录干活，干完把结果发回群里。最稳定，无需人工值守；需要该机器已安装并登录 ${cli} CLI。`
      : '让一个已经打开的交互式 Codex / Claude Code 会话加入群聊：它通过 <code>room wait</code> 等待 @，干完活用 <code>room send</code> 回复。适合需要桌面权限、MCP 等交互环境的场景，会话必须保持运行。';
  $('#connDl').textContent = dlCmd(connOs);
  $('#connStep2').textContent = connMode === 'connector' ? '② 启动连接器（保持运行，断线会自动重连）' : '② 在项目目录保存连接信息';
  $('#connCmd').textContent = runCmd(connAgent, connOs, connMode);
  $('#connPromptWrap').classList.toggle('hidden', connMode !== 'session');
  $('#connPrompt').textContent = sessionPrompt(connAgent, connOs);
  $('#connOpts').innerHTML =
    connMode === 'connector'
      ? '可选参数：<code>--yolo</code> 跳过所有权限确认（全自动）、<code>--model</code> 指定模型、<code>--permission</code> 权限模式、<code>--timeout</code> 单次任务上限（分钟，默认 720 即 12 小时，0 不限）、<code>--dry-run</code> 不调用 CLI 只回显（联调用）。'
      : '提示：会话做完一轮后如果没有再运行 room wait，派给它的消息超过「接单超时」后群里会出现黄色提醒，此时回到该会话让它继续 room wait 即可。';
  document.querySelectorAll('#connTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.os === connOs));
  document.querySelectorAll('#connModes .tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === connMode));
}
$('#connTabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  connOs = t.dataset.os;
  renderConnCmd();
});
$('#connModes').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  connMode = t.dataset.mode;
  renderConnCmd();
});
$('#btnCopy').onclick = async () => {
  const parts = [$('#connDl').textContent, $('#connCmd').textContent];
  if (connMode === 'session') parts.push('# 发给会话的提示：\n' + $('#connPrompt').textContent);
  try {
    await navigator.clipboard.writeText(parts.join('\n\n'));
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
        `<div class="opt ${i === pop.idx ? 'active' : ''}" data-i="${i}"><span class="avatar ${a.type}">${headIcon(a.type, '@')}</span><b>@${esc(a.name)}</b><span class="r">${esc((a.role || '').split('\n')[0])}</span></div>`
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
  if (S.attachments.some((a) => a.uploading)) return toast('附件还在上传…');
  const attachments = S.attachments.map((a) => a.att);
  if (!text && !attachments.length) return;
  if (!S.ws || S.ws.readyState !== 1) return toast('未连接到服务器');
  S.ws.send(JSON.stringify({ type: 'message', text, attachments }));
  input.value = '';
  S.attachments = [];
  renderAttachList();
  autosize();
}

// ---------- 附件 ----------
S.attachments = []; // { id, name, preview, uploading, att }
let attSeq = 0;
function renderAttachList() {
  const box = $('#attachList');
  box.classList.toggle('hidden', !S.attachments.length);
  box.innerHTML = S.attachments
    .map(
      (a) => `<div class="attach-item ${a.uploading ? 'uploading' : ''}" data-id="${a.id}">
        ${a.preview ? `<img src="${a.preview}" />` : '📄'}<span class="an">${esc(a.name)}</span>
        <button class="x" title="移除">✕</button></div>`
    )
    .join('');
}
$('#attachList').addEventListener('click', (e) => {
  const item = e.target.closest('.x') && e.target.closest('.attach-item');
  if (!item) return;
  S.attachments = S.attachments.filter((a) => String(a.id) !== item.dataset.id);
  renderAttachList();
});
async function addFiles(files) {
  if (!S.current) return;
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      toast(`${file.name} 超过 20MB`);
      continue;
    }
    const item = {
      id: ++attSeq,
      name: file.name || 'image.png',
      uploading: true,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    };
    S.attachments.push(item);
    renderAttachList();
    try {
      const res = await fetch(`/api/projects/${S.current.id}/uploads?name=${encodeURIComponent(item.name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.status);
      item.att = data.attachment;
      item.uploading = false;
    } catch (err) {
      toast(`上传失败：${err.message}`);
      S.attachments = S.attachments.filter((a) => a !== item);
    }
    renderAttachList();
  }
}
$('#btnAttach').onclick = () => $('#fileInput').click();
$('#fileInput').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(
    files.map((f, i) =>
      f.name && f.name !== 'image.png' ? f : new File([f], `粘贴图片-${Date.now()}-${i}.${f.type.split('/')[1] || 'png'}`, { type: f.type })
    )
  );
});
const chatEl = $('#chat');
chatEl.addEventListener('dragover', (e) => {
  if (!S.current || !e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  chatEl.classList.add('drop-hint');
});
chatEl.addEventListener('dragleave', (e) => e.target === chatEl && chatEl.classList.remove('drop-hint'));
chatEl.addEventListener('drop', (e) => {
  chatEl.classList.remove('drop-hint');
  if (!S.current || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});

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
  f.ackTimeoutSec.value = project?.ackTimeoutSec || 60;
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
    ackTimeoutSec: f.ackTimeoutSec.value,
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
    const cfg = await fetch('/api/config').then((r) => r.json());
    S.publicUrl = cfg.publicUrl || '';
  } catch {}
  try {
    await loadProjects();
  } catch {
    return;
  }
  route();
}
window.addEventListener('hashchange', route);
setInterval(() => S.current || loadProjects().catch(() => {}), 15000);
// 额度恢复倒计时
setInterval(() => S.current && S.presence?.some((a) => a.status === 'quota') && renderMembers(), 30000);
boot();
