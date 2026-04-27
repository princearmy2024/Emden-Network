/**
 * Leaderboard View — Top 25 Staff nach Shift-Zeit
 */
import { api, escapeHtml, fmtDuration, refreshIcons, setLoading, setEmpty, setError } from './api.js';

export async function renderLeaderboard(root, session) {
  setLoading(root, 'Lade Leaderboard...');
  try {
    const d = await api(`/shifts?discordId=${encodeURIComponent(session.discordId)}`);
    const shifts = d.shifts || {};
    const lb = d.leaderboard || {};
    const rows = Object.entries(lb)
      .map(([id, l]) => ({
        id,
        username: l.username || '?',
        avatar: l.avatar || '',
        totalMs: (l.totalMs || 0) + (shifts[id]?.savedMs || 0),
        state: shifts[id]?.state || 'off',
      }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 25);

    if (rows.length === 0) {
      setEmpty(root, 'trophy', 'Keine Daten');
      return;
    }
    root.innerHTML = `<div class="card">
      <div class="card-title"><i data-lucide="trophy"></i><span>Top ${rows.length}</span></div>
      ${rows.map((r, i) => itemHtml(r, i + 1, session.discordId === r.id)).join('')}
    </div>`;
    refreshIcons();
  } catch (e) {
    setError(root, e.message);
  }
}

function itemHtml(r, rank, isMe) {
  const stateIcon = r.state === 'active' ? '<i data-lucide="circle-dot" style="color:var(--success);"></i>'
    : r.state === 'break' ? '<i data-lucide="pause" style="color:var(--warn);"></i>'
    : '<i data-lucide="moon" style="color:var(--text-muted);"></i>';
  const ava = r.avatar
    ? `<img class="li-avatar" src="${escapeHtml(r.avatar)}" alt="">`
    : `<div class="li-avatar">${rank}</div>`;
  const rankIcon = rank === 1 ? '<i data-lucide="crown" style="color:#fbbf24;"></i>'
    : rank === 2 ? '<i data-lucide="medal" style="color:#cbd5e1;"></i>'
    : rank === 3 ? '<i data-lucide="medal" style="color:#cd7f32;"></i>'
    : `<span style="color:var(--text-muted);font-weight:700;">#${rank}</span>`;
  return `<div class="list-item no-hover${isMe ? ' mine' : ''}">
    <div style="display:flex;align-items:center;justify-content:center;width:28px;flex-shrink:0;">${rankIcon}</div>
    ${ava}
    <div class="li-body">
      <div class="li-title">${escapeHtml(r.username)}</div>
      <div class="li-meta">${stateIcon} <span>${fmtDuration(r.totalMs)}</span></div>
    </div>
  </div>`;
}
