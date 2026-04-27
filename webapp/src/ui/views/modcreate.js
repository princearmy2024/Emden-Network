/**
 * Mod-Eintrag erstellen — mit Live-Roblox-Search + Live-History
 *
 * Layout:
 *  - Oben: Suche → Form
 *  - Unten: Live-Feed der letzten 10 Mod-Aktionen (zeigt wer was eingetragen hat)
 */
import { api, escapeHtml, timeAgo, refreshIcons, toast } from './api.js';

const ACTIONS = [
  { id: 'Warn',         icon: 'alert-triangle', label: 'Warn' },
  { id: 'Kick',         icon: 'door-open',      label: 'Kick' },
  { id: 'One Day Ban',  icon: 'clock',          label: '1-Day' },
  { id: 'Ban',          icon: 'ban',            label: 'Ban' },
  { id: 'Notiz',        icon: 'sticky-note',    label: 'Notiz' },
];

const ACTION_TONES = {
  'Ban': 'danger', 'One Day Ban': 'danger',
  'Kick': 'warn', 'Warn': 'warn', 'Notiz': '',
};

let currentRoot = null;
let currentSession = null;
let pickedAction = 'Warn';
let pickedUser = null;
let searchTimer = null;
let lastQuery = '';
let historyInterval = null;

export async function renderModCreate(root, session) {
  currentRoot = root;
  currentSession = session;
  pickedAction = 'Warn';
  pickedUser = null;
  if (historyInterval) { clearInterval(historyInterval); historyInterval = null; }
  renderForm();
  loadHistory();
  // Live-Refresh History alle 10s
  historyInterval = setInterval(loadHistory, 10000);
}

function renderForm() {
  currentRoot.innerHTML = `
    <div class="detail-view">
      <div class="card">
        <div class="card-title"><i data-lucide="user-search"></i><span>Roblox-User suchen</span></div>

        <div class="form-group" style="position:relative;margin-bottom:8px;">
          <input class="form-input" id="mc-search" type="text" placeholder="Username, Display-Name oder ID..." autocomplete="off">
        </div>
        <div id="mc-results" style="margin-top:0;"></div>
        <div id="mc-user-card"></div>
      </div>

      <div class="card" id="mc-action-card" style="display:none;">
        <div class="card-title"><i data-lucide="shield-plus"></i><span>Action wählen</span></div>
        <div class="action-picker" id="mc-actions">
          ${ACTIONS.map(a => `
            <button class="action-pick${a.id === pickedAction ? ' active' : ''}" data-action="${a.id}">
              <i data-lucide="${a.icon}"></i>
              <span>${a.label}</span>
            </button>
          `).join('')}
        </div>

        <div class="form-group" style="margin-top:14px;">
          <label class="form-label">Grund / Reason</label>
          <textarea class="form-textarea" id="mc-reason" placeholder="z.B. Exploiting / Toxic / TOS-Verstoß..."></textarea>
        </div>

        <button class="btn primary full lg" id="mc-submit" disabled>
          <i data-lucide="send"></i><span>Eintrag erstellen</span>
        </button>
      </div>

      <div class="card" id="mc-history">
        <div class="card-title">
          <i data-lucide="history"></i>
          <span>Letzte Einträge</span>
          <span style="margin-left:auto;font-size:9px;color:var(--text-muted);font-weight:600;">LIVE</span>
        </div>
        <div id="mc-history-list" style="display:flex;flex-direction:column;gap:6px;">
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </div>
    </div>`;

  refreshIcons();

  const search = document.getElementById('mc-search');
  search.addEventListener('input', (e) => onSearch(e.target.value));

  document.querySelectorAll('#mc-actions .action-pick').forEach(b => {
    b.addEventListener('click', () => {
      pickedAction = b.dataset.action;
      document.querySelectorAll('#mc-actions .action-pick').forEach(x => {
        x.classList.toggle('active', x.dataset.action === pickedAction);
      });
    });
  });
  document.getElementById('mc-reason').addEventListener('input', updateSubmit);
  document.getElementById('mc-submit').addEventListener('click', doSubmit);
}

