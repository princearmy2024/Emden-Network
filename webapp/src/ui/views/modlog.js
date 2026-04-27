/**
 * Mod-Log View — letzte Mod-Einträge
 */
import { api, escapeHtml, timeAgo, refreshIcons, setLoading, setEmpty, setError } from './api.js';

const ACTION_ICONS = {
  'Ban':         { icon: 'ban',          tone: 'red' },
  'One Day Ban': { icon: 'clock',        tone: 'red' },
  'Kick':        { icon: 'door-open',    tone: 'amber' },
  'Warn':        { icon: 'alert-triangle', tone: 'amber' },
  'Notiz':       { icon: 'sticky-note',  tone: '' },
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
      ${log.map(itemHtml).join('')}
    </div>`;
    refreshIcons();
  } catch (e) {
    setError(root, e.message);
  }
}

function itemHtml(e) {
  const ai = ACTION_ICONS[e.action] || { icon: 'shield', tone: '' };
  const dateStr = e.date ? new Date(e.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '';
  return `<div class="list-item no-hover">
    <div class="li-icon ${ai.tone}"><i data-lucide="${ai.icon}"></i></div>
    <div class="li-body">
      <div class="li-title">${escapeHtml(e.action)} · ${escapeHtml(e.displayName || 'Unbekannt')}</div>
      <div class="li-meta">${escapeHtml((e.reason || '').slice(0, 60))} · ${escapeHtml(e.moderator || '?')} · ${dateStr}</div>
    </div>
  </div>`;
}
