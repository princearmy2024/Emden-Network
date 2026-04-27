import { escapeHtml } from './api.js';

export async function renderMe(root, session) {
  root.innerHTML = `<div class="card">
    <div class="card-title">Profil</div>
    <div class="list-item">
      ${session.avatar ? `<img src="${escapeHtml(session.avatar)}" alt="">` : `<div class="avatar-fallback">${escapeHtml((session.username||'?').charAt(0).toUpperCase())}</div>`}
      <div class="list-item-body">
        <div class="list-item-title">${escapeHtml(session.username || 'Unbekannt')}</div>
        <div class="list-item-meta">Discord-ID: ${escapeHtml(session.discordId)}</div>
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-title">Berechtigung</div>
    <div class="list-item">
      <div class="avatar-fallback">${session.isAdmin ? '⚡' : session.isStaff ? '🛡' : '👤'}</div>
      <div class="list-item-body">
        <div class="list-item-title">${session.isAdmin ? 'Administrator' : session.isStaff ? 'Staff (EN-Team)' : 'User'}</div>
        <div class="list-item-meta">Modus: ${escapeHtml(session.mode || 'discord')}</div>
      </div>
    </div>
  </div>`;
}
