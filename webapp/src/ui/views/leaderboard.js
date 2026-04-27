import { api, escapeHtml } from './api.js';

function fmtMs(ms) {
  if (!ms || ms < 0) return '0s';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return Math.floor((ms % 60000) / 1000) + 's';
}

export async function renderLeaderboard(root, session) {
  root.innerHTML = '<div class="loading">Lade Leaderboard...</div>';
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
      root.innerHTML = '<div class="empty">Keine Daten</div>';
      return;
    }
    const stateIcon = (s) => s === 'active' ? '🟢' : s === 'break' ? '🟡' : '⚫';
    root.innerHTML = `<div class="card">
      <div class="card-title">🏆 Top 25</div>
      ${rows.map((r, i) => `
        <div class="list-item">
          ${r.avatar ? `<img src="${escapeHtml(r.avatar)}" alt="">` : `<div class="avatar-fallback">${i + 1}</div>`}
          <div class="list-item-body">
            <div class="list-item-title">${stateIcon(r.state)} #${i + 1} ${escapeHtml(r.username)}</div>
            <div class="list-item-meta">${fmtMs(r.totalMs)}</div>
          </div>
        </div>
      `).join('')}
    </div>`;
  } catch (e) {
    root.innerHTML = `<div class="empty">Fehler: ${escapeHtml(e.message || String(e))}</div>`;
  }
}
