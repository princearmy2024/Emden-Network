/**
 * NEXUS DASHBOARD - renderer.js
 * Frontend-Logik (Renderer-Prozess)
 *
 * Architektur:
 *   - AuthService:         Login / Verifizierung / Session
 *   - ApiService:          HTTP-Anfragen (TODO: echte Endpoints)
 *   - WebSocketService:    Realtime-Verbindung (TODO: echte WS-URL)
 *   - NotificationService: Toast + Native Notifications
 *   - RoleService:         Berechtigungen
 *   - App:                 Globaler Controller
 */

'use strict';

// =============================================================
// CONFIG — Bot-API
// =============================================================
const CONFIG = {
    API_URL: 'http://91.98.124.212:5009',
    API_KEY: 'emden-super-secret-key-2026',
};

// =============================================================
// 1. AUTH SERVICE
// TODO: Alle Mock-Werte durch echte API-Aufrufe ersetzen
// =============================================================
const AuthService = {
    session: null,

    /**
     * Verifiziert einen Code gegen die echte Bot-API.
     * Fallback auf Demo-Codes wenn CONFIG.DEMO_MODE === true.
     */
    async verify(code) {
        // === DEMO FALLBACK ===
        if (CONFIG.DEMO_MODE) {
            await sleep(900);
            const demo = {
                'NEXUS-DEMO': { username: 'DemoUser', role: 'user',  discordId: '000000000' },
                'NEXUS-ADMIN':{ username: 'Admin',    role: 'admin', discordId: '111111111' },
                'EN-DEMO':    { username: 'DemoUser', role: 'user',  discordId: '000000000' },
                'EN-ADMIN':   { username: 'Admin',    role: 'admin', discordId: '111111111' },
            };
            const d = demo[code.trim().toUpperCase()];
            if (d) {
                this.session = { token: 'demo_' + Date.now(), user: { ...d, id: 1 } };
                this.saveSession();
                return { success: true, user: this.session.user };
            }
            return { success: false, error: 'Ungültiger Code.' };
        }

        // === ECHTE BOT-API ===
        try {
            const res = await fetch(`${CONFIG.API_URL}/api/verify`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': CONFIG.API_KEY,
                },
                body: JSON.stringify({ code: code.trim() }),
                signal: AbortSignal.timeout(8000), // 8s Timeout
            });

            const data = await res.json();

            if (data.success && data.user) {
                this.session = { token: 'bot_' + Date.now(), user: data.user };
                this.saveSession();
                return { success: true, user: this.session.user };
            }
            return { success: false, error: data.error || 'Ungültiger Code.' };
        } catch (err) {
            console.error('[AuthService] API Fehler:', err);
            if (err.name === 'TimeoutError') {
                return { success: false, error: 'Server nicht erreichbar. Ist der Bot online?' };
            }
            return { success: false, error: 'Verbindungsfehler: ' + err.message };
        }
    },

    saveSession() {
        try { localStorage.setItem('nexus_session', JSON.stringify(this.session)); } catch (e) { }
    },

    loadSession() {
        try {
            const raw = localStorage.getItem('nexus_session');
            if (raw) { this.session = JSON.parse(raw); return true; }
        } catch (e) { }
        return false;
    },

    logout() {
        this.session = null;
        try { localStorage.removeItem('nexus_session'); } catch (e) { }
    },

    getUser() { return this.session?.user || null; },
    isLoggedIn() { return !!this.session?.token; },
};

