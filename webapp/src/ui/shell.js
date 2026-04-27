import { renderModLog } from './views/modlog.js';
import { renderTickets } from './views/tickets.js';
import { renderCases } from './views/cases.js';
import { renderLeaderboard } from './views/leaderboard.js';
import { renderMe } from './views/me.js';
import { renderModCreate } from './views/modcreate.js';
import { refreshIcons } from './views/api.js';

const TABS = [
  { id: 'tickets',     icon: 'ticket',          label: 'Tickets',     render: renderTickets },
  { id: 'cases',       icon: 'life-buoy',       label: 'Support',     render: renderCases },
  { id: 'modlog',      icon: 'shield',          label: 'Mod-Log',     render: renderModLog },
  { id: 'modcreate',   icon: 'shield-plus',     label: 'Eintragen',   render: renderModCreate },
  { id: 'leaderboard', icon: 'trophy',          label: 'Top',         render: renderLeaderboard },
  { id: 'me',          icon: 'user-round',      label: 'Profil',      render: renderMe },
];

let currentTab = 'tickets';
let currentSession = null;

export function renderShell(root, session) {
  currentSession = session;
  const role = session.isAdmin ? 'admin' : session.isStaff ? 'staff' : 'user';
  const roleIcon = role === 'admin' ? 'crown' : role === 'staff' ? 'shield-check' : 'user';
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        ${session.avatar
          ? `<img src="${session.avatar}" alt="">`
          : `<div class="avatar-fallback">${esc((session.username || '?').charAt(0).toUpperCase())}</div>`}
        <div class="app-header-info">
          <div class="app-header-name">${esc(session.username || 'Unbekannt')}</div>
          <div class="app-header-sub">Emden Network · ${role.toUpperCase()}</div>
        </div>
        <div class="role-badge ${role}"><i data-lucide="${roleIcon}"></i><span>${role}</span></div>
      </header>
      <nav class="app-tabs" id="tabs">
        ${TABS.map(t => `
          <button class="app-tab" data-tab="${t.id}">
            <i data-lucide="${t.icon}"></i>
            <span>${t.label}</span>
          </button>
        `).join('')}
      </nav>
      <main class="app-main" id="main">
        <div class="loading"><div class="spinner"></div><span>Lade...</span></div>
      </main>
    </div>`;

  refreshIcons();

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.app-tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  switchTab(currentTab);
}

function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.app-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  const main = document.getElementById('main');
  main.innerHTML = `<div class="loading"><div class="spinner"></div><span>Lade...</span></div>`;
  refreshIcons();
  const tab = TABS.find(t => t.id === tabId);
  if (tab) tab.render(main, currentSession);
}

export function getCurrentSession() { return currentSession; }

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
