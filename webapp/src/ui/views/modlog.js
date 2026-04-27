/**
 * Mod-Log View — Letzte Mod-Einträge mit Roblox-Avatars und Action-Icons
 */
import { api, escapeHtml, timeAgo, refreshIcons, setLoading, setEmpty, setError } from './api.js';

const ACTION_META = {
  'Ban':         { icon: 'ban',             tone: 'red',   label: 'Ban' },
  'One Day Ban': { icon: 'clock-alert',     tone: 'red',   label: '1-Day' },
  'Kick':        { icon: 'door-open',       tone: 'amber', label: 'Kick' },
  'Warn':        { icon: 'alert-triangle',  tone: 'amber', label: 'Warn' },
  'Notiz':       { icon: 'sticky-note',     tone: '',      label: 'Notiz' },
};

export async function renderModLog(root, session) {
  setLoading(root, 'Lade Mod-Log...');
  try {
    const d = await api(`/mod-log?discordId=${encodeURIComponent(session.discordId)}&limit=40`);
    const log = d.log || [];
    if (log.length === 0) {
      setEmpty(root, 'shield', 'Keine Einträge');
      return;
    }
    root.innerHTML = `<div class="card">
      <div class="card-title"><i data-lucide="shield"></i><span>Letzte Einträge · ${log.length}</span></div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${log.map(itemHtml).join('')}
      </div>
    </div>`;
    refreshIcons();
  } catch (e) {
    setError(root, e.message);
  }
}

function itemHtml(e) {
  const meta = ACTION_META[e.action] || { icon: 'shield', tone: '', label: e.action };
  const dateStr = e.date ? new Date(e.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
  const timeStr = e.date ? new Date(e.date).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  const avatar = e.targetAvatar
    ? `<img class="li-avatar" src="${escapeHtml(e.targetAvatar)}" alt="">`
    : `<div class="li-avatar">${escapeHtml((e.displayName || '?').charAt(0).toUpperCase())}</div>`;
  return `<div class="list-item no-hover" style="position:relative;">
    ${avatar}
    <div class="li-body">
      <div class="li-title" style="display:flex;align-items:center;gap:6px;">
        <span>${escapeHtml(e.displayName || 'Unbekannt')}</span>
        <span class="li-tag ${meta.tone === 'red' ? 'danger' : meta.tone === 'amber' ? 'warn' : ''}" style="font-size:8px;padding:2px 6px;">
          ${escapeHtml(meta.label)}
        </span>
      </div>
      <div class="li-meta" title="${escapeHtml(e.reason || '')}">${escapeHtml((e.reason || 'Kein Grund').slice(0, 60))}</div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:3px;display:flex;align-items:center;gap:6px;">
        ${e.moderatorAvatar
          ? `<img src="${escapeHtml(e.moderatorAvatar)}" style="width:14px;height:14px;border-radius:50%;">`
          : `<i data-lucide="user" style="width:11px;height:11px;"></i>`}
        <span>${escapeHtml(e.moderator || '?')}</span>
        <span>·</span>
        <span>${dateStr} ${timeStr}</span>
      </div>
    </div>
    <div class="li-icon ${meta.tone}" style="width:32px;height:32px;"><i data-lucide="${meta.icon}"></i></div>
  </div>`;
}
