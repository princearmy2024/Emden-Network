/**
 * Mod-Eintrag erstellen — Live-Roblox-Search + Avatar-Preview + Action + Reason
 *
 * UX-Flow:
 *  1. User tippt Username/Display-Name → debounced search → Vorschlagliste mit Avatars
 *  2. Tap auf Vorschlag → User ausgewählt, Avatar + Display-Name gross angezeigt
 *  3. Action picken (mit Icons)
 *  4. Reason
 *  5. Submit
 */
import { api, escapeHtml, refreshIcons, toast } from './api.js';

const ACTIONS = [
  { id: 'Warn',         icon: 'alert-triangle', label: 'Warn',     tone: 'amber' },
  { id: 'Kick',         icon: 'door-open',      label: 'Kick',     tone: 'amber' },
  { id: 'One Day Ban',  icon: 'clock',          label: '1-Day Ban', tone: 'red' },
  { id: 'Ban',          icon: 'ban',            label: 'Ban',      tone: 'red' },
  { id: 'Notiz',        icon: 'sticky-note',    label: 'Notiz',    tone: '' },
];

let currentRoot = null;
let currentSession = null;
let pickedAction = 'Warn';
let pickedUser = null; // { userId, username, displayName, avatar }
let searchTimer = null;
let lastQuery = '';

export async function renderModCreate(root, session) {
  currentRoot = root;
  currentSession = session;
  pickedAction = 'Warn';
  pickedUser = null;
  renderForm();
}

function renderForm() {
  currentRoot.innerHTML = `
    <div class="detail-view">
      <div class="card">
        <div class="card-title"><i data-lucide="user-search"></i><span>Roblox-User suchen</span></div>

        <div class="form-group" style="position:relative;">
          <input class="form-input" id="mc-search" type="text" placeholder="Username oder Display-Name eingeben..." autocomplete="off">
          <div id="mc-results" style="margin-top:8px;"></div>
        </div>

        <div id="mc-user-card"></div>
      </div>

      <div class="card" id="mc-action-card" style="display:none;">
        <div class="card-title"><i data-lucide="shield-plus"></i><span>Action</span></div>
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
    </div>`;

  refreshIcons();

  const search = document.getElementById('mc-search');
  search.addEventListener('input', (e) => onSearch(e.target.value));
  search.focus();

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
  results.innerHTML = `<div class="loading" style="padding:14px;"><div class="spinner"></div><span>Suche...</span></div>`;
  refreshIcons();

  searchTimer = setTimeout(async () => {
    if (q === lastQuery) return;
    lastQuery = q;
    try {
      // Numerische ID? Direkter Lookup
      if (/^\d+$/.test(q)) {
        results.innerHTML = `<div class="list-item" data-uid="${escapeHtml(q)}">
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
        results.innerHTML = `<div class="empty" style="padding:14px;"><i data-lucide="search-x"></i><span>Keine Treffer</span></div>`;
        refreshIcons();
        return;
      }
      results.innerHTML = users.map(u => `
        <div class="list-item" data-uid="${escapeHtml(u.userId)}" data-uname="${escapeHtml(u.username)}" data-dname="${escapeHtml(u.displayName)}" data-avatar="${escapeHtml(u.avatar || '')}">
          ${u.avatar ? `<img class="li-avatar" src="${escapeHtml(u.avatar)}" alt="">` : `<div class="li-avatar">?</div>`}
          <div class="li-body">
            <div class="li-title">${escapeHtml(u.displayName)}</div>
            <div class="li-meta">@${escapeHtml(u.username)} · ${escapeHtml(u.userId)}</div>
          </div>
          <i data-lucide="chevron-right" class="li-chevron"></i>
        </div>
      `).join('');
      refreshIcons();
      attachResultClicks();
    } catch (e) {
      results.innerHTML = `<div class="banner danger"><i data-lucide="alert-circle"></i><span>${escapeHtml(e.message)}</span></div>`;
      refreshIcons();
    }
  }, 350);
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
    <div class="banner info" style="margin-top:14px;">
      ${u.avatar ? `<img src="${escapeHtml(u.avatar)}" style="width:36px;height:36px;border-radius:50%;border:1px solid var(--border-strong);">` : `<i data-lucide="user"></i>`}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;color:var(--text);">${escapeHtml(u.displayName || u.username || 'Unbekannt')}</div>
        <div style="font-size:11px;color:var(--text-dim);">@${escapeHtml(u.username || '?')} · ID ${escapeHtml(u.userId)}</div>
      </div>
      <button class="btn sm" id="mc-clear-user"><i data-lucide="x"></i></button>
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
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
    if (btn) btn.disabled = false;
  }
}