function onSearch(q) {
  q = q.trim();
  if (searchTimer) clearTimeout(searchTimer);
  const results = document.getElementById('mc-results');

  if (q.length < 2) {
    results.innerHTML = '';
    return;
  }
  results.innerHTML = `<div style="padding:10px;font-size:11px;color:var(--text-muted);display:flex;align-items:center;gap:8px;"><div class="spinner" style="width:14px;height:14px;"></div><span>Suche...</span></div>`;

  searchTimer = setTimeout(async () => {
    if (q === lastQuery) return;
    lastQuery = q;
    try {
      // Numerische ID → direkter Lookup
      if (/^\d+$/.test(q)) {
        results.innerHTML = `<div class="list-item" data-uid="${escapeHtml(q)}" style="margin-top:6px;">
          <div class="li-icon"><i data-lucide="hash"></i></div>
          <div class="li-body">
            <div class="li-title">User-ID: ${escapeHtml(q)}</div>
            <div class="li-meta">Direkter ID-Lookup</div>
          </div>
          <i data-lucide="chevron-right" class="li-chevron"></i>
        </div>`;
        refreshIcons();
        attachResultClicks();
        return;
      }

      const d = await api(`/roblox/search?q=${encodeURIComponent(q)}`);
      const users = d.users || [];
      if (users.length === 0) {
        results.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:12px;display:flex;align-items:center;justify-content:center;gap:8px;"><i data-lucide="search-x"></i><span>Keine Treffer für "${escapeHtml(q)}"</span></div>`;
        refreshIcons();
        return;
      }
      results.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;">${users.map(u => `
        <div class="list-item" data-uid="${escapeHtml(u.userId)}" data-uname="${escapeHtml(u.username)}" data-dname="${escapeHtml(u.displayName)}" data-avatar="${escapeHtml(u.avatar || '')}">
          ${u.avatar ? `<img class="li-avatar" src="${escapeHtml(u.avatar)}" alt="">` : `<div class="li-avatar">?</div>`}
          <div class="li-body">
            <div class="li-title">${escapeHtml(u.displayName)}</div>
            <div class="li-meta">@${escapeHtml(u.username)} · ID ${escapeHtml(u.userId)}</div>
          </div>
          <i data-lucide="chevron-right" class="li-chevron"></i>
        </div>
      `).join('')}</div>`;
      refreshIcons();
      attachResultClicks();
    } catch (e) {
      results.innerHTML = `<div class="banner danger" style="margin-top:8px;"><i data-lucide="alert-circle"></i><span>${escapeHtml(e.message)}</span></div>`;
      refreshIcons();
    }
  }, 300);
}

function attachResultClicks() {
  document.querySelectorAll('#mc-results [data-uid]').forEach(el => {
    el.addEventListener('click', () => pickUser({
      userId: el.dataset.uid,
      username: el.dataset.uname || '',
      displayName: el.dataset.dname || '',
      avatar: el.dataset.avatar || '',
    }));
  });
}

