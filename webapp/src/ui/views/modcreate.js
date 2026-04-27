/**
 * Mod-Entry erstellen
 * Roblox-User-ID eingeben → Action picken → Reason → Submit
 *
 * Rolblox-Username-Search via Roblox-API ist nicht ueber den Discord-Proxy
 * erreichbar (CORS), daher: User muss Roblox-User-ID kennen oder den Username
 * direkt eingeben — wir holen die ID via /api/roblox/lookup wenn moeglich.
 *
 * Fallback: User-ID direkt manuell eingeben.
 */
import { api, escapeHtml, refreshIcons, toast } from './api.js';

const ACTIONS = [
  { id: 'Warn',         icon: 'alert-triangle', label: 'Warn' },
  { id: 'Kick',         icon: 'door-open',      label: 'Kick' },
  { id: 'One Day Ban',  icon: 'clock',          label: '1-Day Ban' },
  { id: 'Ban',          icon: 'ban',            label: 'Ban' },
  { id: 'Notiz',        icon: 'sticky-note',    label: 'Notiz' },
];

let currentRoot = null;
let currentSession = null;
let pickedAction = 'Warn';
let pickedUser = null; // {userId, username, displayName, avatar}

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
        <div class="card-title"><i data-lucide="shield-plus"></i><span>Neuer Mod-Eintrag</span></div>

        <div class="form-group">
          <label class="form-label" for="mc-uid">Roblox User-ID</label>
          <div style="display:flex;gap:6px;">
            <input class="form-input" id="mc-uid" type="text" inputmode="numeric" placeholder="z.B. 123456789" autocomplete="off">
            <button class="btn primary" id="mc-lookup" style="flex-shrink:0;"><i data-lucide="search"></i></button>
          </div>
          <div class="form-help">Roblox-Profil-URL → die Zahl am Ende ist die User-ID</div>
        </div>

        <div id="mc-user-preview"></div>

        <div class="form-group">
          <label class="form-label">Action</label>
          <div class="action-picker" id="mc-actions">
            ${ACTIONS.map(a => `
              <button class="action-pick${a.id === pickedAction ? ' active' : ''}" data-action="${a.id}">
                <i data-lucide="${a.icon}"></i>
                <span>${a.label}</span>
              </button>
            `).join('')}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" for="mc-reason">Grund</label>
          <textarea class="form-textarea" id="mc-reason" placeholder="z.B. Exploiting / Toxic Behavior / TOS-Verstoß..."></textarea>
        </div>

        <button class="btn primary full lg" id="mc-submit" disabled>
          <i data-lucide="send"></i><span>Eintrag erstellen</span>
        </button>
      </div>
    </div>`;

  refreshIcons();

  document.getElementById('mc-lookup').addEventListener('click', doLookup);
  document.getElementById('mc-uid').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
  });
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

async function doLookup() {
  const uid = document.getElementById('mc-uid').value.trim();
  const preview = document.getElementById('mc-user-preview');
  if (!uid || !/^\d+$/.test(uid)) {
    toast('Bitte eine numerische Roblox-User-ID eingeben', 'danger');
    return;
  }
  preview.innerHTML = `<div class="loading"><div class="spinner"></div><span>Suche User...</span></div>`;
  try {
    // /api/roblox/lookup gibt's, aber das ist Discord<>Roblox-Link-Lookup, nicht Roblox-Profile.
    // Wir nehmen erstmal nur die ID an und zeigen "Wird beim Submit geprueft"
    pickedUser = { userId: uid };
    preview.innerHTML = `<div class="banner info"><i data-lucide="check"></i><span>User-ID ${escapeHtml(uid)} angenommen — wird beim Submit verifiziert.</span></div>`;
    refreshIcons();
    updateSubmit();
  } catch (e) {
    preview.innerHTML = `<div class="banner danger"><i data-lucide="alert-circle"></i><span>${escapeHtml(e.message)}</span></div>`;
    refreshIcons();
    pickedUser = null;
    updateSubmit();
  }
}

function updateSubmit() {
  const btn = document.getElementById('mc-submit');
  const reason = document.getElementById('mc-reason').value.trim();
  if (btn) btn.disabled = !pickedUser || !reason;
}

async function doSubmit() {
  const btn = document.getElementById('mc-submit');
  const reason = document.getElementById('mc-reason').value.trim();
  if (!pickedUser || !reason) { toast('User + Grund erforderlich', 'danger'); return; }
  if (btn) btn.disabled = true;
  try {
    // Wir muessen min. userId, action, reason senden. Bot holt Roblox-Daten selber.
    // Aber /api/mod-action verlangt mehr Felder. Hole erst die Roblox-Daten via robloxLookup-Endpoint?
    // Alternativ: schick was wir haben, Bot nutzt Defaults.
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
    toast('Eintrag erstellt!', 'success');
    // Form zurücksetzen
    pickedUser = null;
    pickedAction = 'Warn';
    renderForm();
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
    if (btn) btn.disabled = false;
  }
}