// =============================================================
// 2. API SERVICE
// =============================================================
const ApiService = {
    async get(endpoint) {
        try {
            const res = await fetch(`${CONFIG.API_URL}${endpoint}`, {
                headers: { 'x-api-key': CONFIG.API_KEY },
                signal: AbortSignal.timeout(5000),
            });
            return res.json();
        } catch (e) {
            console.warn('[ApiService] GET fehlgeschlagen:', endpoint, e.message);
            return null;
        }
    },

    async post(endpoint, body) {
        try {
            const res = await fetch(`${CONFIG.API_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(5000),
            });
            return res.json();
        } catch (e) {
            console.warn('[ApiService] POST fehlgeschlagen:', endpoint, e.message);
            return null;
        }
    },
};

// =============================================================
// 3. WEBSOCKET SERVICE (Status-Polling via HTTP)
// =============================================================
const WebSocketService = {
    _pollInterval: null,
    _heartbeatInterval: null,
    listeners: {},

    connect() {
        // Sofort Status holen + Heartbeat senden
        this._fetchStatus();
        this._sendHeartbeat();

        // Alle 30 Sekunden Status + Heartbeat
        this._pollInterval     = setInterval(() => this._fetchStatus(),    30000);
        this._heartbeatInterval = setInterval(() => this._sendHeartbeat(), 30000);
    },

    async _sendHeartbeat() {
        const session = SessionService.getSession();
        if (!session?.user) return;
        await ApiService.post('/api/heartbeat', {
            discordId: session.user.discordId,
            username:  session.user.username,
            avatar:    session.user.avatar,
        });
    },

    async _fetchStatus() {
        const data = await ApiService.get('/api/status');
        if (data?.online) {
            App.setConnectionStatus('online');

            // Metric-Karten
            const el = document.getElementById('statServers');
            if (el && data.members) el.textContent = data.members;

            // Live-Panel rechts befüllen
            const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
            setEl('liveMembers', data.members  ?? '—');
            setEl('liveOnline',  data.onlineMembers ?? '—');
            setEl('dashboardOnlineCount', data.dashboardOnline ?? '—');
            setEl('liveLastUpdate', new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

            // Uptime formatieren
            if (data.uptimeSec != null) {
                const h = Math.floor(data.uptimeSec / 3600);
                const m = Math.floor((data.uptimeSec % 3600) / 60);
                setEl('liveUptime', `${h}h ${m}m`);
                  // Dashboard-User-Liste rendern (sortiert: Admin → Staff → User)
            const list = document.getElementById('dashboardUserList');
            if (list && data.dashboardUsers) {
                if (data.dashboardUsers.length === 0) {
                    list.innerHTML = `<div class="ovn-node" style="opacity:0.4">
                        <div class="ovn-info">
                            <div class="ovn-dot"></div>
                            <span style="font-size:11px;color:var(--text-muted)">Niemand online</span>
                        </div></div>`;
                } else {
                    // Sortierung: admin zuerst, dann staff, dann user
                    const sorted = [...data.dashboardUsers].sort((a, b) => {
                        const rank = r => r === 'admin' ? 0 : r === 'staff' ? 1 : 2;
                        return rank(a.role) - rank(b.role);
                    });

                    const avatarEl = u => u.avatar
                        ? `<img src="${u.avatar}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'">`
                        : `<div style="width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:var(--text-muted);flex-shrink:0;">${(u.username||'?')[0].toUpperCase()}</div>`;

                    const badgeEl = u => {
                        if (u.role === 'admin') return `<span class="ovn-role-badge admin">Admin</span>`;
                        if (u.role === 'staff') return `<span class="ovn-role-badge staff">Staff</span>`;
                        return ``;
                    };

                    list.innerHTML = sorted.map(u => `
                        <div class="ovn-node">
                            <div class="ovn-info">
                                <div class="ovn-dot online"></div>
                                ${avatarEl(u)}
                                <span class="ovn-name">${u.username}</span>
                            </div>
                            ${badgeEl(u)}
                        </div>`).join('');
                }
            }
          }
        } else {
            App.setConnectionStatus('offline');
        }
    },

    on(event, cb) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
    },
    emit(event, data) {
        (this.listeners[event] || []).forEach(cb => cb(data));
    },
    disconnect() {
        if (this._pollInterval)      clearInterval(this._pollInterval);
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        this._pollInterval = this._heartbeatInterval = null;
    },
};

// =============================================================
// 4. NOTIFICATION SERVICE
// =============================================================
const NotificationService = {
    /**
     * Zeigt einen Toast unten rechts.
     * @param {string} title
     * @param {string} message
     * @param {'info'|'success'|'warn'|'error'} type
     */
    show(title, message, type = 'info') {
        const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
        const container = document.getElementById('toastContainer');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
      <div class="toast-icon">${icons[type] || 'ℹ️'}</div>
      <div class="toast-content">
        <div class="toast-title">${escHtml(title)}</div>
        <div class="toast-msg">${escHtml(message)}</div>
      </div>
      <div class="toast-progress"></div>
    `;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.animation = 'toastOut 0.3s ease forwards';
            setTimeout(() => toast.remove(), 300);
        }, 4000);

        // Optional: Native Desktop Notification
        // window.electronAPI?.showNativeNotification(title, message);
    },
};

