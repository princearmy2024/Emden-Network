/**
 * Profil: User-Info + Shift-Controls + Streak + Roblox-Verknüpfung
 */
import { api, escapeHtml, fmtDuration, refreshIcons, toast, imgUrl } from './api.js';
import * as sound from '../../sounds.js';
import * as device from '../../device.js';
import * as premium from '../../premium.js';

let currentRoot = null;
let currentSession = null;
let myShift = null;
let serverNow = Date.now();
let tickInterval = null;

export async function renderMe(root, session) {
  currentRoot = root;
  currentSession = session;
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  await load();
}

async function load() {
  renderShell();
  // Parallel laden
  Promise.all([
    api(`/shifts?discordId=${encodeURIComponent(currentSession.discordId)}`).catch(() => null),
    api(`/streaks?discordId=${encodeURIComponent(currentSession.discordId)}`).catch(() => null),
    api(`/roblox/profile?discordId=${encodeURIComponent(currentSession.discordId)}`).catch(() => null),
    premium.getStatus(currentSession.discordId).catch(() => null),
  ]).then(([shiftsData, streaksData, robloxData, premiumData]) => {
    if (shiftsData) {
      myShift = shiftsData.shifts?.[currentSession.discordId] || { state: 'off', savedMs: 0, breakMs: 0, startedAt: null, breakStartedAt: null };
      serverNow = shiftsData.serverNow || Date.now();
      renderShiftCard();
      startTick();
    }
    if (streaksData) renderStreakCard(streaksData);
    renderRobloxCard(robloxData);
    renderPremiumCard(premiumData);
  });
}

function renderShell() {
  const role = currentSession.isAdmin ? 'Administrator' : currentSession.isStaff ? 'Staff (EN-Team)' : 'User';
  const roleClass = currentSession.isAdmin ? 'danger' : currentSession.isStaff ? '' : '';
  currentRoot.innerHTML = `
    <div class="card">
      <div class="list-item no-hover" style="padding:6px;">
        ${currentSession.avatar
          ? `<img class="li-avatar" style="width:54px;height:54px;" src="${escapeHtml(currentSession.avatar)}" alt="">`
          : `<div class="li-avatar" style="width:54px;height:54px;font-size:20px;">${escapeHtml((currentSession.username || '?').charAt(0).toUpperCase())}</div>`}
        <div class="li-body">
          <div class="li-title" style="font-size:15px;">${escapeHtml(currentSession.username || 'Unbekannt')}</div>
          <div class="li-meta">${escapeHtml(role)}</div>
        </div>
      </div>
    </div>

    <div class="card" id="me-shift">
      <div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div>
      <div class="loading"><div class="spinner"></div></div>
    </div>

    <div class="card" id="me-streak">
      <div class="card-title"><i data-lucide="flame"></i><span>Streak</span></div>
      <div class="empty"><span>—</span></div>
    </div>

    <div class="card premium-card" id="me-premium">
      <div class="card-title"><i data-lucide="gem"></i><span>Spender / Premium</span></div>
      <div class="loading"><div class="spinner"></div></div>
    </div>

    <div class="card" id="me-roblox">
      <div class="card-title"><i data-lucide="gamepad-2"></i><span>Roblox-Verknüpfung</span></div>
      <div class="loading"><div class="spinner"></div></div>
    </div>

    <div class="card" id="me-settings">
      <div class="card-title"><i data-lucide="settings"></i><span>Einstellungen</span></div>
      <div class="setting-row">
        <div class="setting-label"><i data-lucide="smartphone"></i><span>Anzeige-Modus</span></div>
        <div class="seg" id="mode-seg">
          <button data-mode="auto">Auto</button>
          <button data-mode="phone">Handy</button>
          <button data-mode="pc">PC</button>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-label"><i data-lucide="bell"></i><span>Benachrichtigungs-Sound</span></div>
        <button class="btn ${sound.isMuted() ? '' : 'primary'}" id="sound-mute-btn">
          <i data-lucide="${sound.isMuted() ? 'volume-x' : 'volume-2'}"></i>
          <span>${sound.isMuted() ? 'Aus' : 'An'}</span>
        </button>
      </div>
      <div class="setting-row" id="vol-row" style="${sound.isMuted() ? 'opacity:0.4;pointer-events:none;' : ''}">
        <div class="setting-label"><i data-lucide="volume-1"></i><span>Lautstärke</span></div>
        <div style="display:flex;align-items:center;gap:8px;flex:1;">
          <input type="range" id="vol-slider" min="0" max="100" value="${Math.round(sound.getVolume() * 100)}" style="flex:1;">
          <button class="btn icon-only sm" id="vol-test" title="Testen"><i data-lucide="play"></i></button>
        </div>
      </div>
    </div>`;
  refreshIcons();
  bindSettings();
}

