// Agent 状态小剧场：头部是 Claude / Codex 图标，身体是简笔画，不同状态不同场景。
// 场景：beach（空闲晒太阳睡觉）working（搬砖）fishing（等消息钓鱼）quota（额度用完，抱电池充电）offline（帐篷睡觉）error（电脑冒烟）

/** 头像图标（引用 index.html 里的 <symbol>） */
export function headIcon(type, label = '') {
  if (type === 'claude' || type === 'codex') {
    return `<svg class="head-ico" viewBox="0 0 100 100" aria-hidden="true"><use href="#ico-${type}" width="100" height="100"/></svg>`;
  }
  return `<span class="user-ini">${label}</span>`;
}

const head = (type, x, y, size, cls = '') =>
  `<use class="head ${cls}" href="#ico-${type === 'codex' ? 'codex' : 'claude'}" x="${x}" y="${y}" width="${size}" height="${size}"/>`;

/** 根据在线信息推出场景 */
export function sceneState(st) {
  if (!st || !st.online) return 'offline';
  if (st.status === 'error') return 'error';
  if (st.status === 'quota') return 'quota';
  if (st.status === 'working') return 'working';
  if (st.mode === 'session' && st.listening) return 'fishing';
  return 'beach';
}

export function sceneCaption(state, st) {
  const note = st?.note ? `：${st.note}` : '';
  switch (state) {
    case 'working':
      return `搬砖中${note}`;
    case 'fishing':
      return '戴着耳机钓鱼，等消息上钩（交互会话 · room wait）';
    case 'beach':
      return '空闲，在沙滩上打盹。@它就开工';
    case 'error':
      return `电脑冒烟了${note}`;
    case 'quota':
      return `额度用完，抱着电池充电中${st?.until ? `（${untilText(st.until)}）` : ''}。消息会排队，恢复后自动接着干`;
    default:
      return st?.pending ? '离线，在帐篷里睡觉——有消息等它上线' : '离线，在帐篷里睡觉';
  }
}

