/**
 * GSG9 Team View — Mitglieder pro Rolle + Roblox-Verknüpfung anzeigen
 */
import { api, escapeHtml, refreshIcons, setLoading, setEmpty, setError, imgUrl } from './api.js';

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
          <span style="width:10px;height:10px;border-radius:50%;background:${escapeHtml(t.color)};display:inline-block;box-shadow:0 0 6px ${escapeHtml(t.color)};"></span>
          <span>${escapeHtml(t.name)}</span>
          <span style="margin-left:auto;font-size:10px;color:var(--text-muted);">${t.members.length}</span>
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
    ? `<span class="li-tag success" style="font-size:8px;padding:2px 6px;">On Duty</span>`
    : '';

  // Roblox-Info-Zeile bauen
  let robloxLine = '';
  if (m.robloxDisplayName || m.robloxUsername) {
    const display = m.robloxDisplayName || m.robloxUsername;
    const handle = m.robloxUsername ? '@' + m.robloxUsername : '';
    robloxLine = `<div style="font-size:10px;color:var(--accent);display:flex;align-items:center;gap:4px;margin-top:2px;">
      <i data-lucide="gamepad-2" style="width:10px;height:10px;"></i>
      <span>${escapeHtml(display)}</span>
      ${handle ? `<span style="color:var(--text-muted);">${escapeHtml(handle)}</span>` : ''}
    </div>`;
  } else if (m.robloxId) {
    robloxLine = `<div style="font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:4px;margin-top:2px;">
      <i data-lucide="gamepad-2" style="width:10px;height:10px;"></i>
      <span>Roblox-ID: ${escapeHtml(m.robloxId)}</span>
    </div>`;
  } else {
    robloxLine = `<div style="font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:4px;margin-top:2px;">
      <i data-lucide="link-2-off" style="width:10px;height:10px;"></i>
      <span>Keine Roblox-Verknüpfung</span>
    </div>`;
  }

  return `<div class="list-item no-hover">
    <div style="position:relative;flex-shrink:0;">
      ${m.avatar
        ? `<img class="li-avatar" src="${escapeHtml(imgUrl(m.avatar))}" alt="">`
        : `<div class="li-avatar">${escapeHtml((m.username || '?').charAt(0).toUpperCase())}</div>`}
      <span style="position:absolute;bottom:0;right:0;width:11px;height:11px;border-radius:50%;background:${statusColor};border:2px solid var(--bg-1);"></span>
    </div>
    <div class="li-body">
      <div class="li-title">${escapeHtml(m.username)}</div>
      ${robloxLine}
    </div>
    ${dutyTag}
  </div>`;
}