// =============================================================
// 5. ROLE SERVICE
// =============================================================
const RoleService = {
    isAdmin() { return AuthService.getUser()?.role === 'admin'; },
    hasPermission(perm) {
        // TODO: Berechtigungsmatrix aus Server laden
        if (this.isAdmin()) return true;
        return false;
    },
};

// =============================================================
// MOCK DATA
// =============================================================
const MockData = {
    servers: [
        { id: 1, name: 'Node-1 (EU)', status: 'online', ip: '10.0.0.1', ping: 12, uptime: '99.9%' },
        { id: 2, name: 'Node-2 (US)', status: 'online', ip: '10.0.0.2', ping: 38, uptime: '99.7%' },
        { id: 3, name: 'Node-3 (EU)', status: 'warning', ip: '10.0.0.3', ping: 95, uptime: '97.2%' },
        { id: 4, name: 'Node-4 (AS)', status: 'offline', ip: '10.0.0.4', ping: 0, uptime: '—' },
    ],
    channels: [
        { id: 1, name: 'general', desc: 'Allgemeiner Kanal', members: 12 },
        { id: 2, name: 'announcements', desc: 'Wichtige Ankündigungen', members: 45 },
        { id: 3, name: 'support', desc: 'Hilfe & Support', members: 8 },
        { id: 4, name: 'dev-ops', desc: 'Technische Diskussionen', members: 6 },
        { id: 5, name: 'random', desc: 'Smalltalk', members: 21 },
    ],
};

