import { renderModLog } from './views/modlog.js';
import { renderTickets } from './views/tickets.js';
import { renderCases } from './views/cases.js';
import { renderLeaderboard } from './views/leaderboard.js';
import { renderMe } from './views/me.js';
import { renderModCreate } from './views/modcreate.js';
import { renderGsg9 } from './views/gsg9.js';
import { renderDashboard, leaveDashboard } from './views/dashboard.js';
import { refreshIcons, toast } from './views/api.js';
import * as live from '../live.js';
import * as sound from '../sounds.js';
import { resolvedMode } from '../device.js';

const TABS = [
  { id: 'dashboard',   icon: 'layout-dashboard', label: 'Dashboard',   render: renderDashboard, pcOnly: true },
  { id: 'tickets',     icon: 'ticket',           label: 'Tickets',     render: renderTickets },
  { id: 'cases',       icon: 'life-buoy',        label: 'Support',     render: renderCases },
  { id: 'modlog',      icon: 'shield',           label: 'Mod-Log',     render: renderModLog },
  { id: 'modcreate',   icon: 'shield-plus',      label: 'Eintragen',   render: renderModCreate },
  { id: 'leaderboard', icon: 'trophy',           label: 'Top',         render: renderLeaderboard },
  { id: 'gsg9',        icon: 'shield-half',      label: 'GSG9',        render: renderGsg9 },
  { id: 'me',          icon: 'user-round',       label: 'Profil',      render: renderMe },
];

let currentTab = null;
let currentSession = null;

function visibleTabs() {
  const isPC = resolvedMode() === 'pc';
  return TABS.filter(t => isPC || !t.pcOnly);
}

export function renderShell(root, session) {
  currentSession = session;
  const role = session.isAdmin ? 'admin' : session.isStaff ? 'staff' : 'user';
  const roleIcon = role === 'admin' ? 'crown' : role === 'staff' ? 'shield-check' : 'user';
  const tabs = visibleTabs();
  if (!currentTab || !tabs.find(t => t.id === currentTab)) {
    currentTab = tabs[0]?.id || 'tickets';
  }

  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        ${session.avatar
          ? `<img src="${session.avatar}" alt="">`
          : `<div class="avatar-fallback">${esc((session.username || '?').charAt(0).toUpperCase())}</div>`}
        <div class="app-header-info">
          <div class="app-header-name">${esc(session.username || 'Unbekannt')}</div>
          <div class="app-header-sub">Emden Network</div>
        </div>
        <button class="header-btn" id="sound-toggle" title="Sound an/aus">
          <i data-lucide="${sound.isMuted() ? 'volume-x' : 'volume-2'}"></i>
        </button>
        <div class="role-badge ${role}"><i data-lucide="${roleIcon}"></i><span>${role}</span></div>
      </header>
      <nav class="app-tabs" id="tabs">
        ${tabs.map(t => `
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

  document.getElementById('sound-toggle').addEventListener('click', () => {
    sound.setMuted(!sound.isMuted());
    const ic = document.querySelector('#sound-toggle [data-lucide]');
    if (ic) ic.setAttribute('data-lucide', sound.isMuted() ? 'volume-x' : 'volume-2');
    refreshIcons();
    toast(sound.isMuted() ? 'Sound stumm' : 'Sound an', '');
    if (!sound.isMuted()) sound.play();
  });

  // Live-Updates starten
  live.start(session);
  // Live-Notifications: Toast + Sound bei neuen Tickets/Cases
  live.on('ticket:new', (t) => {
    toast(`Neues Ticket: #${t.channelName}`, 'success');
    sound.play();
  });
  live.on('case:new', (c) => {
    toast(`Neuer Support-Case: ${c.username}`, 'success');
    sound.play();
  });

  // Bei Mode-Wechsel (resize zwischen handy/pc bei "auto") neu rendern
  window.addEventListener('en:modechange', () => {
    renderShell(root, currentSession);
  });

  switchTab(currentTab);
}

function switchTab(tabId) {
  if (currentTab === 'dashboard' && tabId !== 'dashboard') {
    try { leaveDashboard(); } catch(_) {}
  }
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
