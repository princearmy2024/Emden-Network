// Emden Network Mobile — app.js
const MOBILE_VERSION = '4.66.2'; // Synchron mit Repo-Tag (api.php liest GitHub latest)
const CONFIG = {
    // PHP-Proxy ueber HTTPS — umgeht Cleartext + CORS Probleme auf Android
    API_URL: 'https://enrp.net/api.php',
    API_URL_DIRECT: 'http://91.98.124.212:5009', // Fallback fuer WebSockets
    API_KEY: 'emden-super-secret-key-2026',
};

// Helper: Erstellt API-URLs fuer den PHP-Proxy
// Beispiel: apiUrl('/api/verify') -> 'https://enrp.net/api.php?e=verify'
function apiUrl(endpoint, params = {}) {
    const ep = endpoint.replace(/^\/api\//, '');
    const qs = new URLSearchParams({ e: ep, ...params }).toString();
    return CONFIG.API_URL + '?' + qs;
}

// ── Version Check ──
function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) > (pb[i] || 0)) return 1;
        if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Auth ──
const Auth = {
    user: null,
    save() { localStorage.setItem('en_mobile_session', JSON.stringify(this.user)); },
    load() { try { this.user = JSON.parse(localStorage.getItem('en_mobile_session')); } catch(e) { this.user = null; } return !!this.user; },
    clear() { this.user = null; localStorage.removeItem('en_mobile_session'); },
};

// ── Socket ──
let socket = null;
function connectSocket() {
    if (socket?.connected) return;
    socket = io(CONFIG.API_URL_DIRECT, { transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
        console.log('[Socket] Connected');
        document.getElementById('connDot')?.classList.remove('offline');
        const u = Auth.user;
        if (u) {
            socket.emit('client_online', { discordId: u.discordId, username: u.username, avatar: u.avatar, role: u.role });
            socket.emit('chat_register', { discordId: u.discordId, username: u.username });
        }
    });

    socket.on('disconnect', () => {
        document.getElementById('connDot')?.classList.add('offline');
    });

    socket.on('online_users', (users) => App.renderUsers(users));
    socket.on('receive_message', (msg) => App.receiveMessage(msg));
    socket.on('typing_indicator', ({ username, typing }) => {
        const el = document.getElementById('typingIndicator');
        if (!el) return;
        if (typing) { el.textContent = `${username} tippt...`; el.classList.remove('hidden'); }
        else { el.classList.add('hidden'); }
    });
    socket.on('msg_status', ({ id, status }) => {
        const check = document.querySelector(`#msg-${id} .msg-check`);
        if (check) {
            check.innerHTML = (status === 'read' || status === 'delivered') ? '✓✓' : '✓';
            check.style.color = status === 'read' ? '#3b82f6' : 'var(--text-muted)';
        }
    });
    socket.on('msg_deleted', ({ msgId }) => {
        document.getElementById(msgId)?.remove();
    });

    // Persoenliche Discord-Mention → Systembenachrichtigung
    const myDid = Auth.user?.discordId;
    if (myDid) {
        socket.on(`dc_mention_${myDid}`, (data) => {
            App._notifyRaw({
                title: data.title || 'Discord-Erwaehnung',
                body: data.message || '',
                icon: data.authorAvatar,
                tag: 'en-mention-' + Date.now(),
            });
        });
    }

    // Panic-Alert (alle Staff)
    socket.on('panic_alert', (data) => {
        if (!App._isStaff()) return;
        App._notifyRaw({
            title: '🚨 PANIC BUTTON',
            body: `${data.username || 'Unbekannt'} braucht Hilfe!`,
            icon: data.avatar,
            tag: 'en-panic-' + Date.now(),
            requireInteraction: true,
        });
    });

    // Neues Ticket (alle Staff)
    socket.on('overlay_new_ticket', (data) => {
        if (!App._isStaff()) return;
        App._notifyRaw({
            title: '📩 Neues Ticket',
            body: `${data.channelName || data.ticketId} — ${data.reason || ''}`,
            tag: 'en-ticket-' + (data.ticketId || Date.now()),
        });
    });

    // Support-Warteraum (alle Staff)
    socket.on('support_waiting', (data) => {
        if (!App._isStaff()) return;
        if (data.action !== 'join') return;
        App._notifyRaw({
            title: '🎧 Support-Warteraum',
            body: `${data.username} wartet in ${data.channelName || ''}`,
            icon: data.avatar,
            tag: 'en-support-' + (data.userId || Date.now()),
        });
    });

    // Support-Cases Live-Panel (staff)
    socket.on('support_case_new',    (c) => SupportMobile.add(c));
    socket.on('support_case_update', (c) => SupportMobile.update(c));
    socket.on('support_case_closed', (c) => SupportMobile.remove(c.caseId));

    // Streak (eigener)
    socket.on('streak_complete', (data) => {
        if (data.discordId !== Auth.user?.discordId) return;
        App._notifyRaw({
            title: '🔥 Streak!',
            body: `${data.streak} Tage in Folge — weiter so!`,
            tag: 'en-streak-' + Date.now(),
        });
    });

    // Shift-Update (Server = Source of Truth) — Home-Timer direkt aus Snapshot syncen
    socket.on('shift_update', (data) => {
        App._applyShiftUpdate?.(data);
        App._onShiftUpdate?.(data);
    });
}