// =============================================================
// HELPER
// =============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// =============================================================
// MAIN APP CONTROLLER
// =============================================================
const App = {
    currentView: 'overview',
    currentChat: 'general',

    // --- INIT ---
    async init() {
        // Custom Titlebar
        document.getElementById('btnMin')?.addEventListener('click', () => window.electronAPI?.minimizeWindow());
        document.getElementById('btnMax')?.addEventListener('click', () => window.electronAPI?.maximizeWindow());
        document.getElementById('btnClose')?.addEventListener('click', () => window.electronAPI?.closeWindow());

        // Live clock
        this.startClock();

        // Splash → Login oder Dashboard
        await this.runSplash();

        if (AuthService.loadSession() && AuthService.isLoggedIn()) {
            this.showDashboard(AuthService.getUser());
        } else {
            this.showScreen('loginScreen');
            this.initLoginHandlers();
        }
    },

    // --- SPLASH ---
    async runSplash() {
        const bar = document.getElementById('loaderBar');
        const status = document.getElementById('loaderStatus');
        const steps = [
            [15, 'Lade Konfiguration...'],
            [35, 'Initialisiere Services...'],
            [60, 'Verbinde mit Netzwerk...'],
            [80, 'Lade Benutzeroberfläche...'],
            [100, 'Bereit.'],
        ];
        for (const [pct, msg] of steps) {
            bar.style.width = pct + '%';
            status.textContent = msg;
            await sleep(380);
        }
        await sleep(400);
    },

    // --- SCREEN TRANSITIONS ---
    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id)?.classList.add('active');
    },

    // --- LOGIN ---
    initLoginHandlers() {
        const btnVerify = document.getElementById('btnVerify');
        const btnDiscord = document.getElementById('btnDiscord');
        const input = document.getElementById('verifyInput');

        btnVerify.addEventListener('click', () => this.doVerify());
        input.addEventListener('keydown', e => { if (e.key === 'Enter') this.doVerify(); });

        btnDiscord.addEventListener('click', () => {
            // TODO: Discord OAuth-Flow starten oder Deep-Link zum Bot senden
            this.setLoginStatus('info', 'Warte auf Discord...');
            NotificationService.show('Discord', 'Bot-Verknüpfung wird bald verfügbar sein.', 'info');
            setTimeout(() => this.setLoginStatus('default', 'Bereit zur Verbindung'), 3000);
        });
    },

    async doVerify() {
        const input = document.getElementById('verifyInput');
        const code = input.value.trim();
        if (!code) { this.setLoginStatus('warn', 'Bitte Code eingeben.'); return; }

        const btn = document.getElementById('btnVerify');
        const btnText = document.getElementById('btnVerifyText');
        const spinner = document.getElementById('btnSpinner');
        btn.disabled = true;
        btnText.classList.add('hidden');
        spinner.classList.remove('hidden');
        this.setLoginStatus('info', 'Verifiziere...');

        const result = await AuthService.verify(code);

        btn.disabled = false;
        btnText.classList.remove('hidden');
        spinner.classList.add('hidden');

        if (result.success) {
            this.setLoginStatus('success', 'Code korrekt! Lade Dashboard...');
            await sleep(700);
            this.showDashboard(result.user);
        } else {
            this.setLoginStatus('error', result.error || 'Verbindung fehlgeschlagen.');
        }
    },

    setLoginStatus(type, text) {
        const dot = document.getElementById('statusDot');
        const span = document.getElementById('statusText');
        dot.className = 'status-dot';
        if (type === 'success') dot.classList.add('online');
        else if (type === 'warn' || type === 'error') dot.classList.add(type === 'error' ? 'error' : 'warn');
        else if (type === 'info') dot.classList.add('online');
        span.textContent = text;
    },

    // --- DASHBOARD SETUP ---
    showDashboard(user) {
        this.applyUser(user);
        this.renderChannels();
        this.renderServers();
        this.showScreen('dashboardScreen');
        this.navigate('overview');
        WebSocketService.connect();

        // Demo: Notifications nach kurzer Zeit
        setTimeout(() => {
            NotificationService.show('Neue Nachricht', 'Alex: Hey, bist du da?', 'info');
        }, 8000);
        setTimeout(() => {
            NotificationService.show('Warnung', 'Node-3 CPU > 90%', 'warn');
        }, 14000);
    },

    applyUser(user) {
        const initial = (user.username || 'U')[0].toUpperCase();

        // Hilfsfunktion: Avatar-Element mit Profilbild oder Initial befüllen
        const setAvatar = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (user.avatar) {
                el.innerHTML = `<img src="${user.avatar}" alt="Avatar"
                    style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"
                    onerror="this.remove(); this.parentElement.textContent='${initial}';">`;
                el.textContent = '';
            } else {
                el.textContent = initial;
            }
        };

        // Sidebar
        document.getElementById('sidebarUsername').textContent = user.username;
        document.getElementById('sidebarRole').textContent = user.role === 'admin' ? '⚡ Administrator' : 'Mitglied';
        setAvatar('sidebarAvatar');
        // Topbar
        setAvatar('topbarAvatar');
        // Chat
        setAvatar('chatOwnAvatar');
        setAvatar('walkieOwnAvatar');
        // Settings
        document.getElementById('settingsUsername').textContent = user.username;
        document.getElementById('settingsRole').textContent = user.role === 'admin' ? 'Administrator' : 'Standard-Nutzer';
        setAvatar('settingsAvatar');
        // Overview hero
        const ovUser = document.getElementById('overviewUsername');
        if (ovUser) ovUser.textContent = user.username;
        document.getElementById('welcomeMsg') && (document.getElementById('welcomeMsg').textContent = `Willkommen zurück, ${user.username}!`);

        // Admin-Elemente
        if (RoleService.isAdmin()) {
            document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
        }
    },

    // --- NAVIGATION ---
    navigate(view) {
        this.currentView = view;

        // Nav Items
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.view === view);
        });

        // Views
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById('view-' + view);
        if (target) {
            target.classList.add('active');
        }

        // Topbar title
        const labels = {
            overview: ['Dashboard', 'Übersicht'],
            messages: ['Nachrichten', 'Kommunikation'],
            notifications: ['Benachrichtigungen', 'Alerts & Meldungen'],
            channels: ['Channels', 'Kanal-Verwaltung'],
            walkie: ['Walkie-Talkie', 'Sprachkommunikation'],
            servers: ['Server', 'System-Übersicht'],
            settings: ['Einstellungen', 'Konfiguration'],
            admin: ['Admin Panel', 'Eingeschränkter Bereich'],
        };
        const [title, sub] = labels[view] || ['Dashboard', ''];
        document.getElementById('topbarTitle').textContent = title;
        document.getElementById('topbarBreadcrumb').textContent = sub;
    },

    // --- CONNECTION STATUS ---
    setConnectionStatus(state) {
        const dot = document.querySelector('.conn-dot');
        const text = document.getElementById('connText');
        if (state === 'online') {
            dot.className = 'conn-dot pulse';
            text.textContent = 'Live verbunden';
            dot.style.background = 'var(--status-online)';
        } else if (state === 'reconnect') {
            dot.className = 'conn-dot';
            text.textContent = 'Reconnect...';
            dot.style.background = 'var(--status-warn)';
        } else if (state === 'offline') {
            dot.className = 'conn-dot';
            text.textContent = 'Getrennt';
            dot.style.background = 'var(--status-danger)';
        }
    },

    // --- LIVE CLOCK ---
    startClock() {
        const tick = () => {
            const now = new Date();
            const hh = String(now.getHours()).padStart(2, '0');
            const mm = String(now.getMinutes()).padStart(2, '0');
            const clockEl = document.getElementById('ovClock');
            const dateEl  = document.getElementById('ovDate');
            if (clockEl) clockEl.textContent = `${hh}:${mm}`;
            if (dateEl) {
                const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
                dateEl.textContent = now.toLocaleDateString('de-DE', opts);
            }
            // Dynamic greeting
            const h = now.getHours();
            const greeting = h < 12 ? 'Guten Morgen,' : h < 18 ? 'Guten Tag,' : 'Guten Abend,';
            const greetNode = document.querySelector('.ov-greeting');
            if (greetNode) {
                greetNode.childNodes[0].textContent = greeting + ' ';
            }
        };
        tick();
        setInterval(tick, 30000);
    },

    // --- MESSAGES ---
    selectChat(name) {
        this.currentChat = name;
        document.querySelectorAll('.chat-item').forEach(i => i.classList.remove('active'));
        document.querySelector(`[onclick="App.selectChat('${name}')"]`)?.classList.add('active');
        document.getElementById('activeChatName').textContent = '#' + name;
    },

    sendMessage() {
        const input = document.getElementById('chatInput');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';

        const user = AuthService.getUser();
        const msgs = document.getElementById('chatMessages');
        const initial = (user?.username || 'U')[0].toUpperCase();
        const msg = document.createElement('div');
        msg.className = 'msg-item own';
        msg.innerHTML = `
      <div class="msg-body">
        <div class="msg-meta"><span class="msg-user">Du</span><span class="msg-time">${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span></div>
        <div class="msg-text">${escHtml(text)}</div>
      </div>
      <div class="msg-avatar you">${initial}</div>
    `;
        msgs.appendChild(msg);
        msgs.scrollTop = msgs.scrollHeight;

        // TODO: Via WebSocketService oder ApiService senden
        // WebSocketService.emit('message', { channel: this.currentChat, text });
    },

    // --- CHANNELS ---
    renderChannels() {
        const list = document.getElementById('channelList');
        list.innerHTML = MockData.channels.map(ch => `
      <div class="channel-item" id="channel-${ch.id}">
        <div class="channel-hash">#</div>
        <div class="channel-info">
          <div class="channel-name">${escHtml(ch.name)}</div>
          <div class="channel-desc">${escHtml(ch.desc)} · ${ch.members} Mitglieder</div>
        </div>
        <div class="channel-actions">
          <button class="icon-btn" title="Bearbeiten" onclick="App.editChannel(${ch.id})">✏️</button>
          <button class="icon-btn danger" title="Löschen" onclick="App.deleteChannel(${ch.id})">🗑️</button>
        </div>
      </div>
    `).join('');
    },

    editChannel(id) {
        const ch = MockData.channels.find(c => c.id === id);
        if (!ch) return;
        this.showModal('editChannel', ch);
    },

    deleteChannel(id) {
        const idx = MockData.channels.findIndex(c => c.id === id);
        if (idx < 0) return;
        const name = MockData.channels[idx].name;
        MockData.channels.splice(idx, 1);
        this.renderChannels();
        NotificationService.show('Channel gelöscht', `#${name} wurde entfernt.`, 'warn');
    },

    // --- SERVERS ---
    renderServers() {
        const grid = document.getElementById('serverGrid');
        const pingClass = p => p === 0 ? '' : p < 50 ? 'fast' : 'medium';
        grid.innerHTML = MockData.servers.map(srv => `
      <div class="server-card ${srv.status}">
        <div class="srv-header">
          <div class="srv-name">${escHtml(srv.name)}</div>
          <div class="srv-status-badge ${srv.status}">${srv.status.toUpperCase()}</div>
        </div>
        <div class="srv-meta">
          <div>IP: <span>${srv.ip}</span></div>
          <div>Ping: <span class="srv-ping ${pingClass(srv.ping)}">${srv.ping > 0 ? srv.ping + ' ms' : '—'}</span></div>
          <div>Uptime: <span>${srv.uptime}</span></div>
        </div>
        <div class="srv-indicator">
          <div class="indicator-dot ${srv.status}"></div>
          <span class="indicator-label">${srv.status === 'online' ? 'Alle Dienste aktiv' : srv.status === 'warning' ? 'Warnung erkannt' : 'Nicht erreichbar'}</span>
        </div>
      </div>
    `).join('');
    },

    // --- WALKIE TALKIE ---
    startPTT() {
        document.getElementById('pttBtn').classList.add('active');
        document.getElementById('pttStatus').textContent = 'SENDE...';
        document.querySelector('.part-avatar.you + .part-name + .part-status')?.classList.replace('muted', 'speaking');
        // TODO: MediaRecorder + WebSocket Audio-Stream starten
    },

    stopPTT() {
        document.getElementById('pttBtn').classList.remove('active');
        document.getElementById('pttStatus').textContent = 'Verbunden · #voice-general';
        // TODO: Audio-Stream stoppen
    },

    // --- NOTIFICATIONS VIEW ---
    clearNotifications() {
        document.getElementById('notifList').innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted);font-family:var(--font-mono);font-size:12px;">
        KEINE BENACHRICHTIGUNGEN
      </div>`;
        document.getElementById('notifBadge')?.remove();
        NotificationService.show('Benachrichtigungen', 'Alle gelöscht.', 'success');
    },

    // --- MODAL ---
    showModal(type, data = {}) {
        const overlay = document.getElementById('modalOverlay');
        const title = document.getElementById('modalTitle');
        const body = document.getElementById('modalBody');
        overlay.classList.remove('hidden');

        if (type === 'createChannel') {
            title.textContent = 'Neuen Channel erstellen';
            body.innerHTML = `
        <div class="input-group">
          <label class="input-label">CHANNEL-NAME</label>
          <input type="text" id="newChannelName" class="input-field" placeholder="z.B. dev-talk" />
        </div>
        <div class="input-group">
          <label class="input-label">BESCHREIBUNG</label>
          <input type="text" id="newChannelDesc" class="input-field" placeholder="Kurze Beschreibung" />
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button class="btn btn-primary" onclick="App.createChannel()">Erstellen</button>
          <button class="btn btn-ghost" style="width:auto;flex:1" onclick="App.closeModal()">Abbrechen</button>
        </div>`;
        } else if (type === 'editChannel') {
            title.textContent = 'Channel bearbeiten';
            body.innerHTML = `
        <div class="input-group">
          <label class="input-label">CHANNEL-NAME</label>
          <input type="text" id="editChannelName" class="input-field" value="${escHtml(data.name)}" />
        </div>
        <div class="input-group">
          <label class="input-label">BESCHREIBUNG</label>
          <input type="text" id="editChannelDesc" class="input-field" value="${escHtml(data.desc)}" />
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button class="btn btn-primary" onclick="App.saveChannel(${data.id})">Speichern</button>
          <button class="btn btn-ghost" style="width:auto;flex:1" onclick="App.closeModal()">Abbrechen</button>
        </div>`;
        } else if (type === 'createVoice') {
            title.textContent = 'Sprachkanal erstellen';
            body.innerHTML = `
        <div class="input-group">
          <label class="input-label">KANAL-NAME</label>
          <input type="text" id="newVoiceName" class="input-field" placeholder="z.B. team-call" />
        </div>
        <div style="display:flex;gap:10px;margin-top:8px;">
          <button class="btn btn-primary" onclick="App.createVoiceChannel()">Erstellen</button>
          <button class="btn btn-ghost" style="width:auto;flex:1" onclick="App.closeModal()">Abbrechen</button>
        </div>`;
        }
    },

    closeModal() {
        document.getElementById('modalOverlay').classList.add('hidden');
    },

    createChannel() {
        const name = document.getElementById('newChannelName')?.value.trim().replace(/\s+/g, '-').toLowerCase();
        const desc = document.getElementById('newChannelDesc')?.value.trim();
        if (!name) return;
        MockData.channels.push({ id: Date.now(), name, desc: desc || 'Kein Beschreibungstext', members: 0 });
        this.renderChannels();
        this.closeModal();
        NotificationService.show('Channel erstellt', `#${name} wurde hinzugefügt.`, 'success');
    },

    saveChannel(id) {
        const ch = MockData.channels.find(c => c.id === id);
        if (!ch) return;
        ch.name = document.getElementById('editChannelName')?.value.trim() || ch.name;
        ch.desc = document.getElementById('editChannelDesc')?.value.trim() || ch.desc;
        this.renderChannels();
        this.closeModal();
        NotificationService.show('Channel aktualisiert', `#${ch.name} gespeichert.`, 'success');
    },

    createVoiceChannel() {
        const name = document.getElementById('newVoiceName')?.value.trim().replace(/\s+/g, '-').toLowerCase();
        if (!name) return;
        const list = document.querySelector('.voice-channels');
        const item = document.createElement('div');
        item.className = 'voice-channel-item';
        item.innerHTML = `<div class="vc-info"><div class="vc-icon">🔇</div><div class="vc-name">#${escHtml(name)}</div></div><div class="vc-members"></div>`;
        list.appendChild(item);
        this.closeModal();
        NotificationService.show('Sprachkanal erstellt', `#${name} ist jetzt verfügbar.`, 'success');
    },

    // --- SETTINGS ---
    setAccent(color) {
        const map = {
            blue:   ['#0066CC', '#003D7A'],
            cyan:   ['#00d4ff', '#7b2fff'],
            green:  ['#56ab2f', '#a8e063'],
            pink:   ['#f857a6', '#ff5858'],
        };
        const [a, b] = map[color] || map.blue;
        document.documentElement.style.setProperty('--brand-blue', a);
        document.documentElement.style.setProperty('--brand-blue-3', b);
        document.documentElement.style.setProperty('--brand-glow', a + '40');
        document.querySelectorAll('.accent-opt').forEach((el, i) => {
            el.classList.toggle('active', Object.keys(map)[i] === color);
        });
    },

    toggleSetting(key, val) {
        console.log('[Settings]', key, '=', val);
        NotificationService.show('Einstellungen', `${key} wurde ${val ? 'aktiviert' : 'deaktiviert'}.`, 'info');
    },

    // --- LOGOUT ---
    async logout() {
        AuthService.logout();
        WebSocketService.disconnect();
        this.showScreen('splashScreen');
        const bar = document.getElementById('loaderBar');
        bar.style.width = '0%';
        document.getElementById('loaderStatus').textContent = 'Abmelden...';
        await sleep(300);
        bar.style.width = '100%';
        await sleep(600);
        // Admin-Elemente zurücksetzen
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
        this.showScreen('loginScreen');
    },

    // --- PUBLIC SHOW NOTIFICATION (für globalen Zugriff) ---
    showNotification(title, msg, type) {
        NotificationService.show(title, msg, type);
    },
};

// =============================================================
// KEYBOARD SHORTCUTS
// =============================================================
document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey) {
        const shortcuts = {
            '1': 'overview', '2': 'messages', '3': 'notifications',
            '4': 'channels', '5': 'walkie', '6': 'servers', '9': 'settings',
        };
        if (shortcuts[e.key] && document.getElementById('dashboardScreen')?.classList.contains('active')) {
            e.preventDefault();
            App.navigate(shortcuts[e.key]);
        }
    }
    // Chat senden mit Enter
    if (e.key === 'Enter' && document.activeElement?.id === 'chatInput') {
        App.sendMessage();
    }
});

// =============================================================
// BOOTSTRAP
// =============================================================
document.addEventListener('DOMContentLoaded', () => App.init());