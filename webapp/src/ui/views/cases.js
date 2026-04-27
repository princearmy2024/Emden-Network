import { api, escapeHtml, timeAgo } from './api.js';

export async function renderCases(root, session) {
  root.innerHTML = '<div class="loading">Lade Support-Cases...</div>';
  try {
    const d = await api(`/support-cases/open?discordId=${encodeURIComponent(session.discordId)}`);
    const cases = d.cases || [];
    if (cases.length === 0) {
      root.innerHTML = '<div class="empty">Keine offenen Cases</div>';
      return;
    }
    root.innerHTML = `<div class="card">
      <div class="card-title">Offene Cases · ${cases.length}</div>
      ${cases.map(c => `
        <div class="list-item">
          ${c.avatarUrl ? `<img src="${escapeHtml(c.avatarUrl)}" alt="">` : `<div class="avatar-fallback">${escapeHtml((c.username||'?').charAt(0).toUpperCase())}</div>`}
          <div class="list-item-body">
            <div class="list-item-title">${escapeHtml(c.username || 'Unbekannt')}</div>
            <div class="list-item-meta">#S-${escapeHtml(c.caseId)} · ${timeAgo(c.createdAt)}</div>
          </div>
          <span class="list-item-tag">${escapeHtml(c.status)}</span>
        </div>
      `).join('')}
    </div>`;
  } catch (e) {
    root.innerHTML = `<div class="empty">Fehler: ${escapeHtml(e.message || String(e))}</div>`;
  }
}