// ── App ──
const App = {
    currentChat: 'general',
    _typingTimeout: null,
    _users: [],
    _staffVerified: false, // Wird NUR durch erfolgreiches /api/check-staff auf true gesetzt
    _unreadCounts: {},     // { 'general': n, '@username': n }
    _blockedUsers: [],     // ['username', ...]
    _mutedUsers: [],       // ['username', ...]

    _loadSocial() {
        try {
            this._unreadCounts = JSON.parse(localStorage.getItem('en_unread_counts') || '{}');
            this._blockedUsers = JSON.parse(localStorage.getItem('en_blocked_users') || '[]');
            this._mutedUsers = JSON.parse(localStorage.getItem('en_muted_users') || '[]');
        } catch(e) {
            this._unreadCounts = {}; this._blockedUsers = []; this._mutedUsers = [];
        }
    },
    _saveSocial() {
        try {
            localStorage.setItem('en_unread_counts', JSON.stringify(this._unreadCounts));
            localStorage.setItem('en_blocked_users', JSON.stringify(this._blockedUsers));
            localStorage.setItem('en_muted_users', JSON.stringify(this._mutedUsers));
        } catch(e) {}
    },
    _isBlocked(username) { return this._blockedUsers.includes(username); },
    _isMuted(username) { return this._mutedUsers.includes(username); },
    _toggleBlock(username) {
        if (this._isBlocked(username)) {
            this._blockedUsers = this._blockedUsers.filter(u => u !== username);
        } else {
            this._blockedUsers.push(username);
            delete this._unreadCounts['@' + username];
            if (this.currentChat === '@' + username) this.showUserList();
        }
        this._saveSocial();
        if (this._users) this.renderUsers(this._users);
    },
    _toggleMute(username) {
        if (this._isMuted(username)) {
            this._mutedUsers = this._mutedUsers.filter(u => u !== username);
        } else {
            this._mutedUsers.push(username);
        }
        this._saveSocial();
        if (this._users) this.renderUsers(this._users);
    },

    async login() {
        const code = document.getElementById('loginCode').value.trim();
        const err = document.getElementById('loginError');
        if (!code) { err.textContent = 'Bitte Code eingeben.'; return; }
        err.textContent = 'Verbinde...';

        try {
            const res = await fetch(apiUrl('/api/verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const data = await res.json();
            if (data.success && data.user) {
                Auth.user = data.user;
                Auth.save();
                this.showApp();
            } else {
                err.textContent = data.error || 'Ungültiger Code.';
            }
        } catch(e) {
            err.textContent = 'Server nicht erreichbar.';
        }
    },

    showApp() {
        // Security: gecachten Staff-Status NIE vertrauen. Erst nach verifyRoleLive() freischalten.
        this._staffVerified = false;
        if (Auth.user) {
            Auth.user.isStaff = false;
            if (Auth.user.role === 'staff' || Auth.user.role === 'admin') Auth.user.role = 'user';
            Auth.save();
        }
        this._loadSocial();
        document.getElementById('loginScreen').classList.remove('active');
        document.getElementById('appScreen').classList.add('active');
        this.applyUser();
        connectSocket();
        this._loadHistory();
        const vEl = document.getElementById('settingsVersion');
        if (vEl) vEl.textContent = MOBILE_VERSION;
        this.loadHome();
        this.loadRobloxProfile();
        this.requestNotificationPermission();
        // Rolle nochmal live beim Server pruefen (Cached-Session koennte veraltet sein)
        this.verifyRoleLive();
        clearInterval(this._homeRefresh);
        this._homeRefresh = setInterval(() => {
            const activeView = document.querySelector('.view.active')?.id;
            if (activeView === 'view-home') this.loadHome();
        }, 30000);
    },

    async verifyRoleLive() {
        const u = Auth.user;
        if (!u?.discordId) return;

        // Retry bei transienten Fehlern (Discord-Lag, Netz-Hickup), damit Staff nicht stumm rausfliegen
        const backoffs = [0, 800, 2000];
        let lastError = null;
        let d = null;
        for (let i = 0; i < backoffs.length; i++) {
            if (backoffs[i] > 0) await new Promise(r => setTimeout(r, backoffs[i]));
            try {
                const res = await fetch(apiUrl('/api/check-staff'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                    body: JSON.stringify({ discordId: u.discordId })
                });
                d = await res.json();
                if (d && d.success) { lastError = null; break; }
                lastError = d?.error || 'unknown';
            } catch(e) {
                lastError = e.message || 'network';
                d = null;
            }
        }

        if (!d || !d.success) {
            // Alle Retries erschoepft — Fail-closed, aber mit sichtbarem Status damit User weiss warum
            this._staffVerified = false;
            if (Auth.user) { Auth.user.isStaff = false; Auth.user.role = 'user'; Auth.save(); this.applyUser(); }
            if (document.querySelector('.view.active')?.id === 'view-mod') {
                this._modStatus && this._modStatus('error', `Staff-Check fehlgeschlagen (${lastError}). Tippe nochmal auf Mod-Tab.`);
                this.switchTab('home');
            }
            return;
        }

        // Sync lokale Session mit Server
        const serverIsStaff = !!d.isStaff;
        const serverIsAdmin = !!d.isAdmin;
        if (Auth.user) {
            Auth.user.isStaff = serverIsStaff;
            Auth.user.role = serverIsAdmin ? 'admin' : serverIsStaff ? 'staff' : 'user';
            Auth.save();
            this._staffVerified = serverIsStaff || serverIsAdmin;
            this.applyUser();
            if (!serverIsStaff && !serverIsAdmin && document.querySelector('.view.active')?.id === 'view-mod') {
                this.switchTab('home');
            }
        }
    },

    applyUser() {
        const u = Auth.user;
        if (!u) return;
        const setAvatar = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (u.avatar) {
                el.innerHTML = `<img src="${escHtml(u.avatar)}" onerror="this.parentElement.textContent='${(u.username||'U')[0].toUpperCase()}'">`;
            } else {
                el.textContent = (u.username || 'U')[0].toUpperCase();
            }
        };
        setAvatar('topbarAvatar');
        setAvatar('settingsAvatar');
        const nameEl = document.getElementById('settingsName');
        if (nameEl) nameEl.textContent = u.username;
        const roleEl = document.getElementById('settingsRole');
        if (roleEl) roleEl.textContent = u.role === 'admin' ? 'Administrator' : 'Mitglied';

        // Mod-Tab nur fuer verifizierte Staff/Admin sichtbar machen (Cache allein reicht nicht)
        const isStaff = this._staffVerified && (u.isStaff || u.role === 'staff' || u.role === 'admin');
        document.querySelectorAll('.staff-only').forEach(el => {
            if (isStaff) el.classList.remove('hidden');
            else el.classList.add('hidden');
        });
    },

    logout() {
        this._staffVerified = false;
        Auth.clear();
        socket?.disconnect();
        document.getElementById('appScreen').classList.remove('active');
        document.getElementById('loginScreen').classList.add('active');
        document.getElementById('loginCode').value = '';
        document.getElementById('loginError').textContent = '';
    },

    _tabOrder: ['home', 'chat', 'mod', 'team', 'settings'],
    _currentTabIndex: 0,

    _isStaff() {
        // HART: Staff-Zugriff NUR nach erfolgreicher Server-Verifikation. Cache allein reicht nie.
        if (!this._staffVerified) return false;
        const u = Auth.user;
        return !!(u && (u.isStaff === true || u.role === 'staff' || u.role === 'admin'));
    },

    switchTab(tab) {
        // Security-Gate: Mod-View nur fuer verifizierte Staff/Admin
        if (tab === 'mod' && !this._isStaff()) {
            tab = 'home';
        }
        const order = this._tabOrder;
        const newIdx = order.indexOf(tab);
        const direction = newIdx > this._currentTabIndex ? 'right' : (newIdx < this._currentTabIndex ? 'left' : null);
        this._currentTabIndex = newIdx >= 0 ? newIdx : this._currentTabIndex;

        document.querySelectorAll('.view').forEach(v => {
            v.classList.remove('active', 'slide-from-right', 'slide-from-left');
        });
        const nextView = document.getElementById(`view-${tab}`);
        if (nextView) {
            nextView.classList.add('active');
            if (direction === 'right') nextView.classList.add('slide-from-right');
            else if (direction === 'left') nextView.classList.add('slide-from-left');
        }
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.tab === tab));

        const titles = { home: 'Home', chat: 'Chat', mod: 'Moderation', team: 'Team', settings: 'Einstellungen' };
        const titleEl = document.getElementById('topbarTitle');
        if (titleEl) titleEl.textContent = titles[tab] || '';

        if (tab === 'home') this.loadHome();
        else if (tab === 'team') this.loadTeam();
        else if (tab === 'mod') this.loadModLog();
    },

    switchModTab(sub) {
        if (!this._isStaff()) { this.switchTab('home'); return; }
        document.querySelectorAll('.mod-tab').forEach(t => t.classList.toggle('active', t.dataset.modtab === sub));
        document.querySelectorAll('.mod-tab-content').forEach(c => c.classList.remove('active'));
        document.getElementById(`modtab-${sub}`)?.classList.add('active');
        if (sub === 'log') this.loadModLog();
        else if (sub === 'leader') this.loadLeaderboard();
    },

    showModLog() {
        if (!this._isStaff()) return;
        this.switchTab('mod');
        this.switchModTab('log');
    },

    // ── HOME ──
    _homeTimer: null,
    _homeShiftStart: null,
    _homeShiftBase: 0,

    async loadHome() {
        this.loadStatus();
        this.loadOnDuty();
        this.loadStats();
        const u = Auth.user;
        if (u && (u.role === 'staff' || u.role === 'admin' || u.isStaff)) {
            this.loadMyShift();
            this.loadMyStreak();
        }
    },

    async loadStatus() {
        try {
            const res = await fetch(apiUrl('/api/status'), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            document.getElementById('homeMembers').textContent = (d.members || 0).toLocaleString('de-DE');
            document.getElementById('homeOnline').textContent = d.onlineMembers || 0;
            document.getElementById('homeDash').textContent = d.dashboardOnline || 0;
        } catch(e) {}
    },

    async loadOnDuty() {
        try {
            const res = await fetch(apiUrl('/api/on-duty', { discordId: Auth.user?.discordId || '' }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const list = document.getElementById('homeOnDutyList');
            const count = document.getElementById('homeOnDutyCount');
            const staff = d.staff || [];
            count.textContent = staff.length;
            if (!staff.length) {
                list.innerHTML = '<div class="empty-hint">Niemand im Dienst</div>';
                return;
            }
            list.innerHTML = staff.map(s => `
                <div class="duty-item">
                    <div class="duty-avatar">${s.avatar ? `<img src="${escHtml(s.avatar)}">` : (s.username || '?')[0].toUpperCase()}</div>
                    <div class="duty-info">
                        <div class="duty-name">${escHtml(s.displayName || s.username)}</div>
                        <div class="duty-role">${escHtml((s.roles || []).slice(0, 2).join(' · ') || 'Staff')}</div>
                    </div>
                    <div class="duty-dot"></div>
                </div>
            `).join('');
        } catch(e) {}
    },

    async loadStats() {
        try {
            const res = await fetch(apiUrl('/api/storage', { discordId: Auth.user?.discordId || '' }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const grid = document.getElementById('homeStatsGrid');
            if (!d.success) { grid.innerHTML = '<div class="empty-hint">Keine Daten</div>'; return; }
            const items = [
                { k: 'RAM Server', v: d.server?.ramPercent || '—' },
                { k: 'Mod-Eintraege', v: (d.counts?.modEntries || 0).toLocaleString('de-DE') },
                { k: 'Bot Uptime', v: d.uptime || '—' },
                { k: 'Bekannte User', v: (d.counts?.knownUsers || 0).toLocaleString('de-DE') },
            ];
            grid.innerHTML = items.map(i => `<div class="stat-item"><div class="stat-key">${i.k}</div><div class="stat-val">${escHtml(i.v)}</div></div>`).join('');
        } catch(e) {
            document.getElementById('homeStatsGrid').innerHTML = '<div class="empty-hint">Fehler</div>';
        }
    },

    _myShift: null,

    async loadMyShift() {
        const u = Auth.user;
        if (!u?.discordId) return;
        try {
            const res = await fetch(apiUrl('/api/shifts', { discordId: u.discordId }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const mine = d.shifts?.[u.discordId];
            if (mine) this._myShift = mine;
            this._renderShiftUI();
            this._startShiftTimer();
        } catch(e) {}
    },

    _applyShiftUpdate(snapshot) {
        if (!snapshot || !snapshot.discordId) return;
        const u = Auth.user;
        if (snapshot.discordId !== u?.discordId) return;
        this._myShift = snapshot;
        this._renderShiftUI();
        this._startShiftTimer();
    },

    _liveShiftMs(s) {
        if (!s) return { activeMs: 0, breakMs: 0 };
        const now = Date.now();
        let activeMs = s.savedMs || 0;
        if (s.state === 'active' && s.startedAt) activeMs += Math.max(0, now - s.startedAt);
        let breakMs = s.breakMs || 0;
        if (s.state === 'break' && s.breakStartedAt) breakMs += Math.max(0, now - s.breakStartedAt);
        return { activeMs, breakMs };
    },

    _renderShiftUI() {
        const s = this._myShift;
        const state = s?.state || 'off';
        const stateEl = document.getElementById('homeShiftState');
        const labels = { off: 'Off Duty', active: 'Im Dienst', break: 'Pause' };
        if (stateEl) stateEl.textContent = labels[state] || 'Off Duty';

        const sBtn = document.getElementById('shiftBtnStart');
        const pBtn = document.getElementById('shiftBtnPause');
        const eBtn = document.getElementById('shiftBtnEnd');
        if (sBtn) sBtn.disabled = state === 'active';
        if (pBtn) pBtn.disabled = state !== 'active';
        if (eBtn) eBtn.disabled = state === 'off' && !(s?.savedMs);

        // Pause-Sub-Timer einblenden
        const timerEl = document.getElementById('homeShiftTimer');
        if (!timerEl) return;
        let sub = document.getElementById('homeShiftPauseSub');
        if (state !== 'break') {
            if (sub) { sub.classList.remove('visible'); setTimeout(() => sub?.remove(), 400); }
        } else if (!sub) {
            sub = document.createElement('div');
            sub.id = 'homeShiftPauseSub';
            sub.className = 'home-shift-pause-sub';
            sub.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>Pause</span><span class="home-shift-pause-time">0 s</span>';
            timerEl.insertAdjacentElement('afterend', sub);
            requestAnimationFrame(() => sub.classList.add('visible'));
        }
    },

    _startShiftTimer() {
        clearInterval(this._homeTimer);
        const el = document.getElementById('homeShiftTimer');
        if (!el) return;
        const tick = () => {
            const s = this._myShift;
            const { activeMs, breakMs } = this._liveShiftMs(s);
            const sec = Math.floor(activeMs / 1000);
            const h = String(Math.floor(sec / 3600)).padStart(2, '0');
            const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
            const ss = String(sec % 60).padStart(2, '0');
            el.textContent = `${h}:${m}:${ss}`;
            const subTime = document.querySelector('#homeShiftPauseSub .home-shift-pause-time');
            if (subTime) {
                const bm = Math.floor(breakMs / 60000);
                const bs = Math.floor((breakMs % 60000) / 1000);
                subTime.textContent = bm >= 1 ? `${bm} Min ${String(bs).padStart(2,'0')} s` : `${bs} s`;
            }
        };
        tick();
        this._homeTimer = setInterval(tick, 1000);
    },

    async _shiftCall(endpoint, label) {
        const u = Auth.user;
        if (!u?.discordId) return;
        const btns = ['shiftBtnStart','shiftBtnPause','shiftBtnEnd'];
        btns.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });
        try {
            const res = await fetch(apiUrl(`/api/shift/${endpoint}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify({ discordId: u.discordId })
            });
            const data = await res.json();
            if (data.success && data.shift) {
                this._myShift = data.shift;
                this._renderShiftUI();
                this._startShiftTimer();
            } else {
                this._renderShiftUI();
                if (data.error) try { window.Capacitor?.Plugins?.Haptics?.notification({ type: 'WARNING' }); } catch(_) {}
            }
        } catch(e) {
            this._renderShiftUI();
        }
    },
    shiftStart() { return this._shiftCall('start', 'Start'); },
    shiftPause() { return this._shiftCall('pause', 'Pause'); },
    shiftEnd()   { return this._shiftCall('end',   'End');   },

    async loadMyStreak() {
        const u = Auth.user;
        if (!u?.discordId) return;
        try {
            const res = await fetch(apiUrl('/api/streaks', { discordId: u.discordId }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const mine = d.streaks?.[u.discordId];
            const req = d.requirements || { minMs: 600000, minEntries: 5 };

            const streak = mine?.streak || 0;
            const best = mine?.bestStreak || 0;
            const todayMs = mine?.todayMs || 0;
            const todayEntries = mine?.todayEntries || 0;
            const completed = mine?.completed || false;

            document.getElementById('homeStreakBadge').textContent = streak;
            document.getElementById('homeStreakSub').textContent = completed ? `Heute geschafft! Best: ${best}` : `Beste Serie: ${best} Tage`;

            const timePct = Math.min(100, (todayMs / req.minMs) * 100);
            const entryPct = Math.min(100, (todayEntries / req.minEntries) * 100);
            const tFill = document.getElementById('homeStreakTimeFill');
            const eFill = document.getElementById('homeStreakEntryFill');
            tFill.style.width = timePct + '%';
            eFill.style.width = entryPct + '%';
            tFill.classList.toggle('done', timePct >= 100);
            eFill.classList.toggle('done', entryPct >= 100);

            const minMin = Math.round(req.minMs / 60000);
            document.getElementById('homeStreakTimeMeta').textContent = `On Duty: ${Math.floor(todayMs / 60000)}m / ${minMin}m`;
            document.getElementById('homeStreakEntryMeta').textContent = `Eintraege: ${todayEntries} / ${req.minEntries}`;
        } catch(e) {}
    },

    // ── TEAM ──
    async loadTeam() {
        const body = document.getElementById('teamBody');
        try {
            const res = await fetch(apiUrl('/api/team'));
            const d = await res.json();
            if (!d.success || !d.roles?.length) {
                body.innerHTML = '<div class="empty-hint">Keine Team-Daten</div>';
                return;
            }
            body.innerHTML = d.roles.map(role => `
                <div class="role-group">
                    <div class="role-head">
                        <span class="role-dot" style="background:${escHtml(role.color)}"></span>
                        <span class="role-name">${escHtml(role.name)}</span>
                        <span class="role-count">${role.members.length}</span>
                    </div>
                    <div class="role-members">
                        ${role.members.map(m => `
                            <div class="role-member ${m.status === 'offline' ? 'offline' : ''}">
                                <div class="status-ring ${m.status}"><img src="${escHtml(m.avatar)}" onerror="this.style.opacity=0"></div>
                                <span class="role-member-name">${escHtml(m.username)}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('');
        } catch(e) {
            body.innerHTML = '<div class="empty-hint">Fehler beim Laden</div>';
        }
    },

    // ── MOD LOG ──
    async loadModLog() {
        if (!this._isStaff()) return;
        const list = document.getElementById('modLogList');
        if (!list) return;
        try {
            const res = await fetch(apiUrl('/api/mod-log', { limit: 30, discordId: Auth.user?.discordId || '' }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const log = d.log || [];
            if (!log.length) { list.innerHTML = '<div class="empty-hint">Keine Eintraege</div>'; return; }
            list.innerHTML = log.map(e => {
                const action = (e.action || 'Warn');
                const cls = action.toLowerCase().replace(/\s+/g, '').replace('oneday', 'dayban');
                const cssClass = cls.includes('ban') && cls.includes('day') ? 'dayban' : cls.includes('ban') ? 'ban' : cls.includes('kick') ? 'kick' : cls.includes('notiz') ? 'notiz' : 'warn';
                const date = new Date(e.date);
                const now = new Date();
                const diffMs = now - date;
                let timeStr;
                if (diffMs < 3600000) timeStr = Math.floor(diffMs / 60000) + 'm';
                else if (diffMs < 86400000) timeStr = Math.floor(diffMs / 3600000) + 'h';
                else timeStr = Math.floor(diffMs / 86400000) + 'd';
                return `<div class="mod-log-item ${cssClass}">
                    <div class="mod-log-top">
                        <span class="mod-log-action">${escHtml(action)}</span>
                        <span class="mod-log-time">${timeStr}</span>
                    </div>
                    <div class="mod-log-user">${escHtml(e.displayName || 'Unknown')}</div>
                    <div class="mod-log-reason">${escHtml(e.reason || 'Kein Grund')}</div>
                    <div class="mod-log-moderator">@${escHtml(e.moderator || '?')}</div>
                </div>`;
            }).join('');
        } catch(e) {
            list.innerHTML = '<div class="empty-hint">Fehler</div>';
        }
    },

    async loadLeaderboard() {
        const list = document.getElementById('leaderList');
        if (!list) return;
        try {
            const res = await fetch(apiUrl('/api/shifts', { discordId: Auth.user?.discordId || '' }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const lb = Object.entries(d.leaderboard || {})
                .map(([id, v]) => ({ id, ...v }))
                .sort((a, b) => (b.totalMs || 0) - (a.totalMs || 0))
                .slice(0, 20);
            if (!lb.length) { list.innerHTML = '<div class="empty-hint">Noch kein Ranking</div>'; return; }
            list.innerHTML = lb.map((x, i) => {
                const h = Math.floor((x.totalMs || 0) / 3600000);
                const m = Math.floor(((x.totalMs || 0) % 3600000) / 60000);
                const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
                return `<div class="leader-item">
                    <div class="leader-rank ${rankCls}">#${i + 1}</div>
                    <div class="leader-avatar">${x.avatar ? `<img src="${escHtml(x.avatar)}">` : (x.username || '?')[0].toUpperCase()}</div>
                    <div class="leader-info">
                        <div class="leader-name">${escHtml(x.username || '?')}</div>
                        <div class="leader-time">${h}h ${m}m</div>
                    </div>
                </div>`;
            }).join('');
        } catch(e) {
            list.innerHTML = '<div class="empty-hint">Fehler</div>';
        }
    },

    // ── ROBLOX LINK ──
    async loadRobloxProfile() {
        const u = Auth.user;
        if (!u?.discordId) return;
        try {
            const res = await fetch(apiUrl('/api/roblox/profile', { discordId: u.discordId }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const d = await res.json();
            const card = document.getElementById('robloxDisplay');
            const sub = document.getElementById('robloxSub');
            const av = document.getElementById('robloxAvatar');
            const btn = document.getElementById('robloxLinkBtn');
            if (d.success && d.profile) {
                card.textContent = d.profile.displayName || d.profile.username;
                sub.textContent = '@' + d.profile.username;
                av.innerHTML = d.profile.avatar ? `<img src="${escHtml(d.profile.avatar)}">` : '?';
                btn.textContent = 'Neu verknuepfen';
            } else {
                card.textContent = 'Nicht verknuepft';
                sub.textContent = 'Verknuepfe deinen Account';
                av.innerHTML = '?';
                btn.textContent = 'Verknuepfen';
            }
        } catch(e) {}
    },

    async robloxOpenLink() {
        const username = prompt('Roblox Benutzername:');
        if (!username) return;
        const u = Auth.user;
        if (!u?.discordId) return;

        try {
            const res = await fetch(apiUrl('/api/roblox/start-verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify({ discordId: u.discordId, robloxUsername: username })
            });
            const d = await res.json();
            if (!d.success) return alert('Fehler: ' + (d.error || 'Unbekannt'));

            const ok = confirm(`Fuege diesen Code in deine Roblox-Bio ein:\n\n${d.code}\n\nDann OK druecken um zu pruefen.`);
            if (!ok) return;

            const confirmRes = await fetch(apiUrl('/api/roblox/confirm-verify'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify({ discordId: u.discordId })
            });
            const cd = await confirmRes.json();
            if (cd.success) {
                alert('Erfolgreich verknuepft!');
                this.loadRobloxProfile();
            } else {
                alert('Fehler: ' + (cd.error || 'Code nicht gefunden'));
            }
        } catch(e) {
            alert('Fehler: ' + e.message);
        }
    },

    // ── Users ──
    renderUsers(users) {
        this._users = users;
        const list = document.getElementById('userList');
        const count = document.getElementById('onlineCount');
        if (!list) return;

        const onlineCount = users.filter(u => u.online).length;
        if (count) count.textContent = onlineCount;

        // Blockierte User komplett ausblenden
        const visible = users.filter(u => !this._isBlocked(u.username));

        const sorted = [...visible].sort((a, b) => {
            // 1. Ungelesene Nachrichten zuerst (desc)
            const ua = this._unreadCounts['@' + a.username] || 0;
            const ub = this._unreadCounts['@' + b.username] || 0;
            if (ua !== ub) return ub - ua;
            // 2. Online vor offline
            if (a.online !== b.online) return a.online ? -1 : 1;
            // 3. Role rank
            const rank = r => r === 'admin' ? 0 : r === 'staff' ? 1 : 2;
            return rank(a.role) - rank(b.role);
        });

        list.innerHTML = sorted.map(u => {
            const isOnline = u.online;
            const initial = (u.username || '?')[0].toUpperCase();
            const avatarInner = u.avatar
                ? `<img src="${escHtml(u.avatar)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span style="display:none;width:100%;height:100%;align-items:center;justify-content:center;">${initial}</span>`
                : initial;
            const roleBadge = u.role === 'admin' ? `<span class="user-role admin">ADMIN</span>` : u.role === 'staff' ? `<span class="user-role">STAFF</span>` : '';
            const unread = this._unreadCounts['@' + u.username] || 0;
            const unreadBadge = unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : '';
            const mutedIcon = this._isMuted(u.username) ? '<span class="muted-icon" title="Stumm">🔕</span>' : '';
            const unameEsc = escHtml(u.username);
            const avatarEsc = escHtml(u.avatar || '');

            return `<div class="user-item ${isOnline ? '' : 'offline'} ${this.currentChat === '@' + u.username ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}"
                onclick="App.openChat('@${unameEsc}', '${avatarEsc}')"
                oncontextmenu="App._showUserMenu(event, '${unameEsc}'); return false;"
                ontouchstart="App._longPressStart(event, '${unameEsc}')"
                ontouchend="App._longPressEnd(event)"
                ontouchmove="App._longPressEnd(event)"
                ontouchcancel="App._longPressEnd(event)">
                <div class="user-avatar">${avatarInner}<div class="status-dot ${isOnline ? '' : 'offline'}"></div></div>
                <span class="user-name">${unameEsc}</span>
                ${mutedIcon}
                ${roleBadge}
                ${unreadBadge}
            </div>`;
        }).join('');
    },

    // ── Long-Press / Context-Menu ──
    _longPressStart(ev, username) {
        this._longPressFired = false;
        if (this._longPressTimer) clearTimeout(this._longPressTimer);
        const touch = ev.touches?.[0];
        const x = touch?.clientX || 0;
        const y = touch?.clientY || 0;
        this._longPressTimer = setTimeout(() => {
            this._longPressFired = true;
            this._longPressTimer = null;
            try { if (navigator.vibrate) navigator.vibrate(30); } catch(_) {}
            this._showUserMenu({ clientX: x, clientY: y }, username);
        }, 450);
    },
    _longPressEnd(ev) {
        if (this._longPressTimer) { clearTimeout(this._longPressTimer); this._longPressTimer = null; }
    },

    _showUserMenu(ev, username) {
        // Existierendes Menu schliessen
        document.querySelectorAll('.user-context-menu').forEach(m => m.remove());

        if (ev.preventDefault) try { ev.preventDefault(); } catch(_) {}

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const menuW = 220;
        const menuH = 180;
        let x = (ev.clientX || vw/2);
        let y = (ev.clientY || vh/2);
        if (x + menuW > vw - 10) x = vw - menuW - 10;
        if (y + menuH > vh - 10) y = vh - menuH - 10;
        if (y < 10) y = 10;

        const blocked = this._isBlocked(username);
        const muted = this._isMuted(username);
        const unameEsc = escHtml(username);

        const menu = document.createElement('div');
        menu.className = 'user-context-menu';
        menu.style.cssText = `position:fixed; left:${x}px; top:${y}px; z-index:9999;`;
        menu.innerHTML = `
            <div class="ucm-header">${unameEsc}</div>
            <button class="ucm-btn" onclick="App._toggleMute('${unameEsc}'); App._closeUserMenu();">
                ${muted ? '🔔 Stummschaltung aufheben' : '🔕 Stummschalten'}
            </button>
            <button class="ucm-btn ${blocked ? '' : 'danger'}" onclick="App._toggleBlock('${unameEsc}'); App._closeUserMenu();">
                ${blocked ? '✓ Entblockieren' : '⛔ Blockieren'}
            </button>
            <button class="ucm-btn" onclick="App._closeUserMenu();">Abbrechen</button>
        `;
        document.body.appendChild(menu);

        // Schliessen bei Click ausserhalb
        setTimeout(() => {
            const handler = (e) => {
                if (!menu.contains(e.target)) {
                    this._closeUserMenu();
                    document.removeEventListener('click', handler, true);
                    document.removeEventListener('touchstart', handler, true);
                }
            };
            document.addEventListener('click', handler, true);
            document.addEventListener('touchstart', handler, true);
        }, 80);
    },
    _closeUserMenu() {
        document.querySelectorAll('.user-context-menu').forEach(m => m.remove());
    },

    // ── Chat ──
    showUserList() {
        document.getElementById('userListPanel').style.display = '';
        document.getElementById('chatPanel').classList.add('hidden');
        document.getElementById('chatBackBtn').classList.add('hidden');
        document.getElementById('chatHeaderName').textContent = '#general';
        document.getElementById('chatHeaderSub').textContent = 'Gruppenchat';
        document.getElementById('chatHeaderAvatar').style.display = 'none';
        this.currentChat = 'general';
        this._loadHistory();
    },

    openChat(name, avatar) {
        // Wenn ein Long-Press gerade das Menu getriggert hat, den nachfolgenden Click ignorieren
        if (this._longPressFired) { this._longPressFired = false; return; }
        this.currentChat = name;
        // Unread-Count fuer diese Konversation zuruecksetzen
        if (this._unreadCounts[name] > 0) {
            this._unreadCounts[name] = 0;
            this._saveSocial();
            if (this._users) this.renderUsers(this._users);
        }
        document.getElementById('userListPanel').style.display = 'none';
        document.getElementById('chatPanel').classList.remove('hidden');
        document.getElementById('chatBackBtn').classList.remove('hidden');

        const headerName = document.getElementById('chatHeaderName');
        const headerSub = document.getElementById('chatHeaderSub');
        const headerAvatar = document.getElementById('chatHeaderAvatar');

        if (name.startsWith('@')) {
            headerName.textContent = name;
            headerSub.textContent = 'Privatchat';
            if (avatar) {
                headerAvatar.innerHTML = `<img src="${escHtml(avatar)}">`;
                headerAvatar.style.display = 'block';
            }
        } else {
            headerName.textContent = '#' + name;
            headerSub.textContent = 'Gruppenchat';
            headerAvatar.style.display = 'none';
        }

        // Highlight in user list
        document.querySelectorAll('.user-item').forEach(el => el.classList.remove('active'));

        this._loadHistory();
        document.getElementById('chatInput')?.focus();
    },

    sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input || !input.value.trim()) return;
        const text = input.value.trim();
        input.value = '';
        const u = Auth.user;
        const channel = this.currentChat || 'general';

        const msgData = {
            id: Date.now(),
            username: u?.username || 'User',
            userId: u?.discordId || '',
            avatar: u?.avatar || '',
            text, message: text,
            to: channel,
            timestamp: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            status: 'sent',
        };

        if (socket?.connected) {
            socket.emit('send_message', msgData);
            socket.emit('typing_stop', { to: channel, username: u?.username });
        }

        this._displayMsg(msgData);
        this._saveMsg(msgData, channel);

        // Clear typing
        clearTimeout(this._typingTimeout);
        this._typingTimeout = null;
    },

    receiveMessage(msg) {
        const myUser = Auth.user?.username;
        // Blockierte User: Nachricht komplett droppen (kein Display, kein Save, kein Notify)
        if (msg.username !== myUser && this._isBlocked(msg.username)) return;

        const channel = this.currentChat || 'general';
        const from = msg.to || 'general';
        const isOwnEcho = msg.username === myUser;

        // Bestimme den Konversations-Key
        let convKey;
        if (from === 'general') convKey = 'general';
        else if (isOwnEcho) convKey = from; // '@target'
        else convKey = '@' + msg.username;

        const chatViewActive = document.querySelector('.view.active')?.id === 'view-chat';
        const inCurrentChat  = chatViewActive && channel === convKey;

        if (inCurrentChat) {
            this._displayMsg(msg);
            if (!isOwnEcho) {
                try { socket?.emit('msg_read', { msgId: msg.id, reader: myUser, sender: msg.username }); } catch(_) {}
            }
        } else if (!isOwnEcho) {
            // Unread-Count fuer diese Konversation erhoehen
            this._unreadCounts[convKey] = (this._unreadCounts[convKey] || 0) + 1;
            this._saveSocial();
            if (this._users) this.renderUsers(this._users);
            // Gemutete User: kein Ton/Vibration/Notification, nur Badge
            if (!this._isMuted(msg.username)) this._notify(msg);
        }
        this._saveMsg(msg, convKey);
    },

    _notify(msg) {
        const text = msg.text || msg.message || '';
        const title = msg.to === 'general' ? '#general' : msg.username;
        const body = (msg.to === 'general' ? msg.username + ': ' : '') + (text.startsWith('data:image') ? '[Bild]' : text.slice(0, 120));

        this._notifyRaw({
            title,
            body,
            icon: msg.avatar,
            tag: 'en-mobile-' + (msg.id || Date.now()),
            onClick: () => { try { window.focus(); } catch(_) {} if (msg.to !== 'general') this.openChat('@' + msg.username, msg.avatar); },
        });
    },

    // Zentraler Notification-Helper — nutzt Web-Notification API + Vibration + Beep
    _notifyRaw({ title, body, icon, tag, onClick, requireInteraction }) {
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                const n = new Notification(title || 'Emden Network', {
                    body: body || '',
                    icon: icon || undefined,
                    tag: tag || ('en-' + Date.now()),
                    requireInteraction: !!requireInteraction,
                });
                if (onClick) n.onclick = onClick;
            }
        } catch(e) {}
        try { if (navigator.vibrate) navigator.vibrate(requireInteraction ? [120, 60, 120, 60, 120] : 80); } catch(e) {}
        try { this._beep(); } catch(e) {}
    },

    _beep() {
        if (!this._audioCtx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            this._audioCtx = new AC();
        }
        const ctx = this._audioCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(880, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        o.start();
        o.stop(ctx.currentTime + 0.27);
    },

    requestNotificationPermission() {
        try {
            if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
                Notification.requestPermission().catch(() => {});
            }
        } catch(e) {}
    },

    _displayMsg(data) {
        const box = document.getElementById('chatMessages');
        if (!box) return;
        const u = Auth.user;
        const isOwn = data.username === u?.username;
        const text = data.text || data.message || '';
        const time = data.timestamp || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const initial = (data.username || 'U')[0].toUpperCase();
        const msgId = 'msg-' + (data.id || Date.now());

        if (box.querySelector(`#${msgId}`)) return;

        const avatarUrl = isOwn ? (u?.avatar || '') : (data.avatar || '');
        const avatarInner = avatarUrl
            ? `<img src="${escHtml(avatarUrl)}" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
            : initial;

        // Render content
        let content;
        if (text.startsWith('data:image/')) {
            content = `<img src="${text}" class="chat-embed-img">`;
        } else if (/^https?:\/\/\S+\.(?:gif|png|jpe?g|webp)$/i.test(text)) {
            content = `<img src="${escHtml(text)}" class="chat-embed-img" onerror="this.style.display='none'">`;
        } else if (/^https?:\/\/(?:media\.tenor\.com|media\d*\.giphy\.com)\/\S+$/i.test(text)) {
            content = `<img src="${escHtml(text)}" class="chat-embed-img" onerror="this.style.display='none'">`;
        } else {
            content = escHtml(text);
        }

        const st = data.status || 'sent';
        const checkColor = st === 'read' ? '#3b82f6' : 'var(--text-muted)';
        const checkText = (st === 'read' || st === 'delivered') ? '✓✓' : '✓';
        const checkmark = isOwn ? `<span class="msg-check" style="color:${checkColor}">${checkText}</span>` : '';

        const html = `<div class="msg-item ${isOwn ? 'own' : ''}" id="${msgId}">
            ${!isOwn ? `<div class="msg-avatar">${avatarInner}</div>` : ''}
            <div class="msg-body">
                <div class="msg-meta"><span class="msg-user">${isOwn ? 'Du' : escHtml(data.username)}</span><span class="msg-time">${time}</span>${checkmark}</div>
                <div class="msg-text">${content}</div>
            </div>
            ${isOwn ? `<div class="msg-avatar">${avatarInner}</div>` : ''}
        </div>`;

        box.insertAdjacentHTML('beforeend', html);
        while (box.children.length > 50) box.removeChild(box.firstChild);
        requestAnimationFrame(() => box.scrollTop = box.scrollHeight);
    },

    _saveMsg(data, channel) {
        try {
            let key = 'mchat_' + (channel || 'general');
            if (key.startsWith('mchat_@') && key === 'mchat_@' + Auth.user?.username) {
                key = 'mchat_@' + data.username;
            }
            const msgs = JSON.parse(localStorage.getItem(key) || '[]');
            msgs.push({
                id: data.id || Date.now(), username: data.username, userId: data.userId || '',
                avatar: data.avatar || '', text: data.text || data.message || '',
                to: data.to || channel, status: data.status || 'sent',
                timestamp: data.timestamp || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            });
            while (msgs.length > 30) msgs.shift();
            localStorage.setItem(key, JSON.stringify(msgs));
        } catch(e) {}
    },

    _loadHistory() {
        const box = document.getElementById('chatMessages');
        if (box) box.innerHTML = '';
        try {
            const key = 'mchat_' + (this.currentChat || 'general');
            const msgs = JSON.parse(localStorage.getItem(key) || '[]');
            msgs.forEach(m => this._displayMsg(m));
        } catch(e) {}
    },

    // ── File Upload ──
    attachFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) { alert('Max. 10 MB!'); return; }
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const scale = Math.min(1, 600 / img.width);
                    canvas.width = img.width * scale;
                    canvas.height = img.height * scale;
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    document.getElementById('chatInput').value = canvas.toDataURL('image/jpeg', 0.75);
                    this.sendMessage();
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        };
        input.click();
    },

    init() {
        if (Auth.load() && Auth.user) {
            this.showApp();
        }
        // Update-Check nach 2 Sekunden (nicht beim Start blockieren)
        setTimeout(() => this.checkForUpdate(), 2000);

        // Swipe-Navigation zwischen Tabs
        const tabOrder = ['home', 'chat', 'mod', 'team', 'settings'];
        let touchStartX = 0, touchStartY = 0, touchStartT = 0;
        const screen = document.getElementById('appScreen');
        if (screen) {
            screen.addEventListener('touchstart', (e) => {
                const t = e.touches[0];
                touchStartX = t.clientX; touchStartY = t.clientY; touchStartT = Date.now();
            }, { passive: true });
            screen.addEventListener('touchend', (e) => {
                const t = e.changedTouches[0];
                const dx = t.clientX - touchStartX;
                const dy = t.clientY - touchStartY;
                const dt = Date.now() - touchStartT;
                // Nur horizontale Swipes (nicht scrollen), schnell, mind. 60px
                if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.7 || dt > 600) return;
                // Nicht swipen wenn in Privat-Chat (zurück-Pfeil dort)
                if (this.currentChat && this.currentChat !== 'general') return;
                const active = document.querySelector('.view.active')?.id?.replace('view-', '');
                let idx = tabOrder.indexOf(active);
                if (idx < 0) return;
                if (dx < 0 && idx < tabOrder.length - 1) {
                    // Swipe links → nächster Tab (Mod nur wenn Staff)
                    let next = idx + 1;
                    if (tabOrder[next] === 'mod' && !document.querySelector('.nav-item[data-tab="mod"]')?.classList.contains('hidden') === false) {
                        // mod ist hidden? skip
                    }
                    const nextTab = tabOrder[next];
                    const navBtn = document.querySelector(`.nav-item[data-tab="${nextTab}"]`);
                    if (navBtn && !navBtn.classList.contains('hidden')) this.switchTab(nextTab);
                    else if (next + 1 < tabOrder.length) this.switchTab(tabOrder[next + 1]);
                } else if (dx > 0 && idx > 0) {
                    // Swipe rechts → vorheriger Tab
                    let prev = idx - 1;
                    const prevTab = tabOrder[prev];
                    const navBtn = document.querySelector(`.nav-item[data-tab="${prevTab}"]`);
                    if (navBtn && !navBtn.classList.contains('hidden')) this.switchTab(prevTab);
                    else if (prev - 1 >= 0) this.switchTab(tabOrder[prev - 1]);
                }
            }, { passive: true });
        }

        // Mod-Suche: Enter-Key
        document.getElementById('modSearchInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); this.modSearchUser(); }
        });
        // Typing indicator
        document.getElementById('chatInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { this.sendMessage(); return; }
            if (!this._typingTimeout && socket?.connected) {
                socket.emit('typing_start', { to: this.currentChat || 'general', username: Auth.user?.username });
            }
            clearTimeout(this._typingTimeout);
            this._typingTimeout = setTimeout(() => {
                socket?.emit('typing_stop', { to: this.currentChat || 'general', username: Auth.user?.username });
                this._typingTimeout = null;
            }, 2000);
        });

        // Paste images
        document.addEventListener('paste', (e) => {
            if (document.activeElement?.id !== 'chatInput') return;
            for (const item of (e.clipboardData?.items || [])) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (!file || file.size > 10 * 1024 * 1024) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                        const img = new Image();
                        img.onload = () => {
                            const canvas = document.createElement('canvas');
                            const scale = Math.min(1, 600 / img.width);
                            canvas.width = img.width * scale;
                            canvas.height = img.height * scale;
                            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                            document.getElementById('chatInput').value = canvas.toDataURL('image/jpeg', 0.75);
                            App.sendMessage();
                        };
                        img.src = reader.result;
                    };
                    reader.readAsDataURL(file);
                    return;
                }
            }
        });
    },

    // ── Moderation ──
    _modSelectedUser: null,

    async modSearchUser() {
        if (!this._isStaff()) { this.switchTab('home'); return; }
        const query = document.getElementById('modSearchInput').value.trim();
        const result = document.getElementById('modSearchResult');
        if (!query) { result.innerHTML = ''; return; }
        result.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:13px;">Suche...</div>';

        try {
            const res = await fetch(apiUrl('/api/roblox-search', { q: query }));
            const data = await res.json();
            const users = data.users || [];
            if (!users.length) {
                result.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:13px;">Kein User gefunden.</div>';
                return;
            }
            this._modShowSearchResults(users);
        } catch(e) {
            result.innerHTML = `<div class="mod-status error">Fehler: ${escHtml(e.message)}</div>`;
        }
    },

    _modShowSearchResults(users) {
        const result = document.getElementById('modSearchResult');
        if (!users.length) {
            result.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:13px;">Kein User gefunden.</div>';
            return;
        }
        result.innerHTML = users.map(u => `
            <div class="mod-search-result-item" onclick='App.modSelectUser(${JSON.stringify({ id: u.id, name: u.name, displayName: u.displayName || u.name, created: u.created, avatar: u.avatar || "" }).replace(/'/g, "&#39;")})'>
                <img src="${u.avatar || ''}" onerror="this.style.opacity=0">
                <div class="mod-search-result-info">
                    <div class="mod-search-result-name">${escHtml(u.displayName || u.name)}</div>
                    <div class="mod-search-result-username">@${escHtml(u.name)} · ${u.id}</div>
                </div>
            </div>
        `).join('');
    },

    modSelectUser(user) {
        this._modSelectedUser = user;
        document.getElementById('modSearchResult').innerHTML = '';
        document.getElementById('modSearchInput').value = '';

        document.getElementById('modUserCard').classList.remove('hidden');
        document.getElementById('modUserAvatar').src = user.avatar || '';
        document.getElementById('modUserName').textContent = user.displayName || user.name;
        document.getElementById('modUserUsername').textContent = '@' + user.name;
        document.getElementById('modUserId').textContent = 'ID: ' + user.id;

        // History laden
        this.modLoadHistory(user.id);
    },

    modClearUser() {
        this._modSelectedUser = null;
        document.getElementById('modUserCard').classList.add('hidden');
        document.getElementById('modReasonInput').value = '';
        document.getElementById('modStatus').classList.add('hidden');
        document.getElementById('modHistoryList').classList.add('hidden');
    },

    modToggleHistory() {
        document.getElementById('modHistoryList').classList.toggle('hidden');
    },

    async modLoadHistory(userId) {
        try {
            const res = await fetch(apiUrl('/api/mod-history', { userId, discordId: Auth.user?.discordId || '' }), { headers: { 'x-api-key': CONFIG.API_KEY } });
            const data = await res.json();
            const list = document.getElementById('modHistoryList');
            const count = document.getElementById('modHistoryCount');
            if (!data.success || !data.entries) { count.textContent = '0'; list.innerHTML = ''; return; }

            count.textContent = data.entries.length;
            const entries = data.entries.slice(-10).reverse();
            list.innerHTML = entries.map(e => {
                const cls = (e.action || 'warn').toLowerCase().replace(/\s+/g, '');
                const date = new Date(e.date).toLocaleDateString('de-DE');
                return `<div class="mod-history-item ${cls.includes('ban') && cls.includes('day') ? 'dayban' : cls.includes('ban') ? 'ban' : cls.includes('kick') ? 'kick' : cls.includes('notiz') ? 'note' : 'warn'}">
                    <div class="mod-history-action">${escHtml(e.action)}</div>
                    <div class="mod-history-reason">${escHtml(e.reason || 'Kein Grund')}</div>
                    <div class="mod-history-meta">@${escHtml(e.moderator || '?')} · ${date}</div>
                </div>`;
            }).join('');
        } catch(e) {
            document.getElementById('modHistoryCount').textContent = '?';
        }
    },

    async modSubmit(action) {
        if (!this._isStaff()) { this._modStatus('error', 'Keine Berechtigung.'); this.switchTab('home'); return; }
        if (!this._modSelectedUser) return;
        const reason = document.getElementById('modReasonInput').value.trim();
        if (!reason) {
            this._modStatus('error', 'Bitte einen Grund eingeben.');
            return;
        }
        const u = this._modSelectedUser;
        const me = Auth.user;
        if (!me) { this._modStatus('error', 'Nicht eingeloggt.'); return; }

        this._modStatus('info', `Sende ${action}...`);

        try {
            const res = await fetch(apiUrl('/api/mod-action'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify({
                    userId: String(u.id),
                    username: u.name,
                    displayName: u.displayName || u.name,
                    avatar: u.avatar || '',
                    created: u.created ? new Date(u.created).toLocaleDateString('de-DE') : '',
                    reason,
                    action,
                    moderator: me.username,
                    moderatorDiscordId: me.discordId,
                    moderatorAvatar: me.avatar || '',
                })
            });
            const data = await res.json();
            if (data.success) {
                this._modStatus('success', `✓ ${action} fuer ${u.displayName || u.name} erstellt!`);
                document.getElementById('modReasonInput').value = '';
                // History neu laden
                setTimeout(() => this.modLoadHistory(u.id), 500);
                // Haptic feedback wenn verfuegbar
                try { window.Capacitor?.Plugins?.Haptics?.impact({ style: 'medium' }); } catch(_) {}
            } else {
                this._modStatus('error', data.error || 'Fehler beim Senden.');
            }
        } catch(e) {
            this._modStatus('error', 'Server nicht erreichbar.');
        }
    },

    _modStatus(type, msg) {
        const el = document.getElementById('modStatus');
        el.className = 'mod-status ' + type;
        el.textContent = msg;
        el.classList.remove('hidden');
        if (type === 'success') {
            setTimeout(() => el.classList.add('hidden'), 4000);
        }
    },

    // ── Auto-Update ──
    _updateInfo: null,

    async checkForUpdate() {
        try {
            const res = await fetch(apiUrl('/api/mobile-version'));
            const data = await res.json();
            if (!data.success) return;
            if (compareVersions(data.version, MOBILE_VERSION) > 0) {
                this._updateInfo = data;
                this._showUpdateBanner(data);
            }
        } catch(e) {
            console.log('[Update] Check failed:', e.message);
        }
    },

    _showUpdateBanner(info) {
        const banner = document.getElementById('updateBanner');
        if (!banner) return;
        document.getElementById('updateVersion').textContent = `v${info.version}`;
        const changelog = (info.changelog || []).slice(0, 3).map(c => `• ${escHtml(c)}`).join('<br>');
        document.getElementById('updateChangelog').innerHTML = changelog || 'Keine Details';
        banner.classList.remove('hidden');
    },

    _hideUpdateBanner() {
        document.getElementById('updateBanner')?.classList.add('hidden');
    },

    async installUpdate() {
        if (!this._updateInfo) return;
        const btn = document.getElementById('updateBtn');
        btn.textContent = 'Laedt...';
        btn.disabled = true;

        try {
            // Versuche nativen Download via Capacitor
            if (window.Capacitor?.Plugins?.Browser) {
                // Oeffne APK-URL im Browser → Android Download Manager uebernimmt
                await window.Capacitor.Plugins.Browser.open({ url: this._updateInfo.apkUrl });
            } else {
                // Fallback: normaler Link
                window.open(this._updateInfo.apkUrl, '_system');
            }
            btn.textContent = 'Download gestartet';
            setTimeout(() => {
                btn.textContent = 'Jetzt installieren';
                btn.disabled = false;
            }, 3000);
        } catch(e) {
            btn.textContent = 'Fehler - Retry';
            btn.disabled = false;
        }
    },
};

// ════════════════════════════════════════════════════════════════
// SUPPORT CASES (Mobile, Staff-only)
// ════════════════════════════════════════════════════════════════
const SupportMobile = (() => {
    const cases = new Map();

    function escapeHtml(s) {
        if (typeof s !== 'string') return '';
        return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function secondsAgo(ts) {
        const d = Math.floor((Date.now() - (ts||0)) / 1000);
        if (d < 60) return d + 's';
        return Math.floor(d/60) + 'm ' + (d%60) + 's';
    }

    function render() {
        const card = document.getElementById('homeSupportCases');
        const list = document.getElementById('supMobileList');
        const sub = document.getElementById('supMobileSub');
        if (!card || !list) return;
        if (!App._isStaff() || cases.size === 0) {
            card.classList.add('hidden');
            return;
        }
        const arr = Array.from(cases.values()).sort((a,b) => a.createdAt - b.createdAt);
        card.classList.remove('hidden');
        if (sub) sub.textContent = arr.length + ' offen';

        list.innerHTML = arr.map(c => {
            const taken = c.status === 'taken';
            const av = c.avatarUrl
                ? `<img src="${escapeHtml(c.avatarUrl)}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,179,71,.4);flex-shrink:0;">`
                : `<div style="width:40px;height:40px;border-radius:50%;background:rgba(255,179,71,.15);color:#ffb347;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">${escapeHtml((c.username||'?').charAt(0).toUpperCase())}</div>`;
            return `
                <div style="display:flex;gap:10px;align-items:center;padding:10px;border-radius:10px;background:rgba(255,179,71,.08);border:1px solid rgba(255,179,71,.25);" data-case-id="${escapeHtml(c.caseId)}">
                    ${av}
                    <div style="flex:1;min-width:0;">
                        <div style="font-size:13px;font-weight:600;color:#fff;">${escapeHtml(c.username)}</div>
                        <div style="font-size:10px;color:rgba(255,255,255,.55);margin-top:1px;" data-ts="${c.createdAt}" class="sup-mobile-wait">wartet ${secondsAgo(c.createdAt)}${taken ? ' · übernommen' : ''}</div>
                    </div>
                    <button onclick="SupportMobile.take('${escapeHtml(c.caseId)}', this)" ${taken ? 'disabled' : ''} style="padding:8px 12px;border:none;border-radius:8px;background:${taken ? 'rgba(255,255,255,.08)' : 'linear-gradient(135deg,#22c55e,#16a34a)'};color:${taken ? 'rgba(255,255,255,.5)' : '#fff'};font-size:11px;font-weight:700;cursor:${taken ? 'default' : 'pointer'};white-space:nowrap;">
                        ${taken ? '✓' : '→ Übernehmen'}
                    </button>
                </div>
            `;
        }).join('');
    }

    function tickTimes() {
        document.querySelectorAll('.sup-mobile-wait').forEach(el => {
            const ts = parseInt(el.dataset.ts, 10);
            if (isNaN(ts)) return;
            const cid = el.closest('[data-case-id]')?.dataset.caseId;
            const c = cid ? cases.get(cid) : null;
            const taken = c && c.status === 'taken';
            el.textContent = 'wartet ' + secondsAgo(ts) + (taken ? ' · übernommen' : '');
        });
    }

    async function take(caseId, btn) {
        const u = Auth?.user;
        if (!u) return;
        if (btn) { btn.disabled = true; btn.textContent = '...'; }
        try {
            const r = await fetch(CONFIG.API_URL_DIRECT + '/api/support-case/take', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify({ caseId, discordId: u.discordId }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) {
                if (btn) { btn.disabled = false; btn.textContent = '→ Übernehmen'; }
                alert(d.error || ('HTTP ' + r.status));
                return;
            }
            App._notifyRaw?.({ title: 'Übernommen', body: `${d.userName} → ${d.movedToChannelName}` });
        } catch (e) {
            console.error('[SupportMobile] take:', e);
            if (btn) { btn.disabled = false; btn.textContent = '→ Übernehmen'; }
        }
    }

    function add(c) { if (!c?.caseId) return; cases.set(c.caseId, c); render(); }
    function update(c) {
        if (!c?.caseId) return;
        const prev = cases.get(c.caseId);
        cases.set(c.caseId, { ...(prev || {}), ...c });
        render();
    }
    function remove(caseId) { if (!caseId) return; cases.delete(caseId); render(); }

    async function loadInitial() {
        const u = Auth?.user;
        if (!u || !App._isStaff()) return;
        try {
            const r = await fetch(
                `${CONFIG.API_URL_DIRECT}/api/support-cases/open?discordId=${encodeURIComponent(u.discordId)}`,
                { headers: { 'x-api-key': CONFIG.API_KEY } }
            );
            if (!r.ok) return;
            const d = await r.json();
            if (Array.isArray(d.cases)) {
                cases.clear();
                d.cases.forEach(c => cases.set(c.caseId, c));
                render();
            }
        } catch (_) {}
    }

    function init() {
        setInterval(tickTimes, 1000);
        setTimeout(loadInitial, 3500);
    }

    return { init, add, update, remove, take, render };
})();
window.SupportMobile = SupportMobile;

// Boot
document.addEventListener('DOMContentLoaded', () => {
    App.init();
    SupportMobile.init();
});