function bindSettings() {
  // Device-Mode Segmented Control
  const seg = document.getElementById('mode-seg');
  if (seg) {
    const cur = device.getMode();
    seg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === cur);
      b.addEventListener('click', () => {
        device.setMode(b.dataset.mode);
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.mode === b.dataset.mode));
        toast('Modus: ' + b.dataset.mode, 'success');
        // Mode-Change Event triggern damit Shell neu rendert
        window.dispatchEvent(new CustomEvent('en:modechange'));
      });
    });
  }

  // Sound Mute Toggle
  const muteBtn = document.getElementById('sound-mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      sound.setMuted(!sound.isMuted());
      const muted = sound.isMuted();
      muteBtn.classList.toggle('primary', !muted);
      muteBtn.innerHTML = `<i data-lucide="${muted ? 'volume-x' : 'volume-2'}"></i><span>${muted ? 'Aus' : 'An'}</span>`;
      const volRow = document.getElementById('vol-row');
      if (volRow) {
        volRow.style.opacity = muted ? '0.4' : '';
        volRow.style.pointerEvents = muted ? 'none' : '';
      }
      // Header-Icon synchronisieren
      const ic = document.querySelector('#sound-toggle [data-lucide]');
      if (ic) ic.setAttribute('data-lucide', muted ? 'volume-x' : 'volume-2');
      refreshIcons();
      if (!muted) sound.play();
    });
  }

  // Volume Slider
  const vol = document.getElementById('vol-slider');
  if (vol) {
    vol.addEventListener('input', () => sound.setVolume(vol.value / 100));
  }
  const test = document.getElementById('vol-test');
  if (test) test.addEventListener('click', () => sound.play());
}

