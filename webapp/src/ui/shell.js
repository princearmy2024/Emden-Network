/**
 * App-Shell — Header + Tabs + Main-Content-Area
 * Tabs schalten zwischen Views um (modlog/tickets/cases/leaderboard/me)
 */
import { renderModLog } from './views/modlog.js';
import { renderTickets } from './views/tickets.js';
import { renderCases } from './views/cases.js';
import { renderLeaderboard } from './views/leaderboard.js';
import { renderMe } from './views/me.js';

const TABS = [
  { id: 'tickets',    label: '🎫 Tickets',    render: renderTickets },
  { id: 'cases',      label: '🆘 Support',    render: renderCases },
  { id: 'modlog',     label: '⚖️ Mod-Log',    render: renderModLog },
  { id: 'leaderboard',label: '🏆 Leaderboard',render: renderLeaderboard },
  { id: 'me',         label: '👤 Profil',     render: renderMe },
];

let currentTab = 'tickets';
let currentSession = null;

export function renderShell(root, session) {
  currentSession = session;
  const role = session.isAdmin ? 'admin' : session.isStaff ? 'staff' : 'user';
  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        ${session.avatar ? `<img src="${session.avatar}" alt="">` : `<div class="avatar-fallback">${(session.username || '?').charAt(0).toUpperCase()}</div>`}
        <div class="app-header-info">
          <div class="app-header-name">${escapeHtml(session.username || 'Unbekannt')}</div>
          <div class="app-header-role">Emden Network</div>
        </div>
        <div class="role-badge ${role}">${role}</div>
      </header>
      <nav class="app-tabs" id="tabs">
        ${TABS.map(t => `<button class="app-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
      </nav>
      <main class="app-main" id="main">
        <div class="loading">Lade...</div>
      </main>
    </div>`;

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
  main.innerHTML = '<div class="loading">Lade...</div>';
  const tab = TABS.find(t => t.id === tabId);
  if (tab) tab.render(main, currentSession);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
