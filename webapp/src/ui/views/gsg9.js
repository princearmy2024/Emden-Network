/**
 * GSG9 Team View — alle Mitglieder + Online/On-Duty-Status
 */
import { api, escapeHtml, refreshIcons, setLoading, setEmpty, setError } from './api.js';

export async function renderGsg9(root, session) {
  setLoading(root, 'Lade GSG9 Team...');
  try {
    const d = await api(`/gsg9`);
    const teams = d.teams || [];
    if (teams.length === 0 || teams.every(t => !t.members?.length)) {
      setEmpty(root, 'users', 'Keine GSG9-Mitglieder');
      return;
    }
    root.innerHTML = teams.map(t => `
      <div class="card">
        <div class="card-title">
          <span style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(t.color)};display:inline-block;"></span>
          <span>${escapeHtml(t.name)} · ${t.members.length}</span>
        </div>
        ${t.members.map(memberHtml).join('')}
      </div>
    `).join('');
    refreshIcons();
  } catch (e) {
    setError(root, e.message);
  }
}

function memberHtml(m) {
  const statusColor = m.status === 'online' ? 'var(--success)'
    : m.status === 'idle' ? 'var(--warn)'
    : m.status === 'dnd' ? 'var(--danger)'
    : 'var(--text-muted)';
  const dutyTag = m.onDuty
    ? `<span class="li-tag success">On Duty</span>`
    : '';
  return `<div class="list-item no-hover">
    <div style="position:relative;flex-shrink:0;">
      ${m.avatar
        ? `<img class="li-avatar" src="${escapeHtml(m.avatar)}" alt="">`
        : `<div class="li-avatar">${escapeHtml((m.username || '?').charAt(0).toUpperCase())}</div>`}
      <span style="position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:50%;background:${statusColor};border:2px solid var(--bg-1);"></span>
    </div>
    <div class="li-body">
      <div class="li-title">${escapeHtml(m.username)}</div>
      <div class="li-meta">${m.robloxId ? 'Roblox: ' + escapeHtml(m.robloxId) : 'Keine Roblox-Verknüpfung'}</div>
    </div>
    ${dutyTag}
  </div>`;
}
