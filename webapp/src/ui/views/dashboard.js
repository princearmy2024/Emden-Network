/**
 * Dashboard — Komplett-Layout (PC):
 *  - Links: Shift-Control + Active-Staff + Mitarbeiter des Monats
 *  - Mitte: Mod-Eintragen (full form with live-history)
 *  - Rechts: Live-Feed (Tickets / Cases / Mod-Einträge)
 *
 * Auf Handy stapeln sich die Spalten untereinander.
 */
import { api, escapeHtml, fmtDuration, refreshIcons, toast, setLoading, imgUrl } from './api.js';
import { renderModCreate } from './modcreate.js';
import * as live from '../../live.js';

let currentRoot = null;
let currentSession = null;
let myShift = null;
let shiftTick = null;
let staffPoll = null;
let feedItems = []; // ring buffer der letzten 30 Events
let unsubs = [];

const FEED_MAX = 30;

export async function renderDashboard(root, session) {
  cleanup();
  currentRoot = root;
  currentSession = session;

  root.innerHTML = `
    <div class="dash-grid">
      <aside class="dash-col dash-left">
        <div class="card" id="dash-shift">
          <div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div>
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div class="card" id="dash-active">
          <div class="card-title"><i data-lucide="users"></i><span>Aktiv im Dienst</span><span class="card-tag" id="dash-active-count">—</span></div>
          <div class="loading"><div class="spinner"></div></div>
        </div>
        <div class="card" id="dash-month">
          <div class="card-title"><i data-lucide="award"></i><span>Top diesen Monat</span></div>
          <div class="loading"><div class="spinner"></div></div>
        </div>
      </aside>

      <section class="dash-col dash-mid" id="dash-mid"></section>

      <aside class="dash-col dash-right">
        <div class="card dash-feed">
          <div class="card-title">
            <i data-lucide="activity"></i><span>Live-Feed</span>
            <span class="card-tag live"><span class="live-dot"></span>LIVE</span>
          </div>
          <div id="dash-feed-list" class="feed-list"></div>
        </div>
      </aside>
    </div>`;
  refreshIcons();

  // Mod-Create direkt in die mittlere Spalte rendern
  const mid = document.getElementById('dash-mid');
  renderModCreate(mid, session);

  // Linke Spalte
  loadShift();
  loadActiveStaff();
  loadMonthTop();
  staffPoll = setInterval(() => { loadActiveStaff(); }, 15000);

  // Rechte Spalte: Live Feed via existierende Polling-Streams
  hookFeed();

  // Initial Backfill aus letzten Mod-Einträgen (damit Feed nicht leer ist)
  backfillFeed();
}

export function leaveDashboard() {
  cleanup();
}

function cleanup() {
  if (shiftTick) { clearInterval(shiftTick); shiftTick = null; }
  if (staffPoll) { clearInterval(staffPoll); staffPoll = null; }
  unsubs.forEach(u => { try { u(); } catch(_) {} });
  unsubs = [];
  feedItems = [];
}

// ─── Shift ──────────────────────────────────────────
async function loadShift() {
  try {
    const d = await api(`/shifts?discordId=${encodeURIComponent(currentSession.discordId)}`);
    myShift = d.shifts?.[currentSession.discordId] || { state: 'off', savedMs: 0, breakMs: 0, startedAt: null, breakStartedAt: null };
    renderShift();
    if (shiftTick) clearInterval(shiftTick);
    shiftTick = setInterval(tickShift, 1000);
  } catch(e) {
    const card = document.getElementById('dash-shift');
    if (card) card.innerHTML = `<div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div><div class="empty"><span>${escapeHtml(e.message)}</span></div>`;
    refreshIcons();
  }
}

function shiftTotal() {
  if (!myShift) return 0;
  let t = myShift.savedMs || 0;
  if (myShift.state === 'active' && myShift.startedAt) t += Date.now() - myShift.startedAt;
  return t;
}
function shiftBreak() {
  if (!myShift) return 0;
  let t = myShift.breakMs || 0;
  if (myShift.state === 'break' && myShift.breakStartedAt) t += Date.now() - myShift.breakStartedAt;
  return t;
}

