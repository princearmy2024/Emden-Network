import { api, escapeHtml, timeAgo } from './api.js';

export async function renderModLog(root, session) {
  root.innerHTML = '<div class="loading">Lade Mod-Log...</div>';
  try {
    const d = await api(`/mod-log?discordId=${encodeURIComponent(session.discordId)}&limit=30`);
    const log = d.log || [];
    if (log.length === 0) {
      root.innerHTML = '<div class="empty">Keine Eintraege</div>';
      return;
    }
    root.innerHTML = `<div class="card">
      <div class="card-title">Letzte Eintraege · ${log.length}</div>
      ${log.map(e => `
        <div class="list-item">
          ${e.moderatorAvatar ? `<img src="${escapeHtml(e.moderatorAvatar)}" alt="">` : `<div class="avatar-fallback">?</div>`}
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(e.action)} · ${escapeHtml(e.displayName || e.moderator || '?')}</div>
            <div class="list-item-meta">${escapeHtml((e.reason || '').slice(0, 80))} · ${timeAgo(new Date(e.date).getTime())}</div>
          </div>
        </div>
      `).join('')}
    </div>`;
  } catch (e) {
    root.innerHTML = `<div class="empty">Fehler: ${escapeHtml(e.message || String(e))}</div>`;
  }
}
