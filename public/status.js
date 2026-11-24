// Agent 状态：头像图标、状态判断和说明文字（工位卡片的执行过程面板用）

/** 头像图标（引用 index.html 里的 <symbol>） */
export function headIcon(type, label = '') {
  if (type === 'claude' || type === 'codex') {
    return `<svg class="head-ico" viewBox="0 0 100 100" aria-hidden="true"><use href="#ico-${type}" width="100" height="100"/></svg>`;
  }
  return `<span class="user-ini">${label}</span>`;
}

/**
 * 根据在线信息推出状态：
 * working 干活中 / listening 会话在 room wait 等消息 / stopped 会话窗口开着但没在 room wait（@ 它收不到）
 * idle 连接器空闲 / quota 额度用完 / error 出错 / offline 离线（含会话已关闭、失去联系）
 */
export function liveState(st) {
  if (!st || !st.online) return 'offline';
  if (st.status === 'error') return 'error';
  if (st.status === 'quota') return 'quota';
  if (st.status === 'working') return 'working';
  if (st.mode === 'session') return st.listening ? 'listening' : 'stopped';
  return 'idle';
}

const clock = (t) => {
  const d = new Date(t);
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

export function liveCaption(state, st) {
  const note = st?.note ? `：${st.note}` : '';
  switch (state) {
    case 'working':
      return `工作中${note}`;
    case 'listening':
      return '在 room wait 等消息（交互会话），@它就开工';
    case 'stopped':
      return '会话窗口开着，但没有在 room wait：群里 @ 它收不到，需要回到窗口让它继续 room wait';
    case 'idle':
      return '空闲，@它就开工';
    case 'error':
      return `出错${note}`;
    case 'quota':
      return `额度用完${st?.until ? `（${untilText(st.until)}）` : ''}。消息会排队，恢复后自动接着干`;
    default:
      if (st?.ended) return `会话已关闭（${clock(st.ended.at)}）：${st.ended.reason}`;
      if (st?.lostAt) return `失去联系（${clock(st.lostAt)} 起）：进程可能被关闭、电脑休眠或断网`;
      return st?.pending ? '离线——有消息等它上线' : '离线';
  }
}

/** 预计恢复时间："预计 15:00 恢复 · 还有 2 小时 5 分" */
export function untilText(until) {
  const left = until - Date.now();
  if (left <= 0) return '正在重试';
  const min = Math.ceil(left / 60_000);
  const rel = min < 60 ? `${min} 分钟` : min < 2880 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${Math.round(min / 1440)} 天`;
  return `预计 ${clock(until)} 恢复 · 还有 ${rel}`;
}