function renderShift() {
  const card = document.getElementById('dash-shift');
  if (!card || !myShift) return;
  const state = myShift.state || 'off';
  const stateLabel = state === 'active' ? 'Im Dienst' : state === 'break' ? 'Pause' : 'Offline';
  card.innerHTML = `
    <div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div>
    <div class="shift-row">
      <div class="shift-state ${state}"><span class="dot"></span><span>${stateLabel}</span></div>
      <div class="shift-time" id="dash-shift-time">${fmtDuration(shiftTotal())}</div>
    </div>
    <div class="stat-grid" style="margin-bottom:10px;">
      <div class="stat"><div class="stat-label">Gespeichert</div><div class="stat-value small">${fmtDuration(myShift.savedMs || 0)}</div></div>
      <div class="stat"><div class="stat-label">Pause</div><div class="stat-value small" id="dash-shift-break">${fmtDuration(shiftBreak())}</div></div>
    </div>
    <div class="action-row">
      ${state === 'off'
        ? `<button class="btn primary full" data-act="start"><i data-lucide="play"></i><span>Start</span></button>`
        : state === 'active'
        ? `<button class="btn warn" data-act="pause"><i data-lucide="pause"></i><span>Pause</span></button>
           <button class="btn danger" data-act="end"><i data-lucide="square"></i><span>Ende</span></button>`
        : `<button class="btn primary" data-act="start"><i data-lucide="play"></i><span>Weiter</span></button>
           <button class="btn danger" data-act="end"><i data-lucide="square"></i><span>Ende</span></button>`
      }
    </div>`;
  refreshIcons();
  card.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => doShift(b.dataset.act));
  });
}

function tickShift() {
  const t = document.getElementById('dash-shift-time');
  const b = document.getElementById('dash-shift-break');
  if (!t) { if (shiftTick) { clearInterval(shiftTick); shiftTick = null; } return; }
  t.textContent = fmtDuration(shiftTotal());
  if (b) b.textContent = fmtDuration(shiftBreak());
}