/** 预计恢复时间："预计 15:00 恢复 · 还有 2 小时 5 分" */
export function untilText(until) {
  const left = until - Date.now();
  if (left <= 0) return '正在重试';
  const d = new Date(until);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const clock = sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  const min = Math.ceil(left / 60_000);
  const rel = min < 60 ? `${min} 分钟` : min < 2880 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${Math.round(min / 1440)} 天`;
  return `预计 ${clock} 恢复 · 还有 ${rel}`;
}

function mailOverlay(n, working) {
  if (!n) return '';
  return `<g class="mail" transform="translate(8 8)">
    <g class="mail-bounce">
      <rect x="0" y="0" width="24" height="16" rx="2.5" fill="#f4f7ff" stroke="#9aa8d6"/>
      <path d="M1 1.5 L12 9.5 L23 1.5" fill="none" stroke="#9aa8d6" stroke-width="1.4"/>
      <circle cx="24" cy="1" r="6.5" fill="${working ? '#f59e0b' : '#ff4d6d'}"/>
      <text x="24" y="3.6" text-anchor="middle" font-size="8" font-weight="700" fill="#fff">${n > 9 ? '9+' : n}</text>
    </g>
    <text x="34" y="12" font-size="8" fill="#fff" class="mail-label">${working ? '排队中' : '待接单'}</text>
  </g>`;
}

const STICK = 'stroke-linecap="round" stroke-linejoin="round" fill="none"';

function beach(type) {
  return `
  <defs>
    <linearGradient id="sky-beach" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b1d63"/><stop offset=".55" stop-color="#b44d7f"/><stop offset="1" stop-color="#f6a35b"/>
    </linearGradient>
  </defs>
  <rect width="220" height="120" fill="url(#sky-beach)"/>
  <circle cx="172" cy="64" r="22" fill="#ffd27a" opacity=".25" class="sun-glow"/>
  <circle cx="172" cy="64" r="14" fill="#ffd27a"/>
  <rect y="64" width="220" height="22" fill="#2a5fa8"/>
  <g class="waves"><path d="M0 70 q10 -3 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" stroke="#9ad4ff" stroke-width="1.2" fill="none" opacity=".7"/>
  <path d="M-10 78 q10 -3 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" stroke="#cdeaff" stroke-width="1" fill="none" opacity=".5"/></g>
  <path d="M0 86 Q110 78 220 86 V120 H0Z" fill="#f2d39b"/>
  <path d="M0 96 Q60 92 120 97 T220 95" stroke="#e6bf7c" fill="none"/>
  <!-- 遮阳伞 -->
  <line x1="36" y1="108" x2="50" y2="50" stroke="#7a5532" stroke-width="2.2" stroke-linecap="round"/>
  <path d="M20 60 Q48 26 82 50 Z" fill="#ff6b6b"/>
  <path d="M36 52 Q48 30 60 47 Z" fill="#fff4e6"/>
  <!-- 毛巾和饮料 -->
  <rect x="58" y="99" width="86" height="9" rx="2" fill="#38c6e0" opacity=".9"/>
  <rect x="58" y="101.5" width="86" height="2" fill="#fff" opacity=".6"/>
  <path d="M152 92 h9 l-1.5 13 h-6z" fill="#ffffff" opacity=".85"/><path d="M154 95 h5 l-.8 9 h-3.4z" fill="#ff9f43"/>
  <line x1="158" y1="92" x2="163" y2="84" stroke="#ff4d6d" stroke-width="1.3"/>
  <!-- 躺着的小人 -->
  <g class="breathe">
    <g stroke="#3b3355" stroke-width="3" ${STICK}>
      <line x1="84" y1="100" x2="114" y2="100"/>
      <polyline points="114,100 124,91 136,99"/>
      <line x1="114" y1="100" x2="134" y2="102"/>
      <polyline points="90,100 98,95 106,99"/>
      <polyline points="86,99 80,92 74,90"/>
    </g>
    ${head(type, 62, 86, 24)}
  </g>
  <g class="zzz" font-weight="700" fill="#fff">
    <text class="z z1" x="80" y="84" font-size="9">z</text>
    <text class="z z2" x="86" y="78" font-size="11">z</text>
    <text class="z z3" x="93" y="71" font-size="13">Z</text>
  </g>`;
}

function working(type) {
  const bricks = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      const x = 8 + c * 16 + (r % 2 ? 8 : 0);
      if (x > 50) continue;
      bricks.push(`<rect x="${x}" y="${92 - r * 8}" width="15" height="7" rx="1" fill="#c8553d" stroke="#7a2e20" stroke-width=".8"/>`);
    }
  }
  return `
  <defs>
    <linearGradient id="sky-work" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0f1c3d"/><stop offset="1" stop-color="#1f4470"/>
    </linearGradient>
    <pattern id="grid-work" width="14" height="14" patternUnits="userSpaceOnUse"><path d="M14 0H0V14" fill="none" stroke="#5fb4ff" stroke-opacity=".08"/></pattern>
  </defs>
  <rect width="220" height="120" fill="url(#sky-work)"/>
  <rect width="220" height="100" fill="url(#grid-work)"/>
  <!-- 塔吊 -->
  <g stroke="#ffcc33" stroke-width="1.6" opacity=".55" fill="none">
    <line x1="190" y1="100" x2="190" y2="16"/><line x1="150" y1="20" x2="214" y2="20"/>
    <line x1="190" y1="16" x2="160" y2="20"/><line x1="166" y1="20" x2="166" y2="44" class="crane-rope"/>
  </g>
  <rect x="160" y="44" width="12" height="6" fill="#c8553d" opacity=".7" class="crane-load"/>
  <rect y="100" width="220" height="20" fill="#2e2622"/>
  <g class="ground-move" stroke="#6b5a4a" stroke-width="2" stroke-linecap="round">
    ${Array.from({ length: 14 }, (_, i) => `<line x1="${i * 20}" y1="108" x2="${i * 20 + 8}" y2="108"/>`).join('')}
  </g>
  ${bricks.join('')}
  <!-- 砖堆 -->
  <g fill="#d4583f" stroke="#8a2f1f" stroke-width=".8">
    <rect x="150" y="93" width="16" height="7" rx="1"/><rect x="167" y="93" width="16" height="7" rx="1"/><rect x="184" y="93" width="16" height="7" rx="1"/>
    <rect x="158" y="86" width="16" height="7" rx="1"/><rect x="175" y="86" width="16" height="7" rx="1"/>
    <rect x="167" y="79" width="16" height="7" rx="1"/>
  </g>
  <!-- 搬砖的小人 -->
  <g class="walker">
    <g stroke="#e8eefc" stroke-width="3" ${STICK}>
      <line x1="104" y1="50" x2="104" y2="76"/>
      <line class="leg leg-a" x1="104" y1="76" x2="97" y2="100" style="transform-origin:104px 76px"/>
      <line class="leg leg-b" x1="104" y1="76" x2="111" y2="100" style="transform-origin:104px 76px"/>
      <polyline points="104,57 115,63 121,58"/>
      <polyline points="104,58 113,68 121,66"/>
    </g>
    <rect x="114" y="52" width="24" height="12" rx="1.5" fill="#d4583f" stroke="#8a2f1f"/>
    <line x1="126" y1="52" x2="126" y2="64" stroke="#8a2f1f" stroke-width=".8"/>
    ${head(type, 90, 22, 28)}
    <path d="M88 32 Q104 12 120 32 Z" fill="#ffcc33"/>
    <line x1="86" y1="32" x2="123" y2="32" stroke="#e0a800" stroke-width="3" stroke-linecap="round"/>
    <path class="sweat" d="M122 38 q2 4 0 6 q-2 -2 0 -6z" fill="#7fd3ff"/>
  </g>
  <g class="dust" fill="#bfa58a" opacity=".6"><circle cx="96" cy="102" r="2"/><circle cx="90" cy="100" r="1.4"/></g>`;
}

function fishing(type) {
  return `
  <defs>
    <linearGradient id="sky-fish" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0a1633"/><stop offset="1" stop-color="#1b3f73"/>
    </linearGradient>
  </defs>
  <rect width="220" height="120" fill="url(#sky-fish)"/>
  <g fill="#fff"><circle class="star s1" cx="30" cy="16" r="1"/><circle class="star s2" cx="120" cy="10" r="1.2"/><circle class="star s3" cx="160" cy="28" r=".9"/><circle class="star s1" cx="90" cy="24" r=".8"/></g>
  <circle cx="190" cy="22" r="10" fill="#fdf3c4"/><circle cx="195" cy="19" r="9" fill="#0d1a3a"/>
  <rect y="76" width="220" height="44" fill="#0d4a7c"/>
  <g class="waves"><path d="M0 82 q10 -3 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" stroke="#5fb4ff" stroke-width="1" fill="none" opacity=".5"/>
  <path d="M-10 96 q10 -3 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" stroke="#5fb4ff" stroke-width="1" fill="none" opacity=".35"/></g>
  <!-- 码头 -->
  <rect x="0" y="68" width="84" height="8" fill="#8a5d38"/>
  <g stroke="#5c3b22" stroke-width="3"><line x1="12" y1="76" x2="12" y2="112"/><line x1="70" y1="76" x2="70" y2="112"/></g>
  <!-- 钓鱼的小人 -->
  <g stroke="#e8eefc" stroke-width="3" ${STICK}>
    <line x1="56" y1="52" x2="58" y2="68"/>
    <line x1="58" y1="68" x2="76" y2="68"/>
    <line class="swing" x1="76" y1="68" x2="78" y2="88" style="transform-origin:76px 68px"/>
    <polyline points="57,57 68,62 78,58"/>
  </g>
  <line x1="78" y1="58" x2="154" y2="20" stroke="#c9a36b" stroke-width="2" stroke-linecap="round"/>
  <g class="bobber">
    <line x1="154" y1="20" x2="154" y2="80" stroke="#dfe7ff" stroke-width=".6"/>
    <circle cx="154" cy="82" r="3.4" fill="#ff4d6d"/><path d="M150.6 82 a3.4 3.4 0 0 0 6.8 0z" fill="#fff"/>
  </g>
  <ellipse class="ripple" cx="154" cy="85" rx="6" ry="1.6" fill="none" stroke="#9ad4ff"/>
  <ellipse class="ripple r2" cx="154" cy="85" rx="6" ry="1.6" fill="none" stroke="#9ad4ff"/>
  ${head(type, 44, 28, 24)}
  <!-- 耳机：在"听"消息 -->
  <path d="M45 40 Q56 22 67 40" fill="none" stroke="#38e8ff" stroke-width="2.4"/>
  <rect x="42" y="37" width="5" height="8" rx="2" fill="#38e8ff"/><rect x="65" y="37" width="5" height="8" rx="2" fill="#38e8ff"/>
  <g class="listen" fill="#38e8ff"><circle cx="78" cy="30" r="1.6"/><circle cx="84" cy="27" r="1.6"/><circle cx="90" cy="24" r="1.6"/></g>`;
}

function offline(type) {
  return `
  <defs>
    <linearGradient id="sky-off" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05080f"/><stop offset="1" stop-color="#121a30"/>
    </linearGradient>
  </defs>
  <rect width="220" height="120" fill="url(#sky-off)"/>
  <g fill="#cbd5ff"><circle class="star s1" cx="24" cy="18" r="1"/><circle class="star s2" cx="64" cy="30" r=".8"/><circle class="star s3" cx="140" cy="14" r="1.1"/><circle class="star s2" cx="200" cy="40" r=".8"/><circle class="star s1" cx="176" cy="12" r=".9"/></g>
  <circle cx="40" cy="38" r="9" fill="#e9e4c9" opacity=".8"/><circle cx="44" cy="35" r="8" fill="#070b14"/>
  <rect y="98" width="220" height="22" fill="#141b2e"/>
  <path d="M66 98 L104 44 L142 98 Z" fill="#33406a"/>
  <path d="M104 44 L92 98 L116 98 Z" fill="#1a2140"/>
  <line x1="104" y1="44" x2="104" y2="36" stroke="#6b7bb0" stroke-width="1.5"/>
  <g class="dim">${head(type, 94, 78, 20)}</g>
  <g class="zzz" fill="#8a94b8" font-weight="700"><text class="z z1" x="116" y="80" font-size="7">z</text><text class="z z2" x="121" y="74" font-size="9">z</text></g>
  <line x1="176" y1="98" x2="176" y2="72" stroke="#5c4a3a" stroke-width="2.5"/>
  <rect x="156" y="58" width="40" height="16" rx="2" fill="#262f4d" stroke="#3d4a75"/>
  <text x="176" y="69.5" text-anchor="middle" font-size="9" fill="#8a94b8" font-weight="700">离线</text>`;
}

function error(type) {
  return `
  <defs>
    <linearGradient id="sky-err" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#26091a"/><stop offset="1" stop-color="#4a1426"/>
    </linearGradient>
  </defs>
  <rect width="220" height="120" fill="url(#sky-err)"/>
  <rect y="100" width="220" height="20" fill="#2a0f18"/>
  <!-- 冒烟的电脑 -->
  <rect x="122" y="72" width="36" height="24" rx="2" fill="#11131a" stroke="#ff4d6d"/>
  <text x="140" y="89" text-anchor="middle" font-size="14" font-weight="800" fill="#ff4d6d" class="blink">!</text>
  <rect x="116" y="96" width="48" height="4" rx="1" fill="#3a3f52"/>
  <g class="smoke" fill="#a3a3b8"><circle class="p p1" cx="134" cy="68" r="5"/><circle class="p p2" cx="146" cy="66" r="6"/><circle class="p p3" cx="140" cy="62" r="4"/></g>
  <!-- 坐在地上发懵的小人 -->
  <g stroke="#e8eefc" stroke-width="3" ${STICK}>
    <line x1="92" y1="72" x2="92" y2="92"/>
    <polyline points="92,92 106,96 112,100"/>
    <polyline points="92,92 80,98 74,100"/>
    <polyline points="92,78 104,84 116,86"/>
    <polyline points="92,78 82,86"/>
  </g>
  <g class="wobble" style="transform-origin:92px 58px">${head(type, 79, 45, 26)}</g>
  <g class="orbit" style="transform-origin:92px 46px" fill="#ffd166" font-size="9">
    <text x="74" y="40">✦</text><text x="104" y="36">✦</text><text x="90" y="30">✦</text>
  </g>
  <path d="M190 14 L204 38 H176 Z" fill="#ff4d6d" class="blink"/><text x="190" y="34" text-anchor="middle" font-size="12" font-weight="800" fill="#fff">!</text>`;
}

function quota(type) {
  return `
  <defs>
    <linearGradient id="sky-quota" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1240"/><stop offset="1" stop-color="#2d2466"/>
    </linearGradient>
  </defs>
  <rect width="220" height="120" fill="url(#sky-quota)"/>
  <rect y="100" width="220" height="20" fill="#1d1640"/>
  <!-- 墙上的钟：等恢复 -->
  <circle cx="40" cy="30" r="13" fill="#2a2160" stroke="#a78bfa" stroke-width="1.6"/>
  <line x1="40" y1="30" x2="40" y2="21" stroke="#e8e2ff" stroke-width="1.6" stroke-linecap="round" class="clock-min" style="transform-origin:40px 30px"/>
  <line x1="40" y1="30" x2="46" y2="30" stroke="#e8e2ff" stroke-width="1.8" stroke-linecap="round"/>
  <!-- 插座和电线 -->
  <rect x="196" y="70" width="12" height="16" rx="2" fill="#3a3270" stroke="#7c6fd0"/>
  <circle cx="200" cy="78" r="1.2" fill="#1a1240"/><circle cx="204" cy="78" r="1.2" fill="#1a1240"/>
  <path d="M196 80 C180 80 186 104 160 100" stroke="#7c6fd0" stroke-width="2" fill="none"/>
  <!-- 大电池 -->
  <rect x="122" y="54" width="40" height="46" rx="5" fill="#120d2e" stroke="#a78bfa" stroke-width="2"/>
  <rect x="134" y="49" width="16" height="6" rx="2" fill="#a78bfa"/>
  <g class="charge">
    <rect class="cb cb1" x="127" y="88" width="30" height="8" rx="1.5" fill="#34d399"/>
    <rect class="cb cb2" x="127" y="78" width="30" height="8" rx="1.5" fill="#34d399"/>
    <rect class="cb cb3" x="127" y="68" width="30" height="8" rx="1.5" fill="#34d399"/>
    <rect class="cb cb4" x="127" y="58" width="30" height="8" rx="1.5" fill="#34d399"/>
  </g>
  <path class="bolt" d="M145 60 L136 78 H143 L139 94 L150 72 H143 Z" fill="#ffd166" stroke="#b8860b" stroke-width=".6"/>
  <!-- 抱着电池打盹的小人 -->
  <g stroke="#e8eefc" stroke-width="3" ${STICK}>
    <line x1="96" y1="68" x2="98" y2="90"/>
    <polyline points="98,90 112,92 118,100"/>
    <polyline points="98,90 88,98 84,100"/>
    <polyline points="97,74 110,72 124,70"/>
    <polyline points="97,76 108,82 124,84"/>
  </g>
  <g class="nod" style="transform-origin:96px 66px">${head(type, 82, 40, 26)}</g>
  <!-- 咖啡 -->
  <path d="M60 90 h12 l-1.6 10 h-8.8z" fill="#f4f7ff" opacity=".9"/><path d="M72 92 q5 1 0 5" stroke="#f4f7ff" fill="none" stroke-width="1.4"/>
  <g class="steam" stroke="#c4b5fd" stroke-width="1.2" fill="none" opacity=".7"><path class="p p1" d="M64 86 q-2 -4 0 -8"/><path class="p p2" d="M68 86 q2 -4 0 -8"/></g>
  <g class="zzz" font-weight="700" fill="#c4b5fd">
    <text class="z z1" x="106" y="40" font-size="8">z</text>
    <text class="z z2" x="112" y="33" font-size="10">z</text>
  </g>
  <rect x="8" y="104" width="64" height="12" rx="6" fill="#2a2160" stroke="#a78bfa" stroke-width=".8"/>
  <text x="40" y="112.5" text-anchor="middle" font-size="7.5" fill="#e8e2ff" font-weight="700">额度充电中</text>`;
}

const SCENES = { beach, working, fishing, offline, error, quota };

export function sceneSVG(type, state, st) {
  const body = (SCENES[state] || offline)(type);
  return `<svg class="scene s-${state}" viewBox="0 0 220 120" role="img" aria-label="${sceneCaption(state, st)}">${body}${mailOverlay(st?.pending || 0, state === 'working')}</svg>`;
}
