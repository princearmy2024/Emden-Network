/**
 * Profil + Shift-Controls + Stats
 */
import { api, escapeHtml, fmtDuration, refreshIcons, setError, toast } from './api.js';

let currentRoot = null;
let currentSession = null;
let myShift = null;
let serverNow = Date.now();
let tickInterval = null;

export async function renderMe(root, session) {
  currentRoot = root;
  currentSession = session;
  await load();
}

async function load() {
  // Header rendern, dann Shift live updaten
  renderShell();
  try {
    const d = await api(`/shifts?discordId=${encodeURIComponent(currentSession.discordId)}`);
    myShift = d.shifts?.[currentSession.discordId] || { state: 'off', savedMs: 0, breakMs: 0, startedAt: null, breakStartedAt: null };
    serverNow = d.serverNow || Date.now();
    renderShiftCard();
    renderStreakCard();
    startTick();
  } catch (e) {
    const sc = document.getElementById('me-shift');
    if (sc) sc.innerHTML = `<div class="empty"><i data-lucide="alert-circle" style="color:var(--danger);"></i><span>${escapeHtml(e.message)}</span></div>`;
    refreshIcons();
  }
}

function renderShell() {
  currentRoot.innerHTML = `
    <div class="card">
      <div class="card-title"><i data-lucide="user"></i><span>Profil</span></div>
      <div class="list-item no-hover">
        ${currentSession.avatar
          ? `<img class="li-avatar" src="${escapeHtml(currentSession.avatar)}" alt="">`
          : `<div class="li-avatar">${escapeHtml((currentSession.username || '?').charAt(0).toUpperCase())}</div>`}
        <div class="li-body">
          <div class="li-title">${escapeHtml(currentSession.username || 'Unbekannt')}</div>
          <div class="li-meta">Discord-ID: ${escapeHtml(currentSession.discordId)}</div>
        </div>
        ${currentSession.isAdmin
          ? `<span class="li-tag danger">Admin</span>`
          : currentSession.isStaff ? `<span class="li-tag">Staff</span>` : `<span class="li-tag">User</span>`}
      </div>
    </div>

    <div class="card" id="me-shift">
      <div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div>
      <div class="loading"><div class="spinner"></div></div>
    </div>

    <div class="card" id="me-streak">
      <div class="card-title"><i data-lucide="flame"></i><span>Streak</span></div>
      <div class="empty"><span>—</span></div>
    </div>`;
  refreshIcons();
}

function renderShiftCard() {
  const card = document.getElementById('me-shift');
  if (!card || !myShift) return;
  const state = myShift.state || 'off';
  const stateLabel = state === 'active' ? 'Im Dienst' : state === 'break' ? 'Pause' : 'Offline';
  card.innerHTML = `
    <div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <div class="shift-state ${state}">
        <span class="dot"></span><span>${stateLabel}</span>
      </div>
      <div style="font-size:20px;font-weight:800;font-variant-numeric:tabular-nums;" id="shift-time">${fmtDuration(getCurrentTotal())}</div>
    </div>
    <div class="stat-grid" style="margin-bottom:12px;">
      <div class="stat">
        <div class="stat-label">Gespeichert</div>
        <div class="stat-value small">${fmtDuration(myShift.savedMs || 0)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Pause</div>
        <div class="stat-value small" id="break-time">${fmtDuration(getCurrentBreak())}</div>
      </div>
    </div>
    <div class="action-row">
      ${state === 'off'
        ? `<button class="btn primary full lg" data-act="start"><i data-lucide="play"></i><span>Start</span></button>`
        : state === 'active'
        ? `<button class="btn warn" data-act="pause"><i data-lucide="pause"></i><span>Pause</span></button>
           <button class="btn danger" data-act="end"><i data-lucide="square"></i><span>Beenden</span></button>`
        : `<button class="btn primary" data-act="start"><i data-lucide="play"></i><span>Weiter</span></button>
           <button class="btn danger" data-act="end"><i data-lucide="square"></i><span>Beenden</span></button>`
      }
    </div>`;
  refreshIcons();
  card.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => doAction(b.dataset.act));
  });
}

function getCurrentTotal() {
  if (!myShift) return 0;
  let t = myShift.savedMs || 0;
  if (myShift.state === 'active' && myShift.startedAt) t += Date.now() - myShift.startedAt;
  return t;
}
function getCurrentBreak() {
  if (!myShift) return 0;
  let t = myShift.breakMs || 0;
  if (myShift.state === 'break' && myShift.breakStartedAt) t += Date.now() - myShift.breakStartedAt;
  return t;
}

function startTick() {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    const t = document.getElementById('shift-time');
    const b = document.getElementById('break-time');
    if (!t) { clearInterval(tickInterval); tickInterval = null; return; }
    t.textContent = fmtDuration(getCurrentTotal());
    if (b) b.textContent = fmtDuration(getCurrentBreak());
  }, 1000);
}

async function doAction(action) {
  const path = action === 'start' ? '/shift/start' : action === 'pause' ? '/shift/pause' : '/shift/end';
  try {
    const d = await api(path, {
      method: 'POST',
      body: { discordId: currentSession.discordId },
    });
    myShift = d.shift || myShift;
    renderShiftCard();
    toast(action === 'start' ? 'Shift gestartet' : action === 'pause' ? 'Pause' : 'Shift beendet', 'success');
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}

function renderStreakCard() {
  const card = document.getElementById('me-streak');
  if (!card) return;
  // Lade Streaks (alle, dann meine ausfiltern)
  api(`/streaks?discordId=${encodeURIComponent(currentSession.discordId)}`).then(d => {
    const my = d.streaks?.[currentSession.discordId];
    if (!my) {
      card.innerHTML = `<div class="card-title"><i data-lucide="flame"></i><span>Streak</span></div>
        <div class="empty"><span>Noch keine Streak-Daten</span></div>`;
      refreshIcons();
      return;
    }
    const reqs = d.requirements || {};
    card.innerHTML = `
      <div class="card-title"><i data-lucide="flame"></i><span>Streak</span></div>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#fbbf24,#f59e0b);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#000;">${my.streak || 0}</div>
        <div>
          <div style="font-size:16px;font-weight:800;">${my.streak || 0} Tage</div>
          <div style="font-size:11px;color:var(--text-dim);">Best: ${my.bestStreak || 0} ${my.protected ? '· geschützt' : ''}</div>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat">
          <div class="stat-label">Heute Zeit</div>
          <div class="stat-value small">${fmtDuration(my.todayMs || 0)} / ${fmtDuration(reqs.minMs || 0)}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Heute Einträge</div>
          <div class="stat-value small">${my.todayEntries || 0} / ${reqs.minEntries || 0}</div>
        </div>
      </div>
      ${my.completed ? `<div class="banner success" style="margin-top:10px;"><i data-lucide="check"></i><span>Heute erfüllt!</span></div>` : ''}`;
    refreshIcons();
  }).catch(() => {});
}