function pickUser(u) {
  pickedUser = u;
  document.getElementById('mc-search').value = u.displayName || u.username || u.userId;
  document.getElementById('mc-results').innerHTML = '';
  const card = document.getElementById('mc-user-card');
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:12px;margin-top:10px;background:rgba(91,154,255,.08);border:1px solid rgba(91,154,255,.25);border-radius:10px;">
      ${u.avatar ? `<img src="${escapeHtml(u.avatar)}" style="width:48px;height:48px;border-radius:50%;border:1px solid var(--border-strong);object-fit:cover;">` : `<div class="li-avatar" style="width:48px;height:48px;font-size:18px;">?</div>`}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:800;color:var(--text);font-size:14px;">${escapeHtml(u.displayName || u.username || 'Unbekannt')}</div>
        <div style="font-size:11px;color:var(--text-dim);">@${escapeHtml(u.username || '?')} · ID ${escapeHtml(u.userId)}</div>
      </div>
      <button class="btn icon-only sm" id="mc-clear-user" title="Auswahl löschen"><i data-lucide="x"></i></button>
    </div>`;
  document.getElementById('mc-action-card').style.display = '';
  refreshIcons();
  document.getElementById('mc-clear-user').addEventListener('click', () => {
    pickedUser = null;
    card.innerHTML = '';
    document.getElementById('mc-action-card').style.display = 'none';
    document.getElementById('mc-search').value = '';
    document.getElementById('mc-search').focus();
    updateSubmit();
  });
  updateSubmit();
}

function updateSubmit() {
  const btn = document.getElementById('mc-submit');
  if (!btn) return;
  const reason = document.getElementById('mc-reason')?.value?.trim() || '';
  btn.disabled = !pickedUser || !reason;
}

async function doSubmit() {
  const btn = document.getElementById('mc-submit');
  const reason = document.getElementById('mc-reason').value.trim();
  if (!pickedUser || !reason) { toast('User + Grund erforderlich', 'danger'); return; }
  if (btn) btn.disabled = true;
  try {
    const body = {
      userId: pickedUser.userId,
      username: pickedUser.username || '',
      displayName: pickedUser.displayName || pickedUser.username || '',
      avatar: pickedUser.avatar || '',
      created: '',
      action: pickedAction,
      reason,
      moderator: currentSession.username,
      moderatorDiscordId: currentSession.discordId,
      moderatorAvatar: currentSession.avatar || '',
    };
    if (pickedAction === 'Notiz') body.notiz = reason;
    await api('/mod-action', { method: 'POST', body });
    toast(`${pickedAction} für ${pickedUser.displayName || pickedUser.username} erstellt`, 'success');
    pickedUser = null;
    pickedAction = 'Warn';
    renderForm();
    loadHistory();
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
    if (btn) btn.disabled = false;
  }
}

// ─── Live-History unter dem Formular ───────────────────
async function loadHistory() {
  const list = document.getElementById('mc-history-list');
  if (!list) return;
  try {
    const d = await api(`/mod-log?discordId=${encodeURIComponent(currentSession.discordId)}&limit=10`);
    const log = d.log || [];
    if (log.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:14px;color:var(--text-muted);font-size:11px;">Keine Einträge</div>`;
      return;
    }
    list.innerHTML = log.map(historyItemHtml).join('');
    refreshIcons();
  } catch(e) {
    // Silent fail — history ist nice-to-have
  }
}

function historyItemHtml(e) {
  const tone = ACTION_TONES[e.action] || '';
  const dateStr = e.date ? new Date(e.date).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  const tagClass = tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : '';
  const targetAva = e.targetAvatar
    ? `<img class="li-avatar" style="width:30px;height:30px;" src="${escapeHtml(e.targetAvatar)}" alt="">`
    : `<div class="li-avatar" style="width:30px;height:30px;font-size:11px;">${escapeHtml((e.displayName || '?').charAt(0).toUpperCase())}</div>`;
  return `<div class="list-item no-hover" style="padding:8px;">
    ${targetAva}
    <div class="li-body">
      <div class="li-title" style="font-size:12px;display:flex;align-items:center;gap:6px;">
        <span>${escapeHtml(e.displayName || 'Unbekannt')}</span>
        <span class="li-tag ${tagClass}" style="font-size:8px;padding:2px 6px;">${escapeHtml(e.action)}</span>
      </div>
      <div style="font-size:10px;color:var(--text-muted);display:flex;align-items:center;gap:5px;margin-top:2px;">
        ${e.moderatorAvatar ? `<img src="${escapeHtml(e.moderatorAvatar)}" style="width:12px;height:12px;border-radius:50%;">` : ''}
        <span>${escapeHtml(e.moderator || '?')}</span>
        <span>·</span>
        <span>${dateStr}</span>
      </div>
    </div>
  </div>`;
}