function renderShiftCard() {
  const card = document.getElementById('me-shift');
  if (!card || !myShift) return;
  const state = myShift.state || 'off';
  const stateLabel = state === 'active' ? 'Im Dienst' : state === 'break' ? 'Pause' : 'Offline';
  card.innerHTML = `
    <div class="card-title"><i data-lucide="clock"></i><span>Mein Shift</span></div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
      <div class="shift-state ${state}">
        <span class="dot"></span><span>${stateLabel}</span>
      </div>
      <div style="font-size:22px;font-weight:800;font-variant-numeric:tabular-nums;" id="shift-time">${fmtDuration(getCurrentTotal())}</div>
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
    const d = await api(path, { method: 'POST', body: { discordId: currentSession.discordId } });
    myShift = d.shift || myShift;
    renderShiftCard();
    toast(action === 'start' ? 'Shift gestartet' : action === 'pause' ? 'Pause' : 'Shift beendet', 'success');
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}

function renderStreakCard(d) {
  const card = document.getElementById('me-streak');
  if (!card) return;
  const my = d?.streaks?.[currentSession.discordId];
  if (!my) {
    card.innerHTML = `<div class="card-title"><i data-lucide="flame"></i><span>Streak</span></div>
      <div class="empty"><span>Noch keine Streak-Daten</span></div>`;
    refreshIcons();
    return;
  }
  const reqs = d.requirements || {};
  card.innerHTML = `
    <div class="card-title"><i data-lucide="flame"></i><span>Streak</span></div>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
      <div style="width:54px;height:54px;border-radius:50%;background:linear-gradient(135deg,#fbbf24,#f59e0b);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#000;box-shadow:0 4px 16px rgba(251,191,36,0.3);">${my.streak || 0}</div>
      <div>
        <div style="font-size:18px;font-weight:800;">${my.streak || 0} Tage</div>
        <div style="font-size:11px;color:var(--text-dim);">Best: ${my.bestStreak || 0}${my.protected ? ' · 🛡 geschützt' : ''}</div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-label">Heute Zeit</div>
        <div class="stat-value small">${fmtDuration(my.todayMs || 0)}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Min. ${fmtDuration(reqs.minMs || 0)}</div>
      </div>
      <div class="stat">
        <div class="stat-label">Heute Einträge</div>
        <div class="stat-value small">${my.todayEntries || 0}</div>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">Min. ${reqs.minEntries || 0}</div>
      </div>
    </div>
    ${my.completed ? `<div class="banner success" style="margin-top:10px;"><i data-lucide="check"></i><span>Heute erfüllt!</span></div>` : ''}`;
  refreshIcons();
}

function renderPremiumCard(d) {
  const card = document.getElementById('me-premium');
  if (!card) return;
  const active = !!d?.active;
  const endsAt = d?.endsAt ? new Date(d.endsAt) : null;
  const endsStr = endsAt ? endsAt.toLocaleDateString('de-DE') : '';

  if (active) {
    card.classList.add('premium-active');
    card.innerHTML = `
      <div class="card-title"><i data-lucide="gem"></i><span>Spender / Premium</span><span class="card-tag premium-tag">AKTIV</span></div>
      <div class="premium-row">
        <div class="premium-icon"><i data-lucide="sparkles"></i></div>
        <div class="premium-body">
          <div class="premium-title">Du bist Spender 💎</div>
          <div class="premium-sub">${endsStr ? `Verlängert sich automatisch · nächste Abbuchung: ${endsStr}` : 'Vielen Dank für deinen Support!'}</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.55;">
        Deine Premium-Rolle wird automatisch synchronisiert. Du kannst dein Abo jederzeit über
        Discord-Einstellungen → Abos kündigen.
      </div>`;
  } else {
    card.classList.remove('premium-active');
    card.innerHTML = `
      <div class="card-title"><i data-lucide="gem"></i><span>Spender / Premium</span></div>
      <div class="premium-row">
        <div class="premium-icon idle"><i data-lucide="heart"></i></div>
        <div class="premium-body">
          <div class="premium-title">Werde Spender</div>
          <div class="premium-sub">2,99 €/Monat — unterstütze Emden Network</div>
        </div>
      </div>
      <ul class="premium-perks">
        <li><i data-lucide="check"></i><span>Exklusive 💎 Spender-Rolle in Discord</span></li>
        <li><i data-lucide="check"></i><span>Farbiger Name im Chat</span></li>
        <li><i data-lucide="check"></i><span>VIP-Support</span></li>
      </ul>
      <button class="btn primary full lg" id="premium-buy-btn">
        <i data-lucide="gem"></i><span>Jetzt Spender werden</span>
      </button>`;
  }
  refreshIcons();
  const btn = document.getElementById('premium-buy-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await premium.startPurchase();
        toast('Vielen Dank! Status aktualisiert sich gleich…', 'success');
        // Discord schliesst Modal nach erfolgreichem Kauf — Status nach kurzem
        // Delay neu laden (Webhook braucht 1-2s)
        setTimeout(async () => {
          premium.clearCache();
          const fresh = await premium.getStatus(currentSession.discordId, { force: true });
          renderPremiumCard(fresh);
        }, 2500);
      } catch(e) {
        toast(e.message, 'danger');
        btn.disabled = false;
      }
    });
  }
}

function renderRobloxCard(d) {
  const card = document.getElementById('me-roblox');
  if (!card) return;
  if (!d || !d.profile) {
    card.innerHTML = `
      <div class="card-title"><i data-lucide="gamepad-2"></i><span>Roblox-Verknüpfung</span></div>
      <div class="empty">
        <i data-lucide="link-2-off"></i>
        <span>Noch nicht verknüpft</span>
        <span style="font-size:10px;">Verknüpfung läuft über Dashboard / Mobile-App</span>
      </div>`;
    refreshIcons();
    return;
  }
  const p = d.profile;
  card.innerHTML = `
    <div class="card-title"><i data-lucide="gamepad-2"></i><span>Roblox-Verknüpfung</span></div>
    <div class="list-item no-hover">
      ${p.avatar
        ? `<img class="li-avatar" src="${escapeHtml(imgUrl(p.avatar))}" alt="">`
        : `<div class="li-avatar"><i data-lucide="user"></i></div>`}
      <div class="li-body">
        <div class="li-title">${escapeHtml(p.displayName || p.username)}</div>
        <div class="li-meta">@${escapeHtml(p.username)} · ID ${escapeHtml(p.userId)}</div>
      </div>
      <span class="li-tag success">Verknüpft</span>
    </div>`;
  refreshIcons();
}