async function doShift(action) {
  const path = action === 'start' ? '/shift/start' : action === 'pause' ? '/shift/pause' : '/shift/end';
  try {
    const d = await api(path, { method: 'POST', body: { discordId: currentSession.discordId } });
    myShift = d.shift || myShift;
    renderShift();
    toast(action === 'start' ? 'Shift gestartet' : action === 'pause' ? 'Pause' : 'Shift beendet', 'success');
    loadActiveStaff();
  } catch(e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}

// ─── Active Staff ───────────────────────────────────
async function loadActiveStaff() {
  try {
    const d = await api(`/shifts?discordId=${encodeURIComponent(currentSession.discordId)}`);
    const shifts = d.shifts || {};
    const lb = d.leaderboard || {};
    const active = Object.entries(shifts)
      .filter(([_, s]) => s.state === 'active' || s.state === 'break')
      .map(([id, s]) => ({
        id,
        username: lb[id]?.username || id.slice(-4),
        avatar: lb[id]?.avatar || '',
        state: s.state,
        startedAt: s.startedAt || s.breakStartedAt || Date.now(),
      }))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

    const card = document.getElementById('dash-active');
    if (!card) return;
    const countEl = document.getElementById('dash-active-count');
    if (countEl) countEl.textContent = String(active.length);

    if (active.length === 0) {
      card.innerHTML = `
        <div class="card-title"><i data-lucide="users"></i><span>Aktiv im Dienst</span><span class="card-tag" id="dash-active-count">0</span></div>
        <div class="empty" style="padding:12px;"><i data-lucide="moon"></i><span>Niemand im Dienst</span></div>`;
      refreshIcons();
      return;
    }
    card.innerHTML = `
      <div class="card-title"><i data-lucide="users"></i><span>Aktiv im Dienst</span><span class="card-tag" id="dash-active-count">${active.length}</span></div>
      <div class="active-staff-list">
        ${active.slice(0, 12).map(a => `
          <div class="active-staff-item" title="${escapeHtml(a.username)}">
            ${a.avatar
              ? `<img src="${escapeHtml(a.avatar)}" alt="">`
              : `<div class="ava-fallback">${escapeHtml((a.username || '?').charAt(0).toUpperCase())}</div>`}
            <span class="ind ${a.state}"></span>
          </div>`).join('')}
        ${active.length > 12 ? `<div class="active-staff-more">+${active.length - 12}</div>` : ''}
      </div>`;
    refreshIcons();
  } catch(_) {}
}

// ─── Mitarbeiter des Monats ─────────────────────────
async function loadMonthTop() {
  try {
    const d = await api(`/shifts?discordId=${encodeURIComponent(currentSession.discordId)}`);
    const shifts = d.shifts || {};
    const lb = d.leaderboard || {};
    const rows = Object.entries(lb)
      .map(([id, l]) => ({
        id,
        username: l.username || '?',
        avatar: l.avatar || '',
        totalMs: (l.totalMs || 0) + (shifts[id]?.savedMs || 0),
      }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 3);

    const card = document.getElementById('dash-month');
    if (!card) return;
    if (rows.length === 0) {
      card.innerHTML = `<div class="card-title"><i data-lucide="award"></i><span>Top diesen Monat</span></div><div class="empty"><span>Keine Daten</span></div>`;
      refreshIcons();
      return;
    }
    const medals = ['#fbbf24', '#cbd5e1', '#cd7f32'];
    card.innerHTML = `
      <div class="card-title"><i data-lucide="award"></i><span>Top diesen Monat</span></div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${rows.map((r, i) => `
          <div class="list-item no-hover top-row" style="padding:8px;${i === 0 ? 'background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:10px;' : ''}">
            <div style="width:24px;display:flex;align-items:center;justify-content:center;">
              <i data-lucide="${i === 0 ? 'crown' : 'medal'}" style="color:${medals[i]};width:16px;height:16px;"></i>
            </div>
            ${r.avatar
              ? `<img class="li-avatar" style="width:32px;height:32px;" src="${escapeHtml(r.avatar)}" alt="">`
              : `<div class="li-avatar" style="width:32px;height:32px;font-size:13px;">${escapeHtml((r.username || '?').charAt(0).toUpperCase())}</div>`}
            <div class="li-body">
              <div class="li-title" style="font-size:12px;">${escapeHtml(r.username)}</div>
              <div class="li-meta">${fmtDuration(r.totalMs)}</div>
            </div>
          </div>`).join('')}
      </div>`;
    refreshIcons();
  } catch(_) {}
}

// ─── Live Feed ──────────────────────────────────────
// Client-side Roblox-Avatar-Cache (Fallback wenn Bot keine targetAvatar liefert)
const _avaCache = new Map(); // userId -> url

function hookFeed() {
  unsubs.push(live.on('ticket:new', (t) => {
    pushFeed({ type: 'ticket', icon: 'ticket', tone: 'success', title: `Ticket: #${t.channelName || ''}`, sub: t.category || '', ts: Date.now() });
  }));
  unsubs.push(live.on('case:new', (c) => {
    pushFeed({ type: 'case', icon: 'life-buoy', tone: 'success', title: `Support: ${c.username || ''}`, sub: c.subject || '', ts: Date.now() });
  }));
  // Polling fuer neue Mod-Einträge — pollen alle 12s
  let lastModIds = new Set();
  let firstPass = true;
  const poll = async () => {
    try {
      const d = await api(`/mod-log?discordId=${encodeURIComponent(currentSession.discordId)}&limit=10`);
      const log = d.log || [];
      if (firstPass) {
        firstPass = false;
        log.forEach(e => lastModIds.add(modKey(e)));
      } else {
        let added = false;
        for (const e of log) {
          const k = modKey(e);
          if (!lastModIds.has(k)) {
            lastModIds.add(k);
            pushFeed({
              type: 'mod',
              icon: 'shield-plus',
              tone: e.action === 'Ban' || e.action === 'One Day Ban' ? 'danger' : 'warn',
              title: `${e.action}: ${e.displayName || e.username || '?'}`,
              sub: `von ${e.moderator || '?'}`,
              avatar: e.targetAvatar || _avaCache.get(String(e.userId || '')) || '',
              modAvatar: e.moderatorAvatar || '',
              userId: e.userId || '',
              ts: e.date ? new Date(e.date).getTime() : Date.now(),
            });
            added = true;
          }
        }
        if (added) enrichRobloxAvatars();
      }
    } catch(_) {}
  };
  poll();
  const id = setInterval(poll, 12000);
  unsubs.push(() => clearInterval(id));
}

function modKey(e) {
  return `${e.userId || e.targetId || ''}:${e.action || ''}:${e.date || ''}`;
}

async function backfillFeed() {
  try {
    const d = await api(`/mod-log?discordId=${encodeURIComponent(currentSession.discordId)}&limit=8`);
    const log = d.log || [];
    log.forEach(e => {
      feedItems.push({
        type: 'mod',
        icon: 'shield',
        tone: e.action === 'Ban' || e.action === 'One Day Ban' ? 'danger' : 'warn',
        title: `${e.action}: ${e.displayName || e.username || '?'}`,
        sub: `von ${e.moderator || '?'}`,
        avatar: e.targetAvatar || '',
        modAvatar: e.moderatorAvatar || '',
        userId: e.userId || '',
        ts: e.date ? new Date(e.date).getTime() : Date.now(),
      });
    });
    feedItems.sort((a, b) => b.ts - a.ts);
    renderFeed();
    enrichRobloxAvatars();
  } catch(_) {
    renderFeed();
  }
}

// Client-side Fallback: falls der Bot keine targetAvatar liefert, holen wir
// die Roblox-Avatare ueber /api/roblox/avatars batchweise nach.
async function enrichRobloxAvatars() {
  const need = [];
  for (const it of feedItems) {
    if (it.avatar) continue;
    const uid = String(it.userId || '');
    if (!/^\d+$/.test(uid)) continue;
    if (_avaCache.has(uid)) {
      it.avatar = _avaCache.get(uid);
      continue;
    }
    need.push(uid);
  }
  // Schon vorhandene aus Cache rendern
  renderFeed();
  if (need.length === 0) return;
  try {
    const ids = [...new Set(need)].slice(0, 50);
    const d = await api(`/roblox/avatars?ids=${ids.join(',')}`);
    const map = d.avatars || {};
    for (const [id, url] of Object.entries(map)) {
      _avaCache.set(String(id), url);
    }
    for (const it of feedItems) {
      const uid = String(it.userId || '');
      if (!it.avatar && _avaCache.has(uid)) it.avatar = _avaCache.get(uid);
    }
    renderFeed();
  } catch(_) {}
}

function pushFeed(item) {
  feedItems.unshift(item);
  if (feedItems.length > FEED_MAX) feedItems.length = FEED_MAX;
  renderFeed();
}

function renderFeed() {
  const list = document.getElementById('dash-feed-list');
  if (!list) return;
  if (feedItems.length === 0) {
    list.innerHTML = `<div class="empty" style="padding:18px;"><i data-lucide="zap-off"></i><span>Noch keine Events</span></div>`;
    refreshIcons();
    return;
  }
  list.innerHTML = feedItems.map(i => {
    const avaCell = i.avatar
      ? `<img class="feed-ava" src="${escapeHtml(imgUrl(i.avatar))}" alt="" data-fallback-icon="${i.icon}">`
      : `<div class="feed-icon"><i data-lucide="${i.icon}"></i></div>`;
    const modAva = i.modAvatar
      ? `<img class="feed-mod" src="${escapeHtml(imgUrl(i.modAvatar))}" alt="">`
      : '';
    return `<div class="feed-item ${i.tone}">
      ${avaCell}
      <div class="feed-body">
        <div class="feed-title">${escapeHtml(i.title)}</div>
        ${i.sub ? `<div class="feed-sub">${modAva}<span>${escapeHtml(i.sub)}</span></div>` : ''}
      </div>
      <div class="feed-ts">${timeAgoShort(i.ts)}</div>
    </div>`;
  }).join('');
  refreshIcons();
  // Fallback fuer kaputte Avatar-URLs ohne CSP-blockiertes inline-onerror
  list.querySelectorAll('img.feed-ava[data-fallback-icon]').forEach(img => {
    img.addEventListener('error', () => {
      const ic = img.dataset.fallbackIcon || 'shield';
      const div = document.createElement('div');
      div.className = 'feed-icon';
      div.innerHTML = `<i data-lucide="${ic}"></i>`;
      img.replaceWith(div);
      refreshIcons();
    }, { once: true });
  });
}

function timeAgoShort(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'jetzt';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
