/**
 * EMDEN NETWORK DASHBOARD - renderer.js
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

let CURRENT_VERSION = '4.15.0'; // Stand: 05.04.2026 (F4 Mod-Panel Hotkey)

// =============================================================
// CONFIG — Bot-API
// =============================================================
const CONFIG = {
    API_URL: 'http://91.98.124.212:5009',
    API_KEY: 'emden-super-secret-key-2026',
    DEMO_MODE: false,
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
                'EN-DEMO': { username: 'DemoUser', role: 'user', discordId: '000000000' },
                'EN-ADMIN': { username: 'Admin', role: 'admin', discordId: '111111111' }
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
        try { localStorage.setItem('en_session', JSON.stringify(this.session)); } catch (e) { }
    },

    loadSession() {
        try {
            const raw = localStorage.getItem('en_session');
            if (raw) { this.session = JSON.parse(raw); return true; }
        } catch (e) { }
        return false;
    },

    logout() {
        this.session = null;
        try { localStorage.removeItem('en_session'); } catch (e) { }
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
            if (!res.ok) { console.warn('[ApiService] HTTP error:', res.status, endpoint); return null; }
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
            if (!res.ok) { console.warn('[ApiService] HTTP error:', res.status, endpoint); return null; }
            return res.json();
        } catch (e) {
            console.warn('[ApiService] POST fehlgeschlagen:', endpoint, e.message);
            return null;
        }
    },
};

// =============================================================
// 3. WEBSOCKET SERVICE (Status-Polling & Live Chat)
// =============================================================
const UserRegistry = {
    get() {
        try { return JSON.parse(localStorage.getItem('en_members') || '{}'); } catch (e) { return {}; }
    },
    update(users) {
        const registry = this.get();
        const now = Date.now();
        const MAX_AGE = 7 * 24 * 60 * 60 * 1000;  // 7 days
        
        // Remove stale entries more than 7 days old
        Object.entries(registry).forEach(([id, user]) => {
            if (now - user.lastSeen > MAX_AGE) {
                delete registry[id];
            }
        });
        
        // Add/update current users
        users.forEach(u => {
            const id = u.discordId || u.id || u.username; // Fallback auf Username
            if (id) {
                registry[id] = {
                    ...u,
                    discordId: id,
                    lastSeen: Date.now()
                };
            }
        });
        localStorage.setItem('en_members', JSON.stringify(registry));
    },
    save(registry) {
        try { localStorage.setItem('en_members', JSON.stringify(registry)); } catch(e) {}
    }
};

const WebSocketService = {
    _pollInterval: null,
    _heartbeatInterval: null,
    _announceInterval: null,
    socket: null,
    listeners: {},

    connect() {
        // Sofort Status holen + Heartbeat senden
        this._fetchStatus();
        this._sendHeartbeat();

        // Alle 30 Sekunden Status + Heartbeat
        this._pollInterval = setInterval(() => this._fetchStatus(), 30000);
        this._heartbeatInterval = setInterval(() => this._sendHeartbeat(), 30000);

        // Socket.IO für Live-Chat initialisieren
        if (window.io) {
            this.socket = window.io(CONFIG.API_URL);

            const announceOnline = () => {
                const user = AuthService.getUser();
                if (user && this.socket?.connected) {
                    this.socket.emit('client_online', {
                        discordId: user.discordId,
                        username: user.username,
                        avatar: user.avatar,
                        role: user.role,
                    });
                }
            };

            // Direkt beim Verbinden (und bei Reconnects)
            this.socket.on('connect', () => {
                console.log('[Socket] Verbunden! ID:', this.socket.id);
                announceOnline();
                // Chat-User registrieren für PNs
                const u = AuthService.getUser();
                if (u) this.socket.emit('chat_register', { discordId: u.discordId, username: u.username });
                setTimeout(() => this._fetchStatus(), 2000);
                App.initVoiceSocketEvents(this.socket);
            });

            this.socket.on('disconnect', () => {
                console.log('[Socket] Getrennt.');
            });
            
            // Live Online-User Updates
            this.socket.on('online_users', (users) => {
                if (window.App) App.renderFullUserList(users);
            });

            // Eingehende Nachrichten
            this.socket.on('receive_message', (msg) => {
                console.log('[Chat] Empfangen:', msg.username, msg.text || msg.message);
                const me = AuthService.getUser();
                const channel = msg.to || 'general';
                const saveKey = channel === '@' + me?.username ? '@' + msg.username : channel;

                // Anzeigen wenn im richtigen Chat
                const current = window.App?.currentChat || 'general';
                const shouldShow = (channel === 'general' && current === 'general') ||
                    (channel === '@' + me?.username && current === '@' + msg.username) ||
                    (channel === current);

                if (shouldShow && window.App) {
                    App._displayMessage(msg);
                    // Read Receipt senden
                    this.socket.emit('msg_read', { msgId: msg.id, reader: me?.username });
                }

                // Immer speichern
                if (window.App) App._saveChatMessage(msg, saveKey);

                // Sound + Notification
                if (window.App) App.playBlip(900, 0.06);
                if (window.App && App.currentView !== 'messages') {
                    NotificationService.show('Neue Nachricht', `${msg.username}: ${(msg.text || msg.message || '').substring(0, 50)}`, 'info');
                }
                if (!shouldShow && window.App) {
                    NotificationService.show('PN', `${msg.username}: ${(msg.text || msg.message || '').substring(0, 50)}`, 'info');
                }
            });

            // Typing Indicator
            this.socket.on('typing_indicator', ({ username, typing }) => {
                // Chat-area indicator
                const el = document.getElementById('typingIndicator');
                if (el) {
                    if (typing) {
                        el.textContent = `${username} tippt...`;
                        el.style.display = 'block';
                    } else {
                        el.style.display = 'none';
                    }
                }
                // Sidebar typing state
                if (!window._typingUsers) window._typingUsers = new Map();
                if (typing) {
                    window._typingUsers.set(username, Date.now());
                    // Auto-clear after 4s
                    setTimeout(() => {
                        if (window._typingUsers.get(username) <= Date.now() - 3500) {
                            window._typingUsers.delete(username);
                            App._updateSidebarTyping();
                        }
                    }, 4000);
                } else {
                    window._typingUsers.delete(username);
                }
                App._updateSidebarTyping();
            });

            // Message Status (Read Receipts)
            this.socket.on('msg_status', ({ id, status }) => {
                // DOM updaten
                const msgEl = document.getElementById('msg-' + id);
                const check = msgEl?.querySelector('.msg-check');
                if (check) {
                    if (status === 'read') { check.innerHTML = '✓✓'; check.style.color = '#3b82f6'; }
                    else if (status === 'delivered') { check.innerHTML = '✓✓'; check.style.color = 'var(--text-muted)'; }
                    else { check.innerHTML = '✓'; check.style.color = 'var(--text-muted)'; }
                }
                // localStorage updaten
                try {
                    Object.keys(localStorage).filter(k => k.startsWith('chat_history_')).forEach(k => {
                        const msgs = JSON.parse(localStorage.getItem(k) || '[]');
                        const msg = msgs.find(m => m.id === id);
                        if (msg) { msg.status = status; localStorage.setItem(k, JSON.stringify(msgs)); }
                    });
                } catch(e) {}
            });

            // Message Delete (von anderen Clients)
            this.socket.on('msg_deleted', ({ msgId }) => {
                const el = document.getElementById(msgId);
                if (el) el.remove();
                const numId = parseInt(msgId.replace('msg-', ''));
                try {
                    Object.keys(localStorage).filter(k => k.startsWith('chat_history_')).forEach(k => {
                        const msgs = JSON.parse(localStorage.getItem(k) || '[]');
                        const filtered = msgs.filter(m => m.id !== numId);
                        if (filtered.length !== msgs.length) localStorage.setItem(k, JSON.stringify(filtered));
                    });
                } catch(e) {}
            });

            console.log('[Socket] Chat-Listener registriert');

            // Alle 20s nochmal melden
            if (this._announceInterval) clearInterval(this._announceInterval);
            this._announceInterval = setInterval(announceOnline, 20000);

            // Chat-Historie vom Server laden
            this.socket.on('chat_history', (msgs) => {
                if (!Array.isArray(msgs)) return;
                const chatBox = document.getElementById('chatMessages');
                if (chatBox) chatBox.innerHTML = '';
                msgs.forEach(m => { if (window.App) App._displayMessage(m); });
            });

            // OAuth Callbacks
            this.socket.on(`roblox_connected_${AuthService.getUser()?.discordId}`, (profile) => {
                RobloxService.saveProfile(profile);
                App.renderRobloxCard(profile);
                NotificationService.show('Roblox verbunden! 🎮', `Willkommen, ${profile.displayName}!`, 'success');
            });

            // 📡 VOICE SYNC (Walkie-Talkie Synchronisation) 📡
            const handleVoiceSync = (channels) => {
                if (!channels) return;
                console.log('[Voice] Synchronisiere Sprachkanäle...', channels);
                
                const me = AuthService.getUser();
                MockData.voiceChannels = channels.map(serverVC => {
                    const localVC = MockData.voiceChannels.find(v => v.id === serverVC.id);
                    
                    return {
                        ...serverVC,
                        members: serverVC.members || [],
                        // Lokaler active-Zustand bleibt erhalten (Server kennt diesen nicht)
                        active: localVC ? localVC.active : false
                    };
                });

                App.renderVoiceChannels();
                App.renderActiveVoiceCard();
                App.renderWTMembers();
            };

            this.socket.on('voice_state_update', handleVoiceSync);
            this.socket.on('voice_channel_members', handleVoiceSync);
            this.socket.on('voice_channel_leave', (data) => {
                // Logik zum Entfernen aus UI bei Verlassen
                App.renderVoiceChannels();
            });

            this.socket.on('voice_created', (newChannel) => {
                if (!MockData.voiceChannels.find(vc => vc.id === newChannel.id)) {
                    MockData.voiceChannels.push(newChannel);
                    App.renderVoiceChannels();
                    NotificationService.show('Funkkanal', `Neuer Kanal #${newChannel.name} wurde erstellt.`, 'info');
                }
            });
        }
    },

    async _sendHeartbeat() {
        const user = AuthService.getUser();
        if (!user) return;
        // Presence wird jetzt über Socket.IO gehandelt (client_online Event)
        // Der HTTP-Heartbeat ist nicht mehr nötig
    },

    async _fetchStatus() {
        const data = await ApiService.get('/api/status');
        if (!data) {
            console.warn('[WebSocketService] Status fetch returned null');
            App.setConnectionStatus('reconnect');
            return;
        }
        if (data?.online) {
            App.setConnectionStatus('online');

            const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

            // Metric-Karten — mehrere mögliche Feldnamen abfangen
            const totalMembers = data.members ?? data.memberCount ?? '—';
            const onlineMembers = data.onlineMembers ?? data.online_members ?? data.onlineCount ?? '—';
            const dashOnline = data.dashboardOnline ?? data.dashboard_online ?? '0';

            setEl('statMembersTotal', totalMembers);
            setEl('statDashboardUsers', dashOnline);
            setEl('statDiscordConnected', 'Verbunden');

            // Live-Panel rechts
            setEl('liveMembers', totalMembers);
            setEl('liveOnline', onlineMembers);
            setEl('dashboardOnlineCount', dashOnline);

            // User-Liste rendern — IMMER versuchen, auch wenn dashboardUsers leer ist
            const users = data.dashboardUsers ?? data.onlineUsers ?? data.users ?? [];
            if (users.length > 0) {
                UserRegistry.update(users);
                App.renderFullUserList(users);
            } else if (parseInt(dashOnline) > 0) {
                // Fallback: Zähler anzeigen aber Liste als "Laden..." markieren
                const listEl = document.getElementById('dashboardUserList');
                if (listEl && listEl.innerHTML.trim() === '') {
                    listEl.innerHTML = `<div class="ovn-node" style="opacity:0.5"><div class="ovn-info">
                        <div class="ovn-dot online"></div>
                        <span style="font-size:11px;color:var(--text-muted)">${dashOnline} Nutzer online (synchronisiere...)</span>
                    </div></div>`;
                }
            }
        } else {
            App.setConnectionStatus('offline');
            // Bei Offline alle Zähler auf 0 setzen
            ['statDashboardUsers', 'dashboardOnlineCount', 'chatOnlineCountBadge'].forEach(id => {
                const e = document.getElementById(id); if (e) e.textContent = '0';
            });
            ['liveOnline', 'liveMembers'].forEach(id => {
                const e = document.getElementById(id); if (e) e.textContent = '0';
            });
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
        if (this._pollInterval) clearInterval(this._pollInterval);
        if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
        if (this._announceInterval) clearInterval(this._announceInterval);
        this._pollInterval = this._heartbeatInterval = this._announceInterval = null;
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    },
};

// =============================================================
// 4. NOTIFICATION SERVICE
// =============================================================
const NotificationService = {
    /**
     * Zeigt einen Toast unten rechts + optional Desktop Notification
     * @param {string} title
     * @param {string} message
     * @param {'info'|'success'|'warn'|'error'} type
     */
    show(title, message, type = 'info') {
        // In Notifications-Liste speichern
        if (window.App?.addNotification) App.addNotification(title, message, type);

        // Sound abspielen (falls in Settings aktiviert)
        if (document.getElementById('toggleSound')?.checked !== false) {
            this.playSmoothSound(type);
        }

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

        // Desktop Notifications (Immer feuern lassen fürs Testing)
        const isDesktopEnabled = document.getElementById('toggleDesktopNotif')?.checked !== false;

        if (isDesktopEnabled && window.electronAPI) {
            // 1) CUSTOM OVERLAY: Feuert immer an das transparente Overlay (wie Discord Popup)
            if (window.electronAPI.sendOverlayNotification) {
                window.electronAPI.sendOverlayNotification({ title, message, type });
            }

            // 2) NATIVE WINDOWS: 
            if (window.electronAPI.showNativeNotification) {
                window.electronAPI.showNativeNotification(title, message);
            }
        }
    },

    /**
     * Erzeugt einen kristallklaren, abgerundeten Synthesizer-Sound
     * @param {'info'|'success'|'warn'|'error'} type 
     */
    playSmoothSound(type) {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            const ctx = new AudioContext();

            const playNote = (freq, startTime, duration, volume = 0.1) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(freq, startTime);

                gain.gain.setValueAtTime(0, startTime);
                gain.gain.linearRampToValueAtTime(volume, startTime + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(startTime);
                osc.stop(startTime + duration);
            };

            const now = ctx.currentTime;

            if (type === 'success' || type === 'info') {
                // Heller, doppelter Kristall-Chime
                playNote(880, now, 0.5, 0.08); // A5
                playNote(1108.73, now + 0.08, 0.6, 0.06); // C#6
            } else if (type === 'warn' || type === 'error') {
                // Etwas tieferer, dezenterer Warnton
                playNote(440, now, 0.4, 0.1); // A4
                playNote(349.23, now + 0.12, 0.5, 0.08); // F4
            } else {
                // Standard Blip
                playNote(659.25, now, 0.3, 0.07); // E5
            }
        } catch (e) {
            console.error('Audio Synthesis failed:', e);
        }
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
    voiceChannels: [
        { id: 'vc-1', name: 'voice-general', type: 'public', active: true, members: ['Du'], owner: 'Admin' },
        { id: 'vc-2', name: 'ops-room', type: 'private', active: false, members: [], owner: 'Admin' }
    ]
};

// =============================================================
// HELPER
// =============================================================
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// =============================================================
// MAIN APP CONTROLLER
// =============================================================
const App = window.App = {
    currentView: 'overview',
    currentChat: 'general', // IMMER general — kein PN
    messages: [], // Zentraler Speicher für Filterung
    _clockInterval: null,

    // --- INIT ---
    async init() {
        console.log(`[App] Initialisiere Dashboard v1.6.6...`);
        
        // Background Parallax Effekt für den High-End Look
        this.initBackgroundParallax();
        
        try {
            // Version-Migration
            const lastVer = localStorage.getItem('last_app_version');
            if (lastVer !== CURRENT_VERSION) {
                console.log(`[App] Version geändert: ${lastVer} → ${CURRENT_VERSION}`);
                localStorage.setItem('last_app_version', CURRENT_VERSION);
            }
            // Chat-Backup wiederherstellen falls localStorage leer (nach Update)
            await this._restoreChatBackup();

            // Version auf Splash Screen setzen
            const splashVer = document.getElementById('splashVersion');
            if (splashVer) splashVer.textContent = `v${CURRENT_VERSION}`;

            // Splash Particles erzeugen
            const particleContainer = document.getElementById('splashParticles');
            if (particleContainer) {
                for (let i = 0; i < 25; i++) {
                    const p = document.createElement('div');
                    p.className = 'splash-particle';
                    p.style.left = Math.random() * 100 + '%';
                    p.style.animationDuration = (6 + Math.random() * 10) + 's';
                    p.style.animationDelay = (Math.random() * 8) + 's';
                    p.style.width = p.style.height = (1 + Math.random() * 2.5) + 'px';
                    p.style.opacity = 0.15 + Math.random() * 0.3;
                    particleContainer.appendChild(p);
                }
            }

            // Custom Titlebar
            document.getElementById('btnMin')?.addEventListener('click', () => window.electronAPI?.minimizeWindow());
            document.getElementById('btnMax')?.addEventListener('click', () => window.electronAPI?.maximizeWindow());
            document.getElementById('btnClose')?.addEventListener('click', () => window.electronAPI?.closeWindow());

            // Live clock
            this.startClock();

            // PTT Hotkey (Walkie-Talkie) initialisieren
            this.initPTTHandlers();

            // Splash → Login oder Dashboard
            await this.runSplash();

            // Login-Handler IMMER initialisieren
            this.initLoginHandlers();

            if (AuthService.loadSession() && AuthService.isLoggedIn()) {
                this.showDashboard(AuthService.getUser());
                this.renderActiveVoiceCard();
                this.syncSoundUI();
            } else {
                this.showScreen('loginScreen');
            }
        } catch (err) {
            console.error('[App] Kritischer Fehler bei der Initialisierung:', err);
            // Notfall: Splash ausblenden, falls er hängen bleibt
            document.getElementById('splashScreen')?.classList.remove('active');
            document.getElementById('loginScreen')?.classList.add('active');
        }
    },

    // --- SPLASH ---
    async runSplash() {
        const bar = document.getElementById('loaderBar');
        const status = document.getElementById('loaderStatus');
        const steps = [
            [12, 'Systemprüfung...'],
            [28, 'Lade Module...'],
            [45, 'Initialisiere Dienste...'],
            [62, 'Verbinde mit Netzwerk...'],
            [80, 'Synchronisiere Daten...'],
            [95, 'Finalisiere...'],
            [100, 'Bereit'],
        ];
        for (const [pct, msg] of steps) {
            if (bar) bar.style.width = pct + '%';
            if (status) status.textContent = msg;
            await sleep(380);
        }
        await sleep(400);
    },

    // --- SCREEN TRANSITIONS ---
    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => {
            s.classList.remove('active');
            s.style.display = 'none';
        });
        const target = document.getElementById(id);
        if (target) {
            target.classList.add('active');
            target.style.display = '';
        }
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
        if (!user) {
            console.warn('[App] Fehler beim Laden des Users - Abmeldung.');
            this.logout();
            return;
        }

        console.log('[App] Lade Dashboard für:', user.username);
        this.applyUser(user);
        this.renderChannels();
        this.renderServers();
        this.renderVoiceChannels();
        this.renderActiveVoiceCard(); // Active Voice Card beim Login zeigen
        this.syncSoundUI(); // Key & Audio in UI laden
        this.showScreen('dashboardScreen');
        this.navigate('overview');
        this.loadRobloxState(); // Roblox-Status laden (Overlay-Start)
        this._loadSavedBackground(); // Custom Wallpaper laden
        this._loadSavedAccent(); // Gespeicherte Akzentfarbe laden
        this._loadAllSettings(); // Theme, Font, Sprache, etc.
        this._loadNotifications(); // Gespeicherte Benachrichtigungen laden

        // Gespeicherte User-Liste sofort laden (Offline-Anzeige)
        const savedUsers = Object.values(UserRegistry.get());
        if (savedUsers.length > 0) {
            this.renderFullUserList([]);  // Alle als offline rendern
        }

        WebSocketService.connect();
        this.loadLiveNews(); // News live von der Website laden

        // Overlay für Admins immer starten
        if (user.role === 'admin' && window.electronAPI?.showRobloxOverlay) {
            const rblxProfile = RobloxService.getProfile();
            window.electronAPI.showRobloxOverlay(user.discordId, rblxProfile?.userId || '', true);
        }

        // Demo: Notifications nach kurzer Zeit
        setTimeout(() => {
            NotificationService.show('Willkommen!', 'Schön, dass du wieder da bist.', 'success');
        }, 3000);
    },

    applyUser(user) {
        if (!user) return;
        const initial = (user.username || 'U')[0].toUpperCase();
        const initialEscaped = escHtml(initial);

        // Hilfsfunktion: Avatar-Element mit Profilbild oder Initial befüllen
        const setAvatar = (id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const imgUrl = user.avatar || user.PFB || user.pfb || '';
            console.log(`[Avatar] ${id}: URL = "${imgUrl ? imgUrl.substring(0, 80) + '...' : 'KEINE'}"`);
            if (imgUrl && imgUrl.length > 5) {
                el.innerHTML = `<img src="${escHtml(imgUrl)}" alt="Avatar"
                    style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"
                    onerror="this.onerror=null; this.src=''; this.parentElement.innerHTML='<div class=\'avatar-fallback-inner\' style=\'width:100%;height:100%;display:flex;align-items:center;justify-content:center;\'>${initialEscaped}</div>';">`;
                el.textContent = '';
            } else {
                el.innerHTML = `<div class="avatar-fallback-inner" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">${initialEscaped}</div>`;
                el.textContent = '';
            }
        };

        // Sidebar
        const sidebarUserEl = document.getElementById('sidebarUsername');
        if (sidebarUserEl) sidebarUserEl.textContent = user.username;
        const sidebarRoleEl = document.getElementById('sidebarRole');
        if (sidebarRoleEl) sidebarRoleEl.textContent = user.role === 'admin' ? '⚡ Administrator' : 'Mitglied';

        setAvatar('sidebarAvatar');
        // Topbar
        setAvatar('topbarAvatar');
        // Chat
        setAvatar('chatOwnAvatar');
        setAvatar('walkieOwnAvatar');
        // Settings
        const sUser = document.getElementById('settingsUsername');
        if (sUser) sUser.textContent = user.username;
        const sRole = document.getElementById('settingsRole');
        if (sRole) sRole.textContent = user.role === 'admin' ? 'Administrator' : 'Standard-Nutzer';
        setAvatar('settingsAvatar');

        // Overview hero
        const ovUser = document.getElementById('overviewUsername');
        if (ovUser) ovUser.textContent = user.username;
        const wlnMsg = document.getElementById('welcomeMsg');
        if (wlnMsg) wlnMsg.textContent = `Willkommen zurück, ${user.username}!`;

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

        // Changelog laden, wenn man auf Home oder Settings ist
        if (view === 'overview' || view === 'settings') {
            if (typeof UpdateManager !== 'undefined' && UpdateManager.fetchChangelog) {
                UpdateManager.fetchChangelog();
            }
        }

        // Chat laden wenn man zur Messages-View navigiert
        if (view === 'messages') {
            this._loadChatHistory(this.currentChat || 'general');
        }
    },

    renderFullUserList(onlineUsers) {
        console.log('[Presence] Users vom Server:', onlineUsers);

        // 1. Neue Registry nur aus Server-Daten bauen (kein Merge mit alten)
        const registry = {};
        const onlineIds = new Set();

        onlineUsers.forEach(u => {
            const id = u.discordId;
            if (!id) return;
            // Nur einmal pro discordId (erstes Vorkommen gewinnt)
            if (registry[id]) return;
            registry[id] = { ...u, discordId: id, lastSeen: Date.now() };
            if (u.online === true) onlineIds.add(id);
        });

        // 2. Registry speichern
        UserRegistry.save(registry);

        // 3. Alle User anzeigen
        const allMembers = Object.values(registry);

        // Zähler nur für ECHTE online Leute
        const onlineCount = onlineIds.size;
        const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
        setEl('statDashboardUsers', onlineCount);
        setEl('dashboardOnlineCount', onlineCount);
        setEl('chatOnlineCountBadge', onlineCount);
        setEl('chatHeaderOnlineText', onlineCount + ' online');

        // Sortieren: Online zuerst, dann nach Rang (Admin > Staff > User)
        const sorted = allMembers.sort((a, b) => {
            const aOn = onlineIds.has(a.discordId);
            const bOn = onlineIds.has(b.discordId);
            if (aOn !== bOn) return aOn ? -1 : 1;

            const rank = r => r === 'admin' ? 0 : r === 'staff' ? 1 : 2;
            return rank(a.role) - rank(b.role);
        });

        const avatarEl = (u, isOnline) => {
            const initial = (u.username || '?')[0].toUpperCase();
            const statusClass = isOnline ? '' : 'offline';
            if (u.avatar) {
                return `<div class="ovn-avatar ${statusClass}" style="background:none;overflow:visible;">
                    <img src="${u.avatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                    <span style="display:none;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#0088FF);align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;">${escHtml(initial)}</span>
                </div>`;
            }
            return `<div class="ovn-avatar ${statusClass}">${escHtml(initial)}</div>`;
        };

        const badgeEl = u => {
            if (u.role === 'admin') return `<span class="ovn-role-badge admin">Admin</span>`;
            if (u.role === 'staff') return `<span class="ovn-role-badge staff">Staff</span>`;
            return ``;
        };

        const html = sorted.length === 0
            ? `<div class="ovn-node" style="opacity:0.4"><div class="ovn-info"><div class="ovn-dot"></div><span style="font-size:11px;color:var(--text-muted)">Niemand bekannt</span></div></div>`
            : sorted.map(u => {
                const isOnline = onlineIds.has(u.discordId);
                return `
            <div class="ovn-node ${isOnline ? '' : 'offline'} ${App.currentChat === '@' + u.username ? 'active' : ''}"
                 style="${isOnline ? '' : 'opacity: 0.55;'} cursor: pointer;"
                 onclick="App.selectChat('@${u.username}')">
                <div class="ovn-info">
                    ${avatarEl(u, isOnline)}
                    <div style="display:flex;flex-direction:column;min-width:0;">
                        <div style="display:flex;align-items:center;gap:3px;">
                            <span class="ovn-name">${escHtml(u.username)}</span>
                        </div>
                    </div>
                </div>
                ${badgeEl(u)}
                
                <!-- Profi-Preview Tooltip -->
                <div class="ovn-preview">
                    <img src="${u.avatar || u.PFB || 'https://raw.githubusercontent.com/princearmy2024/Emden-Network/main/logo.png'}" class="ovnp-avatar">
                    <div class="ovnp-name">${escHtml(u.username)}</div>
                    <div class="ovnp-info">${u.role ? u.role.toUpperCase() : 'USER'} · ${isOnline ? 'LIVE' : 'OFFLINE'}</div>
                    <div class="ovnp-hint">Privat schreiben 🖱️</div>
                </div>
            </div>`;
            }).join('');

        const homeList = document.getElementById('dashboardUserList');
        if (homeList) homeList.innerHTML = html;

        const chatList = document.getElementById('chatOnlineUsersList');
        if (chatList) chatList.innerHTML = html;
    },

    // --- USER SEARCH FILTER ---
    filterUserList(query) {
        const q = (query || '').toLowerCase();
        document.querySelectorAll('#chatOnlineUsersList .ovn-node').forEach(node => {
            const name = node.querySelector('.ovn-name')?.textContent.toLowerCase() || '';
            node.style.display = name.includes(q) ? '' : 'none';
        });
    },

    // --- SIDEBAR TYPING INDICATOR ---
    _updateSidebarTyping() {
        const typingUsers = window._typingUsers || new Map();
        document.querySelectorAll('.ovn-node').forEach(node => {
            const nameEl = node.querySelector('.ovn-name');
            if (!nameEl) return;
            const username = nameEl.textContent.trim();
            const nameContainer = nameEl.parentElement;
            let typingEl = nameContainer.querySelector('.ovn-typing');

            if (typingUsers.has(username)) {
                if (!typingEl) {
                    typingEl = document.createElement('span');
                    typingEl.className = 'ovn-typing';
                    typingEl.textContent = 'tippt...';
                    nameContainer.appendChild(typingEl);
                }
            } else if (typingEl) {
                typingEl.remove();
            }
        });
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
            const dateEl = document.getElementById('ovDate');
            if (clockEl) clockEl.textContent = `${hh}:${mm}`;
            if (dateEl) {
                const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
                dateEl.textContent = now.toLocaleDateString('de-DE', opts);
            }
            // Dynamic greeting
            const h = now.getHours();
            const greeting = h < 12 ? 'Guten Morgen,' : h < 18 ? 'Guten Tag,' : 'Guten Abend,';
            const greetNode = document.querySelector('.ov-greeting');
            if (greetNode && greetNode.childNodes.length > 0) {
                // Nur updaten, wenn das Text-Node existiert
                if (greetNode.childNodes[0].nodeType === 3) { // 3 = Text Node
                    greetNode.childNodes[0].textContent = greeting + ' ';
                }
            }
        };
        tick();
        if (this._clockInterval) clearInterval(this._clockInterval);
        this._clockInterval = setInterval(tick, 30000);
    },

    // --- MESSAGES ---
    selectChat(name) {
        this.currentChat = name;

        if (this.currentView !== 'messages') {
            this.navigate('messages');
        }

        // UI Header
        const headTitle = document.getElementById('activeChatName');
        if (headTitle) {
            if (name.startsWith('@')) {
                const tName = name.substring(1);
                const reg = UserRegistry.get();
                const tUser = Object.values(reg).find(u => u.username === tName);
                const robloxBadge = tUser?.discordId ? this._getRobloxBadge(tUser.discordId, false) : '';
                headTitle.innerHTML = `${escHtml(name)} ${robloxBadge}`;
            } else {
                headTitle.textContent = '#' + name;
            }
        }

        const headSub = document.getElementById('chatHeaderOnlineText');
        if (headSub) headSub.textContent = name.startsWith('@') ? 'Privatchat' : 'Gruppenchat';

        // PFP im Header bei DMs
        const headerAvatar = document.getElementById('chatHeaderAvatar');
        if (headerAvatar) {
            if (name.startsWith('@')) {
                const targetName = name.substring(1);
                const registry = UserRegistry.get();
                const targetUser = Object.values(registry).find(u => u.username === targetName);
                const avatarUrl = targetUser?.avatar || '';
                const initial = (targetName || '?')[0].toUpperCase();
                if (avatarUrl) {
                    headerAvatar.innerHTML = `<img src="${escHtml(avatarUrl)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`;
                } else {
                    headerAvatar.innerHTML = `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:15px;font-weight:700;color:#fff;">${initial}</span>`;
                }
                headerAvatar.style.display = 'flex';
            } else {
                headerAvatar.style.display = 'none';
            }
        }

        // Aktiven User in der Liste highlighten
        document.querySelectorAll('.ovn-node').forEach(node => {
            const userNameNode = node.querySelector('.ovn-name');
            if (userNameNode && userNameNode.textContent.includes(name.substring(1))) {
                node.classList.add('active');
            } else {
                node.classList.remove('active');
            }
        });

        this.playBlip(700, 0.05);

        // Chat-Box leeren und gespeicherte Nachrichten laden (mit kurzem Delay für View-Transition)
        setTimeout(() => {
            const chatBox = document.getElementById('chatMessages');
            if (chatBox) chatBox.innerHTML = '';
            this._loadChatHistory(name);
            console.log('[Chat] Gewechselt zu:', name);
        }, 100);
    },

    // Legacy — redirects zum neuen System
    appendChatMessage(msg) { this._displayMessage(msg); },

    // --- SOUND ENGINE ---
    _getAudioCtx() {
        if (!this._blipCtx || this._blipCtx.state === 'closed') {
            this._blipCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._blipCtx.state === 'suspended') this._blipCtx.resume().catch(() => {});
        return this._blipCtx;
    },

    playHoverSound() {
        try {
            const ctx = this._getAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1200, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.06);
            gain.gain.setValueAtTime(0.015, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.06);
        } catch(e) {}
    },

    playClickSound() {
        try {
            const ctx = this._getAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(600, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.04);
            osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.03, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.1);
        } catch(e) {}
    },

    playBlip(freq = 800, duration = 0.1) {
        try {
            const ctx = this._getAudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(freq / 2, ctx.currentTime + duration);
            gain.gain.setValueAtTime(0.05, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + duration);
        } catch(e) {}
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
    // (Actual PTT logic is further down in initPTTHandlers/startPTT/stopPTT)

    // --- NOTIFICATIONS VIEW ---
    _notifications: [],

    clearNotifications() {
        this._notifications = [];
        localStorage.removeItem('en_notifications');
        this._renderNotifications();
    },

    addNotification(title, msg, type = 'info') {
        this._notifications.unshift({ title, msg, type, time: Date.now() });
        if (this._notifications.length > 30) this._notifications.pop();
        localStorage.setItem('en_notifications', JSON.stringify(this._notifications));
        this._renderNotifications();
    },

    _renderNotifications() {
        const list = document.getElementById('notifList');
        if (!list) return;

        if (this._notifications.length === 0) {
            list.innerHTML = `<div class="notif-empty" style="padding:40px;text-align:center;color:var(--text-muted);font-size:13px;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="40" height="40" style="margin:0 auto 12px;opacity:0.3;display:block;">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>Keine Benachrichtigungen</div>`;
            return;
        }

        const icons = {
            warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
            info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
            success: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
            error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
        };
        const timeAgo = (ts) => {
            const s = Math.floor((Date.now() - ts) / 1000);
            if (s < 60) return 'gerade eben';
            if (s < 3600) return `vor ${Math.floor(s / 60)} Min`;
            if (s < 86400) return `vor ${Math.floor(s / 3600)} Std`;
            return `vor ${Math.floor(s / 86400)} Tagen`;
        };

        list.innerHTML = this._notifications.map((n, i) => `
            <div class="notif-item ${n.type}">
                <div class="notif-icon ${n.type}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">${icons[n.type] || icons.info}</svg></div>
                <div class="notif-content">
                    <div class="notif-title">${escHtml(n.title)}</div>
                    <div class="notif-msg">${escHtml(n.msg)}</div>
                    <div class="notif-time">${timeAgo(n.time)}</div>
                </div>
                <button class="notif-dismiss" onclick="App._notifications.splice(${i},1);localStorage.setItem('en_notifications',JSON.stringify(App._notifications));App._renderNotifications();">✕</button>
            </div>
        `).join('');
    },

    _loadNotifications() {
        try {
            this._notifications = JSON.parse(localStorage.getItem('en_notifications') || '[]');
            this._renderNotifications();
        } catch(e) {}
    },

    // ── Global Search ────────────────────────────────────────
    globalSearch(query) {
        if (!query || query.length < 2) return;
        const q = query.toLowerCase();
        // User suchen
        const registry = UserRegistry.get();
        const users = Object.values(registry).filter(u => u.username?.toLowerCase().includes(q));
        if (users.length > 0) {
            this.navigate('messages');
            this.selectChat('@' + users[0].username);
            document.getElementById('globalSearchInput').value = '';
            return;
        }
        // Views suchen
        const views = { dashboard: 'overview', nachrichten: 'messages', chat: 'messages', einstellungen: 'settings', settings: 'settings', walkie: 'walkie', funk: 'walkie', server: 'servers', benachrichtigungen: 'notifications' };
        for (const [key, view] of Object.entries(views)) {
            if (key.includes(q)) {
                this.navigate(view);
                document.getElementById('globalSearchInput').value = '';
                return;
            }
        }
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
            title.textContent = 'Neuer Sprachkanal';
            body.innerHTML = `
                <div style="display:flex;flex-direction:column;gap:16px;">
                    <div>
                        <label class="input-label" style="font-size:10px;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;display:block;">KANAL-NAME</label>
                        <div style="display:flex;align-items:center;gap:8px;background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:10px 14px;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2" width="16" height="16"><path d="M11 5L6 9H2v6h4l5 4V5z"/></svg>
                            <input type="text" id="newVoiceName" style="flex:1;background:none;border:none;color:var(--text);font-size:14px;font-weight:600;outline:none;" placeholder="z.B. team-call">
                        </div>
                    </div>
                    <div>
                        <label class="input-label" style="font-size:10px;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;display:block;">KANAL-TYP</label>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                            <button class="vc-type-card active" id="vcTypePublic" onclick="App._tempVoiceType='public';document.querySelectorAll('.vc-type-card').forEach(e=>e.classList.remove('active'));this.classList.add('active');document.getElementById('vcPasswordGroup').classList.add('hidden');">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                                <span style="font-size:12px;font-weight:700;">Öffentlich</span>
                                <span style="font-size:9px;color:var(--text-muted);">Jeder kann beitreten</span>
                            </button>
                            <button class="vc-type-card" id="vcTypePrivate" onclick="App._tempVoiceType='private';document.querySelectorAll('.vc-type-card').forEach(e=>e.classList.remove('active'));this.classList.add('active');document.getElementById('vcPasswordGroup').classList.remove('hidden');">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                                <span style="font-size:12px;font-weight:700;">Privat</span>
                                <span style="font-size:9px;color:var(--text-muted);">Passwort nötig</span>
                            </button>
                        </div>
                    </div>
                    <div class="hidden" id="vcPasswordGroup" style="animation:slideDown 0.2s ease;">
                        <label class="input-label" style="font-size:10px;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;display:block;">PASSWORT</label>
                        <input type="password" id="newVoicePassword" class="input-field" placeholder="Kanal-Passwort" style="border-radius:10px;padding:10px 14px;">
                    </div>
                    <div style="display:flex;gap:10px;margin-top:4px;">
                        <button class="btn btn-primary" onclick="App.createVoiceChannel()" style="flex:1;border-radius:10px;padding:11px;">Kanal erstellen</button>
                        <button class="btn btn-ghost" onclick="App.closeModal()" style="width:auto;padding:11px 20px;border-radius:10px;">Abbrechen</button>
                    </div>
                </div>
            `;
            App._tempVoiceType = 'public';
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
        const nameInput = document.getElementById('newVoiceName');
        const passInput = document.getElementById('newVoicePassword');
        const name = nameInput?.value.trim().replace(/\s+/g, '-').toLowerCase();
        if (!name) return;

        const newVC = {
            id: 'vc-' + Date.now(),
            name: name,
            type: this._tempVoiceType || 'public',
            password: (this._tempVoiceType === 'private') ? passInput?.value : null,
            members: ['Du'],
            owner: 'Du', // Aktueller User als Ersteller
            active: true
        };

        // SYNC: Kanal weltweit bekannt machen
        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('voice_create_channel', newVC);
        }

        MockData.voiceChannels.forEach(v => v.active = false);
        MockData.voiceChannels.push(newVC);
        this.renderVoiceChannels();
        this.closeModal();
        this.playBlip(600, 0.1);
        
        const status = document.getElementById('pttStatus');
        if (status) status.textContent = 'Frequenz: #' + name;
    },

    renderVoiceChannels() {
        const listContainer = document.querySelector('.voice-channels');
        if (!listContainer) return;

        const html = MockData.voiceChannels.map(vc => {
            const count = vc.members ? vc.members.length : 0;
            const iconSvg = vc.active
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`
                : vc.type === 'private'
                    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M11 5L6 9H2v6h4l5 4V5z"/></svg>`;

            // Member-Avatare gestapelt
            const memberAvatars = (vc.members || []).slice(0, 4).map((m, i) => {
                const init = (m || '?')[0].toUpperCase();
                return `<div class="vc-stacked-avatar" style="z-index:${4-i}">${init}</div>`;
            }).join('');
            const extra = count > 4 ? `<div class="vc-stacked-avatar vc-extra">+${count - 4}</div>` : '';

            return `
            <div class="voice-channel-item ${vc.active ? 'active' : ''}" onclick="App.selectVoiceChannel('${vc.id}')">
                <div class="vc-info">
                    <div class="vc-icon-svg">${iconSvg}</div>
                    <div class="vc-details">
                        <div class="vc-name">#${escHtml(vc.name)}</div>
                        <div class="vc-sub">${vc.type === 'private' ? 'Privat' : 'Offen'}${count > 0 ? ' · ' + count + ' User' : ''}</div>
                    </div>
                </div>
                <div class="vc-right">
                    ${vc.active ? '<span class="status-live-badge">LIVE</span>' : ''}
                    ${count > 0 ? `<div class="vc-stacked-avatars">${memberAvatars}${extra}</div>` : ''}
                    ${vc.active ? `<button class="vc-leave-btn" onclick="event.stopPropagation(); App.leaveVoiceChannel('${vc.id}')" title="Verlassen">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>` : ''}
                </div>
            </div>`;
        }).join('');

        listContainer.innerHTML = html;
    },

    selectVoiceChannel(id) {
        const targetVC = MockData.voiceChannels.find(vc => vc.id === id);
        if (!targetVC) return;

        // --- PRIVACY CHECK (Passwort-Abfrage) ---
        if (targetVC.type === 'private' && targetVC.password && !targetVC.active) {
            const pass = prompt(`Kanal #${targetVC.name} ist geschützt. Bitte Passwort eingeben:`);
            if (pass !== targetVC.password) {
                NotificationService.show('Zutritt verweigert', 'Falsches Passwort für diese Frequenz.', 'error');
                return;
            }
        }

        // Sound-Effekt (Frequenzwechsel)
        this.playBlip(700, 0.08);

        // SYNC: Signal an den Server senden (Falls verbunden)
        if (WebSocketService.socket?.connected) {
            const user = AuthService.getUser();
            WebSocketService.socket.emit('voice_channel_join', {
                channelId: id,
                username:  user?.username  || 'User',
                discordId: user?.discordId || '',
            });
        }

        MockData.voiceChannels.forEach(vc => {
            vc.active = (vc.id === id);
            vc.members = vc.members.filter(m => m !== 'Du');
            if (vc.active) vc.members.push('Du');
        });

        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        this.renderWTMembers();

        const status = document.getElementById('pttStatus');
        const activeCh = MockData.voiceChannels.find(vc => vc.active);
        if (status && activeCh) {
            status.textContent = 'Frequenz: #' + activeCh.name;
            status.style.color = 'var(--status-online)';
            status.style.fontWeight = '700';
            status.style.textShadow = '0 0 10px var(--status-online)';
        }
    },

    // Verlässt den aktuellen Sprachkanal
    leaveVoiceChannel(id) {
        const vc = MockData.voiceChannels.find(v => v.id === id);
        if (!vc || !vc.active) return;

        // PTT stoppen falls noch aktiv
        if (this.isSpeaking) this.stopPTT();

        // Socket-Event an den Server senden
        if (WebSocketService.socket?.connected) {
            const user = AuthService.getUser();
            WebSocketService.socket.emit('voice_channel_leave', {
                channelId: id,
                username:  user?.username  || 'User',
                discordId: user?.discordId || '',
            });
        }

        // Lokal: Kanal deaktivieren, 'Du' aus der Mitgliederliste entfernen
        vc.active = false;
        const me = AuthService.getUser();
        vc.members = vc.members.filter(m => m !== 'Du' && m !== me?.username);

        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        this.renderWTMembers();
        this.playBlip(400, 0.08);

        // Status zurücksetzen
        const status = document.getElementById('pttStatus');
        if (status) {
            status.textContent = 'NICHT VERBUNDEN';
            status.style.color = 'var(--text-muted)';
            status.style.textShadow = 'none';
            status.style.fontWeight = 'normal';
        }

        NotificationService.show('Kanal verlassen', `Du hast #${vc.name} verlassen.`, 'info');
    },

    // Verlässt den aktuell aktiven Voice-Kanal (Button im PTT-Panel)
    leaveCurrentVoice() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (vc) this.leaveVoiceChannel(vc.id);
    },

    // Radio-Effekt an/aus toggeln
    toggleRadioEffect() {
        this.radioEffectEnabled = !this.radioEffectEnabled;
        localStorage.setItem('radio_effect', this.radioEffectEnabled ? 'true' : 'false');
        const label = document.getElementById('radioEffectLabel');
        const btn = document.getElementById('btnRadioEffect');
        if (label) label.textContent = this.radioEffectEnabled ? 'FUNK AN' : 'FUNK AUS';
        if (btn) btn.classList.toggle('off', !this.radioEffectEnabled);
        NotificationService.show('Funk-Effekt', this.radioEffectEnabled ? 'Radio-Effekt aktiviert' : 'Radio-Effekt deaktiviert — normale Stimme', 'info');
    },

    // --- SETTINGS ---
    setAccent(color) {
        const map = {
            blue: ['#0066CC', '#003D7A'],
            cyan: ['#00d4ff', '#7b2fff'],
            green: ['#56ab2f', '#a8e063'],
            pink: ['#f857a6', '#ff5858'],
        };
        const [a, b] = map[color] || map.blue;
        this._applyAccent(a, b);
        document.querySelectorAll('.accent-opt').forEach((el, i) => {
            el.classList.toggle('active', Object.keys(map)[i] === color);
        });
        document.querySelector('.accent-opt.custom-color')?.classList.remove('active');
        localStorage.setItem('accent_color', color);
    },

    setCustomAccent(hex) {
        // Dunklere Variante berechnen
        const darken = (h, pct) => {
            const r = Math.max(0, Math.round(parseInt(h.slice(1,3),16) * pct));
            const g = Math.max(0, Math.round(parseInt(h.slice(3,5),16) * pct));
            const b = Math.max(0, Math.round(parseInt(h.slice(5,7),16) * pct));
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
        };
        this._applyAccent(hex, darken(hex, 0.6));
        document.querySelectorAll('.accent-opt').forEach(el => el.classList.remove('active'));
        const preview = document.getElementById('customAccentPreview');
        if (preview) { preview.style.background = hex; preview.classList.add('active'); }
        localStorage.setItem('accent_color', 'custom:' + hex);
    },

    _applyAccent(primary, dark) {
        document.documentElement.style.setProperty('--brand-blue', primary);
        document.documentElement.style.setProperty('--brand-blue-3', dark);
        document.documentElement.style.setProperty('--brand-glow', primary + '40');
        document.documentElement.style.setProperty('--status-online', primary);
    },

    _loadSavedAccent() {
        const saved = localStorage.getItem('accent_color');
        if (!saved) return;
        if (saved.startsWith('custom:')) {
            this.setCustomAccent(saved.replace('custom:', ''));
            const inp = document.getElementById('customAccentColor');
            if (inp) inp.value = saved.replace('custom:', '');
        } else {
            this.setAccent(saved);
        }
    },

    // ── Theme ────────────────────────────────────────────────
    setTheme(theme) {
        const themes = {
            midnight: { base: '#13151e', surface: '#1a1d2e', card: '#1f2235', cardHover: '#252840', sidebar: '#111320', input: '#1a1d2e', modal: '#1f2235' },
            ocean:    { base: '#0a1628', surface: '#0f2040', card: '#132a4a', cardHover: '#173560', sidebar: '#081322', input: '#0f2040', modal: '#132a4a' },
            neon:     { base: '#0d0015', surface: '#170028', card: '#1f0035', cardHover: '#2a0048', sidebar: '#0a0012', input: '#170028', modal: '#1f0035' },
            amoled:   { base: '#000000', surface: '#0a0a0a', card: '#111111', cardHover: '#1a1a1a', sidebar: '#000000', input: '#0a0a0a', modal: '#111111' },
        };
        const t = themes[theme] || themes.midnight;
        const r = document.documentElement;
        r.style.setProperty('--bg-base', t.base);
        r.style.setProperty('--bg-surface', t.surface);
        r.style.setProperty('--bg-card', t.card);
        r.style.setProperty('--bg-card-hover', t.cardHover);
        r.style.setProperty('--bg-sidebar', t.sidebar);
        r.style.setProperty('--bg-input', t.input);
        r.style.setProperty('--bg-modal', t.modal);
        // Auch html/body direkt updaten (für den Fall ohne Custom-BG)
        if (!document.body.classList.contains('has-custom-bg')) {
            document.body.style.background = t.base;
            r.style.background = t.base;
        }
        document.querySelectorAll('.theme-opt').forEach(el => el.classList.toggle('active', el.dataset.theme === theme));
        localStorage.setItem('app_theme', theme);
    },

    // ── Schriftgröße ─────────────────────────────────────────
    setFontSize(px) {
        // zoom skaliert ALLES proportional (besser als font-size)
        const scale = px / 14; // 14px = 100%
        document.querySelector('.main-content').style.zoom = scale;
        const label = document.getElementById('fontSizeValue');
        if (label) label.textContent = px + 'px';
        localStorage.setItem('font_size', px);
    },

    // ── Sprache ──────────────────────────────────────────────
    _translations: {
        en: {
            'Dashboard': 'Dashboard', 'Übersicht': 'Overview', 'Nachrichten': 'Messages',
            'Kommunikation': 'Communication', 'Einstellungen': 'Settings', 'Konfiguration': 'Configuration',
            'Benachrichtigungen': 'Notifications', 'Guten Morgen,': 'Good Morning,', 'Guten Tag,': 'Good Day,',
            'Guten Abend,': 'Good Evening,', 'Alle Systeme aktiv': 'All Systems Active',
            'Mitglieder gesamt': 'Total Members', 'Ungelesene Chats': 'Unread Chats',
            'Dashboard online': 'Dashboard Online', 'Discord Bot-Status': 'Discord Bot Status',
            'Verbunden': 'Connected', 'Nicht verbunden': 'Not Connected',
            'DARSTELLUNG': 'APPEARANCE', 'Akzentfarbe': 'Accent Color',
            'Hauptfarbe der Benutzeroberfläche': 'Main color of the user interface',
            'Animationen': 'Animations', 'UI-Übergänge und Effekte': 'UI transitions and effects',
            'Hintergrundbild': 'Background Image', 'Eigenes Wallpaper als App-Hintergrund': 'Custom wallpaper as app background',
            'Bild wählen': 'Choose Image', 'Hintergrund-Blur': 'Background Blur',
            'Glass-Blur Effekt auf dem Wallpaper': 'Glass blur effect on wallpaper',
            'Theme': 'Theme', 'Farbschema der App': 'App color scheme',
            'Schriftgröße': 'Font Size', 'UI-Text skalieren': 'Scale UI text',
            'Sprache': 'Language', 'Anzeigesprache der App': 'App display language',
            'BENACHRICHTIGUNGEN': 'NOTIFICATIONS', 'Desktop Benachrichtigungen': 'Desktop Notifications',
            'Native Systembenachrichtigungen': 'Native system notifications',
            'Sound': 'Sound', 'Akustische Benachrichtigungen': 'Audio notifications',
            'AUDIO & MIKROFON': 'AUDIO & MICROPHONE', 'Eingabegerät': 'Input Device',
            'Wähle dein Mikrofon aus': 'Choose your microphone', 'Funk-Lautstärke': 'Radio Volume',
            'Lautstärke der Funk-Sounds & Static': 'Volume of radio sounds & static',
            'WALKIE-TALKIE': 'WALKIE-TALKIE', 'Push-to-Talk Hotkey': 'Push-to-Talk Hotkey',
            'Taste zum Sprechen (Standard: V)': 'Key to talk (Default: V)',
            'Radio-Effekt Stärke': 'Radio Effect Strength', 'Wie stark der Funk-Sound klingt': 'How strong the radio sound is',
            'SYSTEM': 'SYSTEM', 'Autostart': 'Autostart',
            'App beim Windows-Start automatisch öffnen': 'Open app automatically at Windows start',
            'TASTENKÜRZEL': 'KEYBOARD SHORTCUTS', 'App fokussieren': 'Focus App',
            'ACCOUNT': 'ACCOUNT', 'Abmelden': 'Logout', 'Profil öffnen': 'Open Profile',
            'Verbindung trennen': 'Disconnect', 'Nachricht eingeben...': 'Type a message...',
            'GIFs suchen...': 'Search GIFs...', 'Suchen...': 'Search...',
            'Live verbunden': 'Live connected', 'PUSH TO TALK': 'PUSH TO TALK',
            'zum Sprechen': 'to speak', 'Gedrückt halten oder': 'Hold or',
            'TEILNEHMER': 'PARTICIPANTS', 'FREQUENZEN': 'FREQUENCIES',
            'SPRACHKANÄLE': 'VOICE CHANNELS', 'VERLASSEN': 'LEAVE',
            'FUNK AN': 'RADIO ON', 'FUNK AUS': 'RADIO OFF',
            'BEREIT': 'READY', 'SENDET GERADE': 'TRANSMITTING', 'EMPFÄNGT AUDIO': 'RECEIVING',
            'Keinem Kanal beigetreten': 'Not joined any channel',
        }
    },

    setLanguage(lang) {
        localStorage.setItem('app_lang', lang);
        if (lang === 'de') {
            // Seite neu laden für Deutsch (Original-HTML)
            location.reload();
            return;
        }
        this._applyTranslations(lang);
    },

    _applyTranslations(lang) {
        const dict = this._translations[lang];
        if (!dict) return;
        // Alle Text-Nodes durchgehen und übersetzen
        const walk = (el) => {
            for (const node of el.childNodes) {
                if (node.nodeType === 3) { // Text Node
                    const trimmed = node.textContent.trim();
                    if (dict[trimmed]) node.textContent = node.textContent.replace(trimmed, dict[trimmed]);
                } else if (node.nodeType === 1 && !['SCRIPT','STYLE','SVG'].includes(node.tagName)) {
                    // Placeholder
                    if (node.placeholder && dict[node.placeholder]) node.placeholder = dict[node.placeholder];
                    walk(node);
                }
            }
        };
        walk(document.body);
    },

    // ── Radio-Effekt Stärke ──────────────────────────────────
    setRadioStrength(val) {
        localStorage.setItem('radio_strength', val);
        const label = document.getElementById('radioStrengthValue');
        if (label) label.textContent = val + '%';
    },

    // ── Autostart ────────────────────────────────────────────
    toggleAutostart(enabled) {
        if (window.electronAPI?.setAutostart) {
            window.electronAPI.setAutostart(enabled);
        }
        localStorage.setItem('autostart', enabled ? 'true' : 'false');
        NotificationService.show('Autostart', enabled ? 'App startet mit Windows' : 'Autostart deaktiviert', 'info');
    },

    // ── Alle Settings beim Start laden ───────────────────────
    _loadAllSettings() {
        // Theme
        const theme = localStorage.getItem('app_theme');
        if (theme) this.setTheme(theme);
        // Font Size
        const fs = localStorage.getItem('font_size');
        if (fs) { this.setFontSize(fs); const sl = document.getElementById('fontSizeSlider'); if (sl) sl.value = fs; }
        // Language
        const lang = localStorage.getItem('app_lang');
        if (lang) {
            const sel = document.getElementById('langSelect');
            if (sel) sel.value = lang;
            if (lang !== 'de') setTimeout(() => this._applyTranslations(lang), 500);
        }
        // Radio Strength
        const rs = localStorage.getItem('radio_strength');
        if (rs) { const sl = document.getElementById('radioStrengthSlider'); if (sl) sl.value = rs; const lb = document.getElementById('radioStrengthValue'); if (lb) lb.textContent = rs + '%'; }
        // Autostart
        const as = localStorage.getItem('autostart');
        if (as) { const cb = document.getElementById('toggleAutostart'); if (cb) cb.checked = as === 'true'; }
    },

    toggleSetting(key, val) {
        console.log('[Settings]', key, '=', val);
        NotificationService.show('Einstellungen', `${key} wurde ${val ? 'aktiviert' : 'deaktiviert'}.`, 'info');
    },

    // --- ROBLOX LINKING ---
    async linkRoblox() {
        const username = prompt('Dein Roblox Username:');
        if (!username) return;

        const user = AuthService.getUser();
        if (!user) return;

        document.getElementById('robloxLinkName').innerHTML = 'Verbinde...';

        const result = await ApiService.post('/api/link-roblox', {
            discordId: user.discordId,
            robloxUsername: username
        });

        if (result && result.success) {
            NotificationService.show('Roblox verknüpft! ✅', `${result.robloxName} wurde verbunden.`, 'success');
            document.getElementById('robloxLinkName').textContent = result.robloxName;
            document.getElementById('robloxLinkName').nextElementSibling.textContent = 'Verbunden';
            this.applyRobloxAvatar(result.robloxId);
        } else {
            NotificationService.show('Fehler', result?.error || 'Verbindung fehlgeschlagen', 'error');
            document.getElementById('robloxLinkName').textContent = 'Roblox Account';
        }
    },

    applyRobloxAvatar(robloxId) {
        const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=true`;
        // Alle Avatar-Elemente updaten
        ['sidebarAvatar', 'topbarAvatar', 'settingsAvatar', 'chatOwnAvatar', 'walkieOwnAvatar'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
        });
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

    // --- ANNOUNCEMENT BANNER (announcementList) ---
    async loadAnnouncementBanner() {
        const listEl = document.getElementById('announcementList');
        if (!listEl) return;

        try {
            const res = await fetch('https://enrp.princearmy.de/announcements.json?t=' + Date.now(), { cache: 'no-store' });
            if (!res.ok) throw new Error('News fetch failed');
            const news = await res.json();

            if (!news || news.length === 0) {
                listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);">Momentan keine Neuigkeiten.</div>';
                return;
            }

            listEl.innerHTML = news.map(item => `
                <div class="announcement-card ${item.isOld ? 'old' : ''}">
                    <div class="ann-header">
                        <div class="ann-badge ${item.type || ''}">${item.badge || 'Update'}</div>
                        <span class="ann-time">${item.time || ''}</span>
                    </div>
                    <div class="ann-title">${item.title}</div>
                    <div class="ann-body">${item.body}</div>
                    <div class="ann-author">
                        <div class="ann-author-avatar" style="background:${item.authorColor || '#0088FF'};color:#000;">${item.authorInitial || 'E'}</div>
                        <span>${item.author || 'Admin Team'}</span>
                    </div>
                </div>
            `).join('');

        } catch (e) {
            console.error('Failed to load live news:', e);
            listEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--status-warn);font-size:12.5px;">Fehler beim Laden der News. Bitte Internetverbindung prüfen.</div>';
        }
    },

    // =============================================================
    // CHAT SYSTEM
    // =============================================================
    _chatSpamTimestamps: [],
    _chatSpamBlocked: false,
    _replyTo: null,

    setReply(id, username, text) {
        this._replyTo = { id, username, text };
        let bar = document.getElementById('replyBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'replyBar';
            bar.className = 'reply-bar';
            const inputArea = document.querySelector('.chat-input-area');
            if (inputArea) inputArea.parentElement.insertBefore(bar, inputArea);
        }
        const isImage = text && (text.startsWith('data:image/') || /^https?:\/\/\S+\.(?:gif|png|jpe?g|webp)$/i.test(text) || /^https?:\/\/(?:media\.tenor\.com|media\d*\.giphy\.com)\/\S+$/i.test(text));
        const previewContent = isImage
            ? `<img src="${text}" style="height:32px;border-radius:4px;object-fit:cover;">`
            : escHtml((text || '').substring(0, 60));
        bar.innerHTML = `<div class="reply-bar-content"><span class="reply-bar-user">${escHtml(username)}</span><span class="reply-bar-text">${previewContent}</span></div><button class="reply-bar-close" onclick="App.clearReply()">✕</button>`;
        bar.style.display = 'flex';
        document.getElementById('chatInput')?.focus();
    },

    replyToMsg(msgId) {
        // Nachricht aus localStorage finden
        const numId = parseInt(msgId);
        let found = null;
        try {
            for (const k of Object.keys(localStorage).filter(k => k.startsWith('chat_history_'))) {
                const msgs = JSON.parse(localStorage.getItem(k) || '[]');
                const msg = msgs.find(m => m.id === numId);
                if (msg) { found = msg; break; }
            }
        } catch(e) {}
        if (found) {
            this.setReply(found.id, found.username || 'User', found.text || found.message || '');
        }
    },

    scrollToReply(msgId) {
        const el = document.getElementById(msgId);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('pulse-highlight');
        void el.offsetWidth;
        el.classList.add('pulse-highlight');
        setTimeout(() => el.classList.remove('pulse-highlight'), 1300);
    },

    clearReply() {
        this._replyTo = null;
        const bar = document.getElementById('replyBar');
        if (bar) bar.style.display = 'none';
    },

    // Chat-Verlauf aus localStorage laden
    _loadChatHistory(channel) {
        try {
            const key = 'chat_history_' + (channel || 'general');
            const msgs = JSON.parse(localStorage.getItem(key) || '[]');
            const chatBox = document.getElementById('chatMessages');
            if (chatBox) chatBox.innerHTML = '';
            msgs.forEach(m => this._displayMessage(m));
        } catch(e) {}
    },

    _saveChatMessage(data, channel) {
        try {
            // Bei PNs: immer unter dem Chat-Partner speichern
            let saveKey = channel || 'general';
            if (saveKey.startsWith('@')) {
                const me = AuthService.getUser();
                // Wenn die Nachricht AN mich ist, speichere unter @Absender
                if (saveKey === '@' + me?.username) {
                    saveKey = '@' + data.username;
                }
            }
            const key = 'chat_history_' + saveKey;
            const msgs = JSON.parse(localStorage.getItem(key) || '[]');
            msgs.push({
                id: data.id || Date.now(),
                username: data.username,
                userId: data.userId || '',
                avatar: data.avatar || '',
                text: data.text || data.message || '',
                message: data.text || data.message || '',
                to: data.to || channel,
                status: data.status || 'sent',
                replyTo: data.replyTo || null,
                timestamp: data.timestamp || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                reactions: data.reactions || {},
            });
            while (msgs.length > 20) msgs.shift();
            localStorage.setItem(key, JSON.stringify(msgs));
            // Debounced Backup in Datei (überlebt Updates)
            this._scheduleChatBackup();
        } catch(e) {}
    },

    _chatBackupTimer: null,
    _scheduleChatBackup() {
        clearTimeout(this._chatBackupTimer);
        this._chatBackupTimer = setTimeout(() => this._performChatBackup(), 5000);
    },

    async _performChatBackup() {
        if (!window.electronAPI?.saveChatBackup) return;
        try {
            const backup = {};
            Object.keys(localStorage).filter(k => k.startsWith('chat_history_')).forEach(k => {
                backup[k] = localStorage.getItem(k);
            });
            // Auch Session, User-Registry und Roblox-Profil sichern
            backup['en_session'] = localStorage.getItem('en_session');
            backup['en_members'] = localStorage.getItem('en_members');
            backup['rblx_profile'] = localStorage.getItem('rblx_profile');
            backup['gif_favorites'] = localStorage.getItem('gif_favorites');
            backup['custom_bg'] = localStorage.getItem('custom_bg');
            backup['bg_blur'] = localStorage.getItem('bg_blur');
            await window.electronAPI.saveChatBackup(backup);
        } catch(e) {}
    },

    async _restoreChatBackup() {
        if (!window.electronAPI?.loadChatBackup) return;
        try {
            // Nur wiederherstellen wenn localStorage leer ist (= nach Update/Neuinstall)
            const hasChats = Object.keys(localStorage).some(k => k.startsWith('chat_history_'));
            if (hasChats) return;

            const backup = await window.electronAPI.loadChatBackup();
            if (!backup) return;

            let restored = 0;
            Object.entries(backup).forEach(([key, value]) => {
                if (value && !localStorage.getItem(key)) {
                    localStorage.setItem(key, value);
                    restored++;
                }
            });
            if (restored > 0) {
                console.log(`[Backup] ${restored} Einträge aus Backup wiederhergestellt`);
                NotificationService.show('Backup', 'Chat-History aus Backup wiederhergestellt!', 'success');
            }
        } catch(e) {}
    },

    sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input || !input.value.trim()) return;

        // Spam-Schutz: max 4 Nachrichten in 5 Sekunden
        if (this._chatSpamBlocked) {
            NotificationService.show('Spam-Schutz', 'Bitte warte ein paar Sekunden.', 'warn');
            return;
        }
        const now = Date.now();
        this._chatSpamTimestamps.push(now);
        this._chatSpamTimestamps = this._chatSpamTimestamps.filter(t => now - t < 5000);
        if (this._chatSpamTimestamps.length > 4) {
            this._chatSpamBlocked = true;
            NotificationService.show('Spam-Schutz', 'Du wurdest für 10 Sekunden gesperrt.', 'error');
            setTimeout(() => { this._chatSpamBlocked = false; this._chatSpamTimestamps = []; }, 10000);
            return;
        }

        const text = input.value.trim();
        input.value = '';
        const user = AuthService.getUser();
        const channel = this.currentChat || 'general';

        const msgData = {
            id: Date.now(),
            username: user?.username || 'User',
            userId: user?.discordId || '',
            avatar: user?.avatar || '',
            text: text,
            message: text,
            to: channel,
            timestamp: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
            status: 'sent',
            replyTo: this._replyTo || null,
        };
        this.clearReply();

        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('send_message', msgData);
            WebSocketService.socket.emit('typing_stop', { to: channel, username: user?.username });
        } else {
            NotificationService.show('Fehler', 'Keine Verbindung!', 'error');
        }

        this._displayMessage(msgData);
        this._saveChatMessage(msgData, channel);
        input.focus();
    },

    // Nachricht im Chat anzeigen (einheitlich für eigene + fremde)
    _displayMessage(data) {
        const chatBox = document.getElementById('chatMessages');
        if (!chatBox) { console.warn('[Chat] chatMessages Element nicht gefunden!'); return; }
        console.log('[Chat] _displayMessage:', data.username, data.text || data.message);

        const user = AuthService.getUser();
        const isOwn = data.username === user?.username || data.userId === user?.discordId;
        const text = data.text || data.message || '';
        const content = this._renderMessageContent(text);
        const time = data.timestamp || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const initial = (data.username || 'U')[0].toUpperCase();
        const msgId = 'msg-' + (data.id || ++this._msgIdCounter);

        // Duplikate vermeiden
        if (chatBox.querySelector(`[id="${msgId}"]`)) return;

        // Avatar: eigenes PFB oder vom User-Daten
        const avatarUrl = isOwn ? (user?.avatar || data.avatar || '') : (data.avatar || '');
        const avatarInner = avatarUrl
            ? `<img src="${escHtml(avatarUrl)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.style.display='none';this.parentElement.textContent='${initial}'">`
            : initial;

        const bgColor = isOwn ? 'var(--brand-blue)' : (this.getStringColor?.(data.username) || '#0088FF');

        const st = data.status || 'sent';
        const checkColor = st === 'read' ? '#3b82f6' : 'var(--text-muted)';
        const checkText = (st === 'read' || st === 'delivered') ? '✓✓' : '✓';
        const checkmark = isOwn ? `<span class="msg-check" style="color:${checkColor}">${checkText}</span>` : '';
        const replyRef = data.replyTo ? (() => {
            const rt = data.replyTo.text || '';
            const isImg = rt.startsWith('data:image/') || /^https?:\/\/\S+\.(?:gif|png|jpe?g|webp)$/i.test(rt) || /^https?:\/\/(?:media\.tenor\.com|media\d*\.giphy\.com)\/\S+$/i.test(rt);
            const replyPreview = isImg ? `<img src="${rt}" style="height:36px;border-radius:4px;object-fit:cover;margin-top:2px;">` : `<span class="reply-text">${escHtml(rt.substring(0, 60))}</span>`;
            return `<div class="msg-reply-ref" onclick="App.scrollToReply('msg-${data.replyTo.id}')"><span class="reply-user">${escHtml(data.replyTo.username)}</span>${replyPreview}</div>`;
        })() : '';
        const replyBtn = `<button class="msg-reply-btn" onclick="App.replyToMsg('${data.id}')" title="Antworten">↩</button>`;

        const html = `
            <div class="msg-item ${isOwn ? 'own' : ''}" id="${msgId}">
                ${!isOwn ? `<div class="msg-avatar" style="background:${bgColor}">${avatarInner}</div>` : ''}
                <div class="msg-body">
                    ${replyRef}
                    <div class="msg-meta"><span class="msg-user">${isOwn ? 'Du' : escHtml(data.username || 'User')}</span>${this._getRobloxBadge(data.userId, isOwn)}<span class="msg-time">${time}</span>${checkmark}</div>
                    <div class="msg-text">${content}</div>
                    <div class="msg-reactions" id="${msgId}-reactions">${data.reactions ? Object.entries(data.reactions).map(([e,c]) => `<span class="reaction-badge" data-emoji="${e}" onclick="App.addReaction('${msgId}','${e}')">${e}<span class="rc-count">${c}</span></span>`).join('') : ''}</div>
                    <button class="msg-react-btn" onclick="App.showReactionPicker('${msgId}')" title="Reagieren">+</button>
                    ${replyBtn}
                </div>
                ${isOwn ? `<div class="msg-avatar you" style="background:${bgColor}">${avatarInner}</div>` : ''}
            </div>
        `;
        chatBox.insertAdjacentHTML('beforeend', html);

        // Max 20 Nachrichten
        while (chatBox.children.length > 20) chatBox.removeChild(chatBox.firstChild);

        // Auto-scroll zum neuesten
        requestAnimationFrame(() => { chatBox.scrollTop = chatBox.scrollHeight; });
    },

    _msgIdCounter: 0,

    // Prüft ob Text eine Bild/GIF URL ist
    _renderMessageContent(text) {
        const escaped = escHtml(text);
        // Data-URLs (hochgeladene Bilder) → als Bild rendern
        if (text.startsWith('data:image/')) {
            return `<img src="${text}" class="chat-embed-img" alt="Bild">`;
        }
        // URLs die auf .gif/.png/.jpg/.jpeg/.webp enden → als Bild rendern
        const imgMatch = text.match(/^(https?:\/\/\S+\.(?:gif|png|jpe?g|webp))$/i);
        if (imgMatch) {
            return `<img src="${escHtml(imgMatch[1])}" class="chat-embed-img" alt="Bild" onerror="this.style.display='none'">`;
        }
        // Tenor/Giphy URLs → als Bild
        const tenorMatch = text.match(/^(https?:\/\/(?:media\.tenor\.com|media\d*\.giphy\.com)\/\S+)$/i);
        if (tenorMatch) {
            return `<img src="${escHtml(tenorMatch[1])}" class="chat-embed-img" alt="GIF" onerror="this.style.display='none'">`;
        }
        return escaped;
    },

    appendChatMessage(data, skipSave = false) {
        const chatBox = document.querySelector('.chat-messages');
        if (!chatBox) return;

        const msgId = 'msg-' + (++this._msgIdCounter);
        const isOwn = data.username === AuthService.getUser()?.username;
        const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const user = AuthService.getUser();
        const avatarUrl = isOwn ? (user?.avatar || '') : '';
        const initial = (data.username || 'U')[0].toUpperCase();
        const content = this._renderMessageContent(data.message || '');

        const ownAvatar = avatarUrl
            ? `<div class="msg-avatar you"><img src="${escHtml(avatarUrl)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" onerror="this.parentElement.textContent='${initial}'"></div>`
            : `<div class="msg-avatar you" style="background:var(--brand-blue)">${initial}</div>`;

        const html = `
            <div class="msg-item ${isOwn ? 'own' : ''}" id="${msgId}">
                ${!isOwn ? `<div class="msg-avatar" style="background:${this.getStringColor?.(data.username) || '#0088FF'}">${initial}</div>` : ''}
                <div class="msg-body">
                    <div class="msg-meta"><span class="msg-user">${isOwn ? 'Du' : escHtml(data.username || 'System')}</span><span class="msg-time">${time}</span></div>
                    <div class="msg-text">${content}</div>
                    <div class="msg-reactions" id="${msgId}-reactions"></div>
                    <button class="msg-react-btn" onclick="App.showReactionPicker('${msgId}')" title="Reagieren">+</button>
                </div>
                ${isOwn ? ownAvatar : ''}
            </div>
        `;

        chatBox.insertAdjacentHTML('beforeend', html);

        // Max 20 Nachrichten
        while (chatBox.children.length > 20) {
            chatBox.removeChild(chatBox.firstChild);
        }

        chatBox.scrollTop = chatBox.scrollHeight;

        // Nachricht speichern (außer beim Laden aus History)
        if (!skipSave) {
            this._saveChatMessage(data, this.currentChat || 'general');
        }
    },

    // Emoji Reaction Picker
    showReactionPicker(msgId) {
        // Altes Picker schließen
        document.querySelectorAll('.reaction-picker').forEach(el => el.remove());

        const msgEl = document.getElementById(msgId);
        if (!msgEl) return;
        const body = msgEl.querySelector('.msg-body');

        const emojis = ['👍','❤️','😂','🔥','😮','😢','💯','🎉','👀','🤔'];
        const picker = document.createElement('div');
        picker.className = 'reaction-picker';
        picker.innerHTML = emojis.map(e => `<button class="rp-emoji" onclick="App.addReaction('${msgId}','${e}')">${e}</button>`).join('');
        body.appendChild(picker);

        // Schließen bei Klick außerhalb
        setTimeout(() => {
            document.addEventListener('click', function close(ev) {
                if (!picker.contains(ev.target)) {
                    picker.remove();
                    document.removeEventListener('click', close);
                }
            });
        }, 50);
    },

    addReaction(msgId, emoji) {
        const container = document.getElementById(msgId + '-reactions');
        if (!container) return;

        // Prüfe ob Emoji schon existiert → Zähler erhöhen
        const existing = container.querySelector(`[data-emoji="${emoji}"]`);
        if (existing) {
            const countEl = existing.querySelector('.rc-count');
            countEl.textContent = parseInt(countEl.textContent) + 1;
        } else {
            const badge = document.createElement('span');
            badge.className = 'reaction-badge';
            badge.dataset.emoji = emoji;
            badge.innerHTML = `${emoji}<span class="rc-count">1</span>`;
            badge.onclick = () => App.addReaction(msgId, emoji);
            container.appendChild(badge);
        }

        // Picker schließen
        document.querySelectorAll('.reaction-picker').forEach(el => el.remove());

        // In localStorage speichern
        try {
            const id = parseInt(msgId.replace('msg-', ''));
            Object.keys(localStorage).filter(k => k.startsWith('chat_history_')).forEach(k => {
                const msgs = JSON.parse(localStorage.getItem(k) || '[]');
                const msg = msgs.find(m => m.id === id);
                if (msg) {
                    if (!msg.reactions) msg.reactions = {};
                    msg.reactions[emoji] = (msg.reactions[emoji] || 0) + 1;
                    localStorage.setItem(k, JSON.stringify(msgs));
                }
            });
        } catch(e) {}

        // Socket sync
        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('chat_reaction', { msgId, emoji });
        }
    },

    getStringColor(str) {
        let hash = 0;
        if (!str) return 'var(--accent-blue)';
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
    },

    // ── Roblox Badge im Chat ──
    _robloxCache: {},
    _getRobloxBadge(userId, isOwn) {
        if (!userId) return '';
        // Eigener User → direkt aus localStorage
        if (isOwn) {
            const profile = RobloxService.getProfile();
            if (profile?.profileUrl) {
                return `<a href="#" onclick="event.preventDefault();window.electronAPI?.openExternal('${profile.profileUrl}')" class="msg-roblox-badge" title="Roblox Profil öffnen">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5.25 0L0 18.75L18.75 24L24 5.25L5.25 0ZM14.7 14.7L9.3 13.2L10.8 7.8L14.7 14.7Z"/></svg>
                </a>`;
            }
            return '';
        }
        // Andere User → aus Cache oder async laden
        if (this._robloxCache[userId] === false) return '';
        if (this._robloxCache[userId]) {
            const url = this._robloxCache[userId];
            return `<a href="#" onclick="event.preventDefault();window.electronAPI?.openExternal('${url}')" class="msg-roblox-badge" title="Roblox Profil öffnen">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M5.25 0L0 18.75L18.75 24L24 5.25L5.25 0ZM14.7 14.7L9.3 13.2L10.8 7.8L14.7 14.7Z"/></svg>
            </a>`;
        }
        // Async laden (einmalig, nur bei Bedarf — nicht in Sidebar)
        if (this._robloxCache[userId] === undefined) {
            this._robloxCache[userId] = null; // loading
            fetch(`${CONFIG.API_URL}/api/roblox/profile?discordId=${encodeURIComponent(userId)}`, {
                headers: { 'x-api-key': CONFIG.API_KEY }
            }).then(r => r.ok ? r.json() : null).then(data => {
                if (data?.success && data.profile?.profileUrl) {
                    this._robloxCache[userId] = data.profile.profileUrl;
                } else {
                    this._robloxCache[userId] = false;
                }
            }).catch(() => { this._robloxCache[userId] = false; });
        }
        return '';
    },

    // ── GIF Picker (Tenor API) ────────────────────────────────
    _gifSearchTimer: null,
    _gifCurrentTab: 'gifs',

    toggleGifPicker() {
        const panel = document.getElementById('gifPickerPanel');
        if (!panel) return;
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            document.getElementById('gifSearchInput')?.focus();
            this.switchGifTab('gifs');
        }
    },

    switchGifTab(tab) {
        this._gifCurrentTab = tab;
        document.querySelectorAll('.gif-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        const searchInput = document.getElementById('gifSearchInput');
        const grid = document.getElementById('gifGrid');
        if (!grid) return;
        // Tab-Wechsel Animation
        grid.classList.remove('gif-grid-fade');
        void grid.offsetWidth;
        grid.classList.add('gif-grid-fade');

        if (tab === 'emojis') {
            if (searchInput) searchInput.placeholder = 'Emoji suchen...';
            this._renderEmojiGrid(searchInput?.value || '');
        } else if (tab === 'favs') {
            if (searchInput) searchInput.placeholder = 'Favoriten durchsuchen...';
            this._renderFavorites();
        } else if (tab === 'sticker') {
            if (searchInput) searchInput.placeholder = 'Sticker suchen...';
            searchInput.value = '';
            this._fetchGifs('trending', 'sticker');
        } else {
            if (searchInput) searchInput.placeholder = 'GIFs suchen...';
            searchInput.value = '';
            this._fetchGifs('trending', 'gif');
        }
    },

    searchGifs(query) {
        clearTimeout(this._gifSearchTimer);
        const tab = this._gifCurrentTab;

        if (tab === 'emojis') {
            this._renderEmojiGrid(query);
            return;
        }
        if (tab === 'favs') {
            this._renderFavorites(query);
            return;
        }

        if (!query || query.length < 2) {
            this._fetchGifs('trending', tab === 'sticker' ? 'sticker' : 'gif');
            return;
        }
        this._gifSearchTimer = setTimeout(() => this._fetchGifs(query, tab === 'sticker' ? 'sticker' : 'gif'), 400);
    },

    async _fetchGifs(query, type = 'gif') {
        const grid = document.getElementById('gifGrid');
        if (!grid) return;
        grid.className = 'gif-grid';
        grid.innerHTML = '<div class="gif-loading">Laden...</div>';

        try {
            const data = window.electronAPI
                ? await window.electronAPI.searchTenorGifs(query === 'trending' ? '' : query)
                : { results: [] };

            if (!data.results || data.results.length === 0) {
                grid.innerHTML = '<div class="gif-loading">Keine Ergebnisse gefunden</div>';
                return;
            }

            const favs = this._getGifFavorites();
            grid.innerHTML = data.results.map(gif => {
                const preview = gif.media_formats?.tinygif?.url || gif.media_formats?.nanogif?.url || '';
                const full = gif.media_formats?.gif?.url || preview;
                if (!preview) return '';
                const isFav = favs.includes(full);
                return `<div class="gif-item-wrapper" onclick="App.sendGif('${full.replace(/'/g, '')}')">
                    <img src="${preview}" class="gif-item" alt="GIF" loading="lazy">
                    <button class="gif-fav-btn ${isFav ? 'faved' : ''}" onclick="event.stopPropagation();App.toggleGifFav('${full.replace(/'/g, '')}','${preview.replace(/'/g, '')}',this)" title="Favorit">★</button>
                </div>`;
            }).join('');
        } catch (e) {
            grid.innerHTML = '<div class="gif-loading">Fehler beim Laden</div>';
        }
    },

    // ── GIF Favoriten (localStorage) ──
    _getGifFavorites() {
        try { return JSON.parse(localStorage.getItem('gif_favorites') || '[]'); } catch { return []; }
    },

    toggleGifFav(fullUrl, previewUrl, btn) {
        let favs = this._getGifFavorites();
        const idx = favs.indexOf(fullUrl);
        if (idx > -1) {
            favs.splice(idx, 1);
            btn?.classList.remove('faved');
        } else {
            favs.unshift(fullUrl);
            btn?.classList.add('faved');
        }
        localStorage.setItem('gif_favorites', JSON.stringify(favs));
    },

    _renderFavorites(filter) {
        const grid = document.getElementById('gifGrid');
        if (!grid) return;
        grid.className = 'gif-grid';
        let favs = this._getGifFavorites();
        if (filter) favs = favs.filter(u => u.toLowerCase().includes(filter.toLowerCase()));
        if (favs.length === 0) {
            grid.innerHTML = '<div class="gif-loading">Keine Favoriten gespeichert.<br>Klicke ★ auf einem GIF!</div>';
            return;
        }
        grid.innerHTML = favs.map(url => `<div class="gif-item-wrapper" onclick="App.sendGif('${url.replace(/'/g, '')}')">
            <img src="${url}" class="gif-item" alt="Favorit" loading="lazy">
            <button class="gif-fav-btn faved" onclick="event.stopPropagation();App.toggleGifFav('${url.replace(/'/g, '')}','',this);App._renderFavorites()" title="Entfernen">★</button>
        </div>`).join('');
    },

    // ── Emoji Tab ──
    _renderEmojiGrid(filter) {
        const grid = document.getElementById('gifGrid');
        if (!grid) return;
        grid.className = 'gif-emoji-grid';
        const allEmojis = ['😀','😂','🤣','😍','🥰','😘','😜','🤪','😎','🤩','🥳','😏','😒','😤','😡','🤬','😱','😨','😰','🥺','😢','😭','😤','🤮','🤢','💀','☠️','👻','👽','🤖','💩','😺','😸','😹','😻','👍','👎','✊','🤛','🤜','🤝','🙏','💪','🦾','🖕','✌️','🤞','🤟','🤘','👌','🤌','👈','👉','👆','👇','☝️','👋','🤚','🖐️','✋','🖖','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💝','💘','🔥','⭐','🌟','✨','💫','🎉','🎊','🎈','🎁','🏆','🥇','🥈','🥉','⚽','🏀','🏈','⚾','🎾','🎮','🕹️','🎯','🎲','🧩','🎭','🎬','🎤','🎧','🎵','🎶','💯','✅','❌','⚠️','🚀','💎','🔔','📌','💡','🔑','🛡️','⚡','☀️','🌙','⛅','🌈','☔'];
        let emojis = allEmojis;
        if (filter && filter.length > 0) {
            // Simple keyword matching
            emojis = allEmojis; // Emojis have no text name, just show all
        }
        grid.innerHTML = emojis.map(e => `<button class="gif-emoji-item" onclick="App.sendEmoji('${e}')">${e}</button>`).join('');
    },

    sendEmoji(emoji) {
        if (!emoji) return;
        const input = document.getElementById('chatInput');
        if (input) {
            input.value += emoji;
            input.focus();
        }
    },

    sendGif(url) {
        if (!url) return;
        const input = document.getElementById('chatInput');
        if (input) input.value = url;
        this.sendMessage();
        document.getElementById('gifPickerPanel')?.classList.add('hidden');
    },

    // ── Datei/Bild Upload (max 10MB) ──
    attachFile() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*,.gif,.png,.jpg,.jpeg,.webp';
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
                NotificationService.show('Zu groß', 'Max. 10 MB erlaubt!', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                // Bild komprimieren auf max 600px Breite
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const maxW = 600;
                    const scale = Math.min(1, maxW / img.width);
                    canvas.width = img.width * scale;
                    canvas.height = img.height * scale;
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    const compressed = canvas.toDataURL('image/jpeg', 0.75);
                    const chatInput = document.getElementById('chatInput');
                    if (chatInput) chatInput.value = compressed;
                    this.sendMessage();
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        };
        fileInput.click();
    },

    // ── Rechtsklick Kontextmenü ──
    _ctxTarget: null,
    _ctxMsgId: null,
    _ctxIsOwn: false,
    _forwardSelected: [],
    _forwardCooldown: false,

    ctxDownload() {
        if (!this._ctxTarget) return;
        document.getElementById('ctxMenu')?.classList.add('hidden');
        // Dateiformat erkennen
        let ext = 'png';
        const src = this._ctxTarget;
        if (src.includes('.gif') || src.includes('image/gif')) ext = 'gif';
        else if (src.includes('.jpg') || src.includes('.jpeg') || src.includes('image/jpeg')) ext = 'jpg';
        else if (src.includes('.webp') || src.includes('image/webp')) ext = 'webp';
        else if (src.includes('.png') || src.includes('image/png')) ext = 'png';
        const a = document.createElement('a');
        a.href = src;
        a.download = 'image_' + Date.now() + '.' + ext;
        a.click();
    },

    ctxForward() {
        if (!this._ctxTarget) return;
        document.getElementById('ctxMenu')?.classList.add('hidden');
        if (this._forwardCooldown) {
            NotificationService.show('Cooldown', 'Du kannst nur alle 3 Minuten weiterleiten.', 'warn');
            return;
        }
        // Forward Modal öffnen mit Userliste
        this._forwardSelected = [];
        const list = document.getElementById('forwardUserList');
        const registry = UserRegistry.get();
        const me = AuthService.getUser();
        const users = Object.values(registry).filter(u => u.username !== me?.username);

        list.innerHTML = users.map(u => {
            const initial = (u.username || '?')[0].toUpperCase();
            const avatarHtml = u.avatar
                ? `<img src="${u.avatar}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
                : '';
            return `<div class="fwd-user-item" data-user="${escHtml(u.username)}" onclick="App._toggleForwardUser(this)">
                <div class="fwd-user-avatar">${avatarHtml}<span style="${u.avatar ? 'display:none;' : ''}width:100%;height:100%;display:flex;align-items:center;justify-content:center;">${initial}</span></div>
                <span class="fwd-user-name">${escHtml(u.username)}</span>
                <div class="fwd-user-check">✓</div>
            </div>`;
        }).join('');

        document.getElementById('forwardModal')?.classList.remove('hidden');
    },

    filterForwardList(query) {
        const q = (query || '').toLowerCase();
        document.querySelectorAll('#forwardUserList .fwd-user-item').forEach(el => {
            const name = el.querySelector('.fwd-user-name')?.textContent.toLowerCase() || '';
            el.style.display = name.includes(q) ? '' : 'none';
        });
    },

    _toggleForwardUser(el) {
        const name = el.dataset.user;
        if (el.classList.contains('selected')) {
            el.classList.remove('selected');
            this._forwardSelected = this._forwardSelected.filter(n => n !== name);
        } else {
            if (this._forwardSelected.length >= 3) {
                NotificationService.show('Limit', 'Max. 3 User!', 'warn');
                return;
            }
            el.classList.add('selected');
            this._forwardSelected.push(name);
        }
    },

    confirmForward() {
        if (this._forwardSelected.length === 0) {
            NotificationService.show('Fehler', 'Wähle mindestens 1 User!', 'warn');
            return;
        }
        const content = this._ctxTarget;
        const user = AuthService.getUser();
        this._forwardSelected.forEach(targetName => {
            const msgData = {
                id: Date.now() + Math.random(),
                username: user?.username || 'User',
                userId: user?.discordId || '',
                avatar: user?.avatar || '',
                text: content,
                message: content,
                to: '@' + targetName,
                timestamp: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
                status: 'sent',
            };
            if (WebSocketService.socket?.connected) {
                WebSocketService.socket.emit('send_message', msgData);
            }
            this._saveChatMessage(msgData, '@' + targetName);
        });
        document.getElementById('forwardModal')?.classList.add('hidden');
        NotificationService.show('Gesendet', `An ${this._forwardSelected.length} User weitergeleitet!`, 'success');
        // 3 Minuten Cooldown
        this._forwardCooldown = true;
        setTimeout(() => { this._forwardCooldown = false; }, 3 * 60 * 1000);
    },

    // ── Eigene Nachricht löschen ──
    ctxDeleteMsg() {
        if (!this._ctxMsgId) return;
        document.getElementById('ctxMenu')?.classList.add('hidden');
        const msgEl = document.getElementById(this._ctxMsgId);
        if (msgEl) msgEl.remove();
        // Aus localStorage löschen
        const numId = parseInt(this._ctxMsgId.replace('msg-', ''));
        try {
            Object.keys(localStorage).filter(k => k.startsWith('chat_history_')).forEach(k => {
                const msgs = JSON.parse(localStorage.getItem(k) || '[]');
                const filtered = msgs.filter(m => m.id !== numId);
                if (filtered.length !== msgs.length) {
                    localStorage.setItem(k, JSON.stringify(filtered));
                }
            });
        } catch(e) {}
        // Server informieren
        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('msg_delete', { msgId: this._ctxMsgId });
        }
    },

    // ── Custom Background ──────────────────────────────────────
    setCustomBackground() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;
            // Bild auf max 1920px skalieren um localStorage nicht zu sprengen
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxW = 1920;
                const scale = Math.min(1, maxW / img.width);
                canvas.width = img.width * scale;
                canvas.height = img.height * scale;
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                try {
                    localStorage.setItem('custom_bg', dataUrl);
                } catch(err) {
                    NotificationService.show('Fehler', 'Bild zu groß für den Speicher.', 'error');
                    return;
                }
                this._applyBackground(dataUrl);
                NotificationService.show('Hintergrund', 'Wallpaper wurde gesetzt!', 'success');
            };
            img.src = URL.createObjectURL(file);
        };
        input.click();
    },

    resetBackground() {
        localStorage.removeItem('custom_bg');
        localStorage.removeItem('bg_blur');
        document.documentElement.style.backgroundImage = '';
        document.documentElement.style.backgroundSize = '';
        document.documentElement.style.backgroundPosition = '';
        const el = document.getElementById('customBgLayer');
        if (el) { el.style.backgroundImage = 'none'; el.style.filter = 'none'; }
        document.body.classList.remove('has-custom-bg');
        document.documentElement.classList.remove('has-custom-bg');
        const slider = document.getElementById('bgBlurSlider');
        if (slider) slider.value = 0;
        NotificationService.show('Hintergrund', 'Wallpaper wurde zurückgesetzt.', 'info');
    },

    setBgBlur(val) {
        localStorage.setItem('bg_blur', val);
        const bg = localStorage.getItem('custom_bg');
        if (bg) this._applyBackground(bg);
    },

    _applyBackground(dataUrl) {
        // Direkt auf html setzen — kein separater Layer nötig
        const html = document.documentElement;
        html.style.backgroundImage = `url(${dataUrl})`;
        html.style.backgroundSize = 'cover';
        html.style.backgroundPosition = 'center';
        html.style.backgroundRepeat = 'no-repeat';
        html.style.backgroundAttachment = 'fixed';
        const blur = localStorage.getItem('bg_blur') || 0;
        // Blur via separatem Layer (html selbst kann nicht geblurred werden)
        let el = document.getElementById('customBgLayer');
        if (blur > 0) {
            if (!el) { el = document.createElement('div'); el.id = 'customBgLayer'; document.body.prepend(el); }
            el.style.backgroundImage = `url(${dataUrl})`;
            el.style.filter = `blur(${blur}px)`;
            html.style.backgroundImage = 'none';
        } else if (el) {
            el.style.backgroundImage = 'none';
            el.style.filter = 'none';
        }
        document.body.classList.add('has-custom-bg');
        html.classList.add('has-custom-bg');
    },

    _loadSavedBackground() {
        const bg = localStorage.getItem('custom_bg');
        if (bg) this._applyBackground(bg);
        const blur = localStorage.getItem('bg_blur') || 0;
        const slider = document.getElementById('bgBlurSlider');
        if (slider) slider.value = blur;
    }
};

// =============================================================
// UI SOUNDS — Hover + Click auf interaktive Elemente
// =============================================================
// =============================================================
// STRG+V PASTE — Bilder aus Zwischenablage einfügen
// =============================================================
document.addEventListener('paste', (e) => {
    if (document.activeElement?.id !== 'chatInput') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (!file) return;
            if (file.size > 10 * 1024 * 1024) {
                NotificationService.show('Zu groß', 'Max. 10 MB!', 'error');
                return;
            }
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const scale = Math.min(1, 600 / img.width);
                    canvas.width = img.width * scale;
                    canvas.height = img.height * scale;
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    const compressed = canvas.toDataURL('image/jpeg', 0.75);
                    const input = document.getElementById('chatInput');
                    if (input) input.value = compressed;
                    App.sendMessage();
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
            return;
        }
    }
});

// Hover-Sound deaktiviert
document.addEventListener('click', (e) => {
    const target = e.target.closest('button, .ovn-node, .fwd-user-item, .ctx-item, .gif-tab');
    if (target && window.App) App.playClickSound();
}, true);

// =============================================================
// RECHTSKLICK KONTEXTMENÜ
// =============================================================
document.addEventListener('contextmenu', (e) => {
    const ctx = document.getElementById('ctxMenu');
    if (!ctx) return;

    const img = e.target.closest('.chat-embed-img, .gif-item');
    const msgItem = e.target.closest('.msg-item');

    if (!img && !msgItem) return;
    e.preventDefault();

    // Reset
    const dlBtn = document.getElementById('ctxDownloadBtn');
    const fwdBtn = document.getElementById('ctxForwardBtn');
    const delBtn = document.getElementById('ctxDeleteBtn');

    if (img) {
        App._ctxTarget = img.src;
        if (dlBtn) dlBtn.classList.remove('hidden');
        if (fwdBtn) fwdBtn.classList.remove('hidden');
    } else {
        App._ctxTarget = null;
        if (dlBtn) dlBtn.classList.add('hidden');
        if (fwdBtn) fwdBtn.classList.add('hidden');
    }

    // Eigene Nachricht? → Delete zeigen
    if (msgItem && msgItem.classList.contains('own')) {
        App._ctxMsgId = msgItem.id;
        App._ctxIsOwn = true;
        if (delBtn) delBtn.classList.remove('hidden');
    } else {
        App._ctxMsgId = null;
        App._ctxIsOwn = false;
        if (delBtn) delBtn.classList.add('hidden');
    }

    // Nur anzeigen wenn mindestens 1 Button sichtbar
    const hasVisible = [dlBtn, fwdBtn, delBtn].some(b => b && !b.classList.contains('hidden'));
    if (!hasVisible) return;

    ctx.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    ctx.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
    ctx.classList.remove('hidden');
});
document.addEventListener('click', () => {
    document.getElementById('ctxMenu')?.classList.add('hidden');
});

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
    // Typing indicator
    if (document.activeElement?.id === 'chatInput' && e.key !== 'Enter') {
        if (!App._typingTimeout) {
            const user = AuthService.getUser();
            WebSocketService.socket?.emit('typing_start', { to: App.currentChat || 'general', username: user?.username });
        }
        clearTimeout(App._typingTimeout);
        App._typingTimeout = setTimeout(() => {
            const user = AuthService.getUser();
            WebSocketService.socket?.emit('typing_stop', { to: App.currentChat || 'general', username: user?.username });
            App._typingTimeout = null;
        }, 2000);
    }
});

// =============================================================
// BOOTSTRAP & IPC LISTENERS
// =============================================================
if (window.electronAPI) {
    window.electronAPI.onUpdateAvailable((version) => {
        const banner = document.getElementById('updateBanner');
        if (banner) {
            banner.classList.remove('hidden');
            document.getElementById('updateBannerTitle').textContent = `Update v${version} verfügbar`;
            document.getElementById('updateBannerText').textContent = 'Bereite Download vor...';
            document.getElementById('updateProgressBar').style.width = '0%';
        }
    });

    window.electronAPI.onUpdateProgress((percent) => {
        const bar = document.getElementById('updateProgressBar');
        const pctText = document.getElementById('updatePercent');
        if (bar) bar.style.width = percent + '%';
        if (pctText) pctText.textContent = Math.round(percent) + '%';
        document.getElementById('updateBannerText').textContent = 'Dateien werden heruntergeladen...';
    });

    window.electronAPI.onUpdateDownloaded(() => {
        const banner = document.getElementById('updateBanner');
        if (banner) {
            banner.classList.remove('hidden');
            document.getElementById('updateBannerTitle').textContent = 'Download abgeschlossen!';
            document.getElementById('updateBannerText').innerHTML = '<strong>Die neue Version ist bereit.</strong>';
            document.getElementById('updateProgressBar').style.width = '100%';
            document.getElementById('updatePercent').textContent = '100%';
            document.getElementById('updateBtn').style.display = 'block';
            NotificationService.show('Update bereit!', 'Die App kann jetzt neu gestartet werden.', 'success');
        }
    });
}

// =============================================================
// ROBLOX SERVICE — Bio-Verifikations-System
// =============================================================
const RobloxService = {
    STORAGE_KEY: 'rblx_profile',

    getProfile() {
        try { return JSON.parse(localStorage.getItem(this.STORAGE_KEY) || 'null'); }
        catch { return null; }
    },

    saveProfile(profile) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(profile));
    },

    clearProfile() {
        localStorage.removeItem(this.STORAGE_KEY);
    },

    // Schritt 1: Benutzername suchen, Code generieren
    async startVerify(discordId, robloxUsername) {
        return ApiService.post('/api/roblox/start-verify', { discordId, robloxUsername });
    },

    // Schritt 2: Code in Bio prüfen → Profil zurückgeben
    async confirmVerify(discordId) {
        return ApiService.post('/api/roblox/confirm-verify', { discordId });
    },
};

// --- Roblox UI Methoden ---
Object.assign(App, {
    _rblxVerifyCode: null,

    // Zeigt den richtigen Roblox-State an
    showRobloxState(state) {
        // 'disconnected' | 'verifying' | 'connected'
        const el = id => document.getElementById(id);
        const hide = id => { const e = el(id); if (e) e.classList.add('hidden'); };
        const show = id => { const e = el(id); if (e) e.classList.remove('hidden'); };
        hide('rblxStateDisconnected'); hide('rblxStateVerifying'); hide('rblxStateConnected');
        if (state === 'disconnected') show('rblxStateDisconnected');
        else if (state === 'verifying') show('rblxStateVerifying');
        else if (state === 'connected') show('rblxStateConnected');
    },

    // Beim Start die gespeicherten Roblox-Daten laden
    async loadRobloxState() {
        let profile = RobloxService.getProfile();
        const user = AuthService.getUser();

        // Wenn kein lokales Profil da ist, frage die Bot-API (für bereits verknüpfte User)
        if (!profile && user?.discordId) {
            console.log('[Roblox] Suche Link in Bot-Datenbank...');
            const data = await ApiService.get(`/api/roblox/profile?discordId=${encodeURIComponent(user.discordId)}`);
            if (data && data.success && data.profile) {
                profile = data.profile;
                RobloxService.saveProfile(profile);
                console.log('[Roblox] Link gefunden und lokal gespeichert.');
            }
        }

        if (profile) {
            this.renderRobloxCard(profile);
        } else {
            this.showRobloxState('disconnected');
        }
    },

    // "Verknüpfen" geklickt → OAuth2 Flow starten
    _robloxOAuthCooldown: false,
    startBioVerify() {
        const step1 = document.getElementById('rblxStep1');
        const step2 = document.getElementById('rblxStep2');
        if (step1) step1.style.display = 'block';
        if (step2) step2.style.display = 'none';
        const input = document.getElementById('rblxUsernameInput');
        if (input) input.value = '';
        this.showRobloxState('verifying');
    },

    async startRobloxVerify() {
        if (this._robloxOAuthCooldown) {
            NotificationService.show('Bitte warten', 'Warte 30 Sekunden bevor du es erneut versuchst.', 'warn');
            return;
        }

        const user = AuthService.getUser();
        if (!user?.discordId) {
            NotificationService.show('Fehler', 'Nicht eingeloggt.', 'error');
            return;
        }

        this._robloxOAuthCooldown = true;
        setTimeout(() => { this._robloxOAuthCooldown = false; }, 30000);

        const btn = document.querySelector('#rblxStateDisconnected button');
        if (btn) { btn.disabled = true; btn.textContent = 'Öffne Roblox...'; }

        const result = await ApiService.get(`/api/roblox/auth?discordId=${encodeURIComponent(user.discordId)}`);

        if (btn) { btn.disabled = false; btn.textContent = 'Verknüpfen'; }

        if (!result?.url) {
            NotificationService.show('Hinweis', 'OAuth nicht verfügbar — nutze Bio-Verifikation.', 'warn');
            const step1 = document.getElementById('rblxStep1');
            const step2 = document.getElementById('rblxStep2');
            if (step1) step1.style.display = 'block';
            if (step2) step2.style.display = 'none';
            const input = document.getElementById('rblxUsernameInput');
            if (input) input.value = '';
            this.showRobloxState('verifying');
            return;
        }

        // 1. Lokalen Callback-Server starten (localhost:7329)
        const botCallbackUrl = `${CONFIG.API_URL}/api/roblox/callback`;
        if (window.electronAPI?.startRobloxCallbackServer) {
            window.electronAPI.startRobloxCallbackServer(botCallbackUrl);
        }

        // 2. Browser öffnen
        if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(result.url);
        } else {
            window.open(result.url, '_blank');
        }

        NotificationService.show('Roblox Login', 'Bitte im Browser einloggen und bestätigen...', 'info');
    },

    cancelRobloxVerify() {
        this.showRobloxState('disconnected');
    },

    robloxBack() {
        const step1 = document.getElementById('rblxStep1');
        const step2 = document.getElementById('rblxStep2');
        if (step1) step1.style.display = 'block';
        if (step2) step2.style.display = 'none';
    },

    // Schritt 1: Username nach Code suchen
    async robloxStep1() {
        const input = document.getElementById('rblxUsernameInput');
        const username = input?.value?.trim();
        if (!username) { NotificationService.show('Fehler', 'Bitte Roblox-Username eingeben.', 'warn'); return; }

        const user = AuthService.getUser();
        if (!user?.discordId) { NotificationService.show('Fehler', 'Nicht eingeloggt.', 'error'); return; }

        const btn = document.querySelector('#rblxStep1 button');
        if (btn) { btn.disabled = true; btn.textContent = 'Suche...'; }

        const result = await RobloxService.startVerify(user.discordId, username);

        if (btn) { btn.disabled = false; btn.textContent = 'Weiter'; }

        if (!result?.success) {
            NotificationService.show('Fehler', result?.error || 'Benutzer nicht gefunden.', 'error');
            return;
        }

        this._rblxVerifyCode = result.code;
        const codeBox = document.getElementById('rblxCodeBox');
        if (codeBox) codeBox.textContent = result.code;

        const step1 = document.getElementById('rblxStep1');
        const step2 = document.getElementById('rblxStep2');
        if (step1) step1.style.display = 'none';
        if (step2) step2.style.display = 'block';
    },

    // Schritt 2: Prüfen ob der Code in der Bio steht
    async robloxStep2() {
        const user = AuthService.getUser();
        if (!user?.discordId) return;

        const btn = document.getElementById('rblxConfirmBtn');
        const txt = document.getElementById('rblxConfirmText');
        if (btn) btn.disabled = true;
        if (txt) txt.textContent = 'Prüfe...';

        const result = await RobloxService.confirmVerify(user.discordId);

        if (btn) btn.disabled = false;
        if (txt) txt.textContent = 'Verifizieren';

        if (!result?.success) {
            NotificationService.show('Fehler', result?.error || 'Code nicht gefunden.', 'error');
            return;
        }

        RobloxService.saveProfile(result.profile);
        this.renderRobloxCard(result.profile);
        NotificationService.show('Roblox verbunden! 🎮', `Willkommen, ${result.profile.displayName}!`, 'success');
    },

    // Rendert die Profilkarte mit allen Daten
    renderRobloxCard(profile) {
        const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v || '—'; };

        const avatarEl = document.getElementById('rblxAvatar');
        const fallbackEl = document.getElementById('rblxAvatarFallback');
        if (profile.avatar && avatarEl) {
            avatarEl.src = profile.avatar;
            avatarEl.style.display = 'block';
            if (fallbackEl) fallbackEl.style.display = 'none';
        } else if (fallbackEl) {
            fallbackEl.style.display = 'flex';
            fallbackEl.textContent = (profile.username || 'R')[0].toUpperCase();
            if (avatarEl) avatarEl.style.display = 'none';
        }

        setEl('rblxDisplayName', profile.displayName);
        setEl('rblxUsername', '@' + profile.username);
        setEl('rblxUserId', profile.userId);

        const fmtDate = iso => {
            if (!iso) return '—';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '—';
            return d.toLocaleDateString('de-DE', { year: 'numeric', month: 'short', day: 'numeric' });
        };
        setEl('rblxCreated', fmtDate(profile.created));
        setEl('rblxConnectedAt', fmtDate(profile.connectedAt));

        const bioWrap = document.getElementById('rblxBioWrap');
        if (profile.description && bioWrap) {
            bioWrap.style.display = 'block';
            setEl('rblxBio', profile.description);
        } else if (bioWrap) {
            bioWrap.style.display = 'none';
        }

        const profileLink = document.getElementById('rblxProfileLink');
        if (profileLink) profileLink.dataset.url = profile.profileUrl || '';

        this.showRobloxState('connected');

        // Roblox Badge im Account-Bereich anzeigen
        const rblxBadge = document.getElementById('robloxLinkBadge');
        if (rblxBadge) rblxBadge.classList.remove('hidden');

        // Overlay starten
        const user = AuthService.getUser();
        if (user && window.electronAPI?.showRobloxOverlay) {
            window.electronAPI.showRobloxOverlay(user.discordId, profile.userId, user.role === 'admin');
        }
    },

    // Manuelles Testen des Overlays
    testRobloxOverlay() {
        if (window.electronAPI?.testRobloxOverlay) {
            window.electronAPI.testRobloxOverlay();
            NotificationService.show('Test gestartet', 'Overlay wurde ein Befehl gesendet.', 'success');
        }
    },

    // Öffnet das Roblox-Profil im Browser
    openRobloxProfile(event) {
        event.preventDefault();
        const url = event.currentTarget?.dataset?.url || RobloxService.getProfile()?.profileUrl;
        if (url && window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(url);
        }
    },

    // Roblox-Verbindung trennen
    disconnectRoblox() {
        RobloxService.clearProfile();
        this.showRobloxState('disconnected');
        const rblxBadge = document.getElementById('robloxLinkBadge');
        if (rblxBadge) rblxBadge.classList.add('hidden');
        if (window.electronAPI?.hideRobloxOverlay) {
            window.electronAPI.hideRobloxOverlay();
        }
        NotificationService.show('Roblox getrennt', 'Dein Roblox-Konto wurde getrennt.', 'info');
    },
    // --- ADMIN ACTIONS ---
    async sendAdminWebhook() {
        const title = document.getElementById('webhookTitle').value.trim();
        const message = document.getElementById('webhookMessage').value.trim();
        const WEBHOOK_URL = 'https://discord.com/api/webhooks/1488902385786028084/MNd5QLJOThjoA8JZP2LDr2l3-dDzzQVCz4pCqCsMTEVVjIwnMfmqmlyvHXeSosXwOZPc';

        if (!title || !message) {
            NotificationService.show('Fehler', 'Titel und Nachricht werden benötigt.', 'error');
            return;
        }

        try {
            if (window.electronAPI && window.electronAPI.sendToDiscord) {
                // Main-Prozess erwartet version (Titel) und notes (Nachricht)
                window.electronAPI.sendToDiscord({
                    webhookUrl: WEBHOOK_URL,
                    version: title,
                    notes: message
                });
                NotificationService.show('Gesendet!', 'Discord-Benachrichtigung wurde versendet.', 'success');
                document.getElementById('webhookTitle').value = '';
                document.getElementById('webhookMessage').value = '';
            }
        } catch (e) {
            NotificationService.show('Fehler', 'Konnte Webhook nicht senden.', 'error');
        }
    },

    // --- LIVE NEWS ---
    async loadLiveNews() {
        const NEWS_URL = 'https://enrp.princearmy.de/announcements.json';
        const newsContainer = document.getElementById('newsList');
        if (!newsContainer) return;

        try {
            console.log('[News] Lade Live-News von Website...');
            const res = await fetch(`${NEWS_URL}?t=${Date.now()}`, { cache: 'no-store' });
            if (!res.ok) throw new Error('Konnten News nicht laden');

            const data = await res.json();
            const news = data.announcements || [];

            if (news.length === 0) {
                newsContainer.innerHTML = '<div class="news-empty">Keine aktuellen News vorhanden.</div>';
                return;
            }

            newsContainer.innerHTML = news.map(item => `
                <div class="news-card">
                    <div class="nc-tag">${item.tag || 'INFO'}</div>
                    <div class="nc-date">${item.date || ''}</div>
                    <div class="nc-title">${escHtml(item.title)}</div>
                    <div class="nc-text">${escHtml(item.content)}</div>
                    ${item.url ? `<button class="btn-small btn-open-news" data-url="${escHtml(item.url)}">Mehr lesen</button>` : ''}
                </div>
            `).join('');
            newsContainer.querySelectorAll('.btn-open-news').forEach(btn => {
                btn.addEventListener('click', () => {
                    window.electronAPI?.openExternal(btn.dataset.url);
                });
            });

            console.log(`[News] ${news.length} News-Beiträge geladen.`);
        } catch (e) {
            console.error('[News] Fehler beim Laden der Live-News:', e.message);
            newsContainer.innerHTML = '<div class="news-error">Live-News konnten nicht geladen werden.</div>';
        }
    },

    // Schnittstelle zum UpdateManager (Icon-Klick)
    showUpdateDialog() {
        if (typeof UpdateManager !== 'undefined') {
            UpdateManager.showUpdateDialog();
        }
    },

    // --- HIGH-END EFFECTS ───
    initBackgroundParallax() {
        document.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth - 0.5) * 20;
            const y = (e.clientY / window.innerHeight - 0.5) * 20;
            
            // Grid-Bewegung
            const grids = document.querySelectorAll('.splash-grid');
            grids.forEach(grid => {
                grid.style.transform = `translate(${x}px, ${y}px)`;
            });
            
            // Orbs-Bewegung (etwas stärker für Tiefe)
            const orbs = document.querySelectorAll('.splash-orb');
            orbs.forEach(orb => {
                const speed = orb.classList.contains('orb1') ? 40 : 60;
                orb.style.transform = `translate(${x * (speed/20)}px, ${y * (speed/20)}px)`;
            });
        });
    },
    // --- VOICE (Walkie-Talkie) ───
    // renderVoiceChannels() und selectVoiceChannel() sind oben im App-Objekt definiert.
    // Diese Kopien wurden entfernt um Doppelfunktionen zu vermeiden.
    // Der Leave-Button ✕ wird jetzt in der Haupt-renderVoiceChannels() gerendert.

    // --- PTT HOTKEY LOGIK ---
    isSpeaking: false,          // V-Taste gedrückt (Kanal offen)
    isActuallySending: false,   // Nur wenn Sprache erkannt
    pttKey: localStorage.getItem('ptt_key') || 'v',
    pttSoundUrl: localStorage.getItem('ptt_sound_url') || './walkie-talkie-start.mp3.wav',
    pttVolume: parseFloat(localStorage.getItem('ptt_volume') || '0.5'),
    radioEffectEnabled: localStorage.getItem('radio_effect') !== 'false', // Default: an
    selectedMicId: localStorage.getItem('selected_mic') || 'default',
    isMonitoring: false,
    _staticLoop: null,
    _micStream: null,
    _mediaRecorder: null,
    _activeSpeakers: {},
    // VAD (Voice Activity Detection)
    _vadContext: null,
    _playCtx: null,      // Shared AudioContext für eingehende Audio-Chunks
    _blipCtx: null,      // Shared AudioContext für playBlip
    _radioCtx: null,     // Shared AudioContext für Radio-Effekt (eingehend)
    _incomingStreams: {}, // username → { ms, sb, audio, queue }
    _vadAnalyser: null,
    _vadBuffer: null,
    _vadInterval: null,
    _VAD_THRESHOLD: 8,  // 0-255 — Lautstärke-Schwelle ab der gesendet wird

    async initPTTHandlers() {
        // Walkie-Talkie Loop Sound (lokale Datei)
        this._staticLoop = new Audio('./walkie-talkie-start.mp3.wav');
        this._staticLoop.loop = true;
        this._staticLoop.volume = this.pttVolume * 0.1;
        this._staticLoop.onerror = () => {
            console.warn('[PTT] Loop-Sound konnte nicht geladen werden - Silent Mode.');
            this._staticLoop = null;
        };

        try {
            await navigator.mediaDevices.getUserMedia({ audio: true });
            this.refreshMicList();
        } catch (e) {
            console.error('[Mic] Zugriff verweigert:', e);
        }

        // V-Taste DRÜCKEN → Kanal öffnen
        document.addEventListener('keydown', (e) => {
            if (e.repeat) return; // Key-Repeat verhindern
            if (e.key.toLowerCase() !== this.pttKey) return;
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
            if (!this.isSpeaking) this.startPTT();
        });
        // V-Taste LOSLASSEN → Kanal schließen
        document.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() !== this.pttKey) return;
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
            this.stopPTT();
        });

        // IPC: Globaler PTT (z.B. wenn Focus im Overlay-Fenster ist)
        if (window.electronAPI?.onOverlayPTTStart) {
            window.electronAPI.onOverlayPTTStart(() => this.startPTT());
        }
        if (window.electronAPI?.onOverlayPTTStop) {
            window.electronAPI.onOverlayPTTStop(() => this.stopPTT());
        }

        // Initiale Sync mit main.js
        if (window.electronAPI?.setPTTKey) {
            window.electronAPI.setPTTKey(this.pttKey.toUpperCase());
        }
        
        // PTT Hint im UI updaten
        const pttKeyHint = document.getElementById('wt-ptt-key-hint');
        if (pttKeyHint) pttKeyHint.textContent = `[ ${this.pttKey.toUpperCase()} ]`;
    },

    setPTTKey(k) {
        if (!k || k.length === 0) return;
        this.pttKey = k.toLowerCase().charAt(0);
        localStorage.setItem('ptt_key', this.pttKey);
        
        const inp = document.getElementById('pttKeyInput');
        if (inp) inp.value = this.pttKey.toUpperCase();
        
        const pttKeyHint = document.getElementById('wt-ptt-key-hint');
        if (pttKeyHint) pttKeyHint.textContent = `[ ${this.pttKey.toUpperCase()} ]`;

        if (window.electronAPI?.setPTTKey) {
            window.electronAPI.setPTTKey(this.pttKey.toUpperCase());
        }
        
        NotificationService.show('Hotkey geändert', `Neuer Funk-Key: ${this.pttKey.toUpperCase()}`, 'info');
    },

    setPTTSound(url) {
        if (!url) return;
        this.pttSoundUrl = url;
        localStorage.setItem('ptt_sound_url', url);
        NotificationService.show('Sound aktualisiert', 'Dein neuer Funk-Sound ist aktiv.', 'success');
    },

    syncSoundUI() {
        const hInp = document.getElementById('pttKeyInput');
        if (hInp) hInp.value = this.pttKey.toUpperCase();
        
        const sInp = document.getElementById('pttSoundInput');
        if (sInp) sInp.value = this.pttSoundUrl;

        const vInp = document.querySelector('.volume-slider');
        if (vInp) vInp.value = this.pttVolume;

        this.refreshMicList();

        // Radio-Effekt Toggle UI sync
        const radioLabel = document.getElementById('radioEffectLabel');
        const radioBtn = document.getElementById('btnRadioEffect');
        if (radioLabel) radioLabel.textContent = this.radioEffectEnabled ? 'FUNK AN' : 'FUNK AUS';
        if (radioBtn) radioBtn.classList.toggle('off', !this.radioEffectEnabled);
    },

    // Monitoring wurde in v1.2.8 entfernt/deaktiviert
    toggleMonitoring() {
        NotificationService.show('Audio-Info', 'Mic-Monitoring ist in dieser Version nicht verfügbar.', 'info');
    },

    async refreshMicList() {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        const sel = document.getElementById('micSelect');
        if (sel) {
            sel.innerHTML = mics.map(m => `<option value="${m.deviceId}" ${m.deviceId === this.selectedMicId ? 'selected' : ''}>${m.label || 'Mikrofon'}</option>`).join('');
        }
    },

    setMic(id) {
        this.selectedMicId = id;
        localStorage.setItem('selected_mic', id);
        NotificationService.show('Audio-Input', 'Mikrofon wurde gewechselt.', 'info');
    },

    setVolume(v) {
        this.pttVolume = parseFloat(v);
        localStorage.setItem('ptt_volume', v);
        if (this._staticLoop) this._staticLoop.volume = this.pttVolume * 0.1;
    },

    // Busy-Ton: error.wav wenn Kanal belegt ──────────────────────
    _playBusyTone() {
        try {
            const snd = new Audio('./error.wav');
            snd.volume = 0.4;
            snd.play().catch(() => {});
        } catch(e) {}
    },

    async startPTT() {
        if (this.isSpeaking) return;

        // ── Kanal belegt? Jemand sendet bereits ──────────────────
        if (Object.keys(this._activeSpeakers).length > 0) {
            this._playBusyTone();
            const status = document.getElementById('pttStatus');
            if (status) {
                const prev = { text: status.textContent, color: status.style.color, shadow: status.style.textShadow };
                status.textContent = '⛔ KANAL BELEGT';
                status.style.color = '#ff8c00';
                status.style.textShadow = '0 0 10px rgba(255,140,0,0.5)';
                setTimeout(() => {
                    if (!this.isSpeaking) {
                        status.textContent = prev.text;
                        status.style.color = prev.color;
                        status.style.textShadow = prev.shadow;
                    }
                }, 1500);
            }
            return;
        }

        // ── 1. Mikrofon öffnen ────────────────────────────────────
        try {
            this._micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    deviceId: this.selectedMicId !== 'default' ? { exact: this.selectedMicId } : undefined,
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                }
            });
        } catch (e) {
            console.error('[Voice] Mikrofon-Fehler:', e);
            NotificationService.show('Mikrofon-Fehler', 'Konnte Mikrofon nicht öffnen: ' + e.message, 'error');
            return;
        }

        this.isSpeaking = true;

        // UI sofort auf SENDEN schalten
        const btn = document.getElementById('pttBtn');
        if (btn) { btn.classList.add('active'); btn.classList.add('transmitting'); }
        const rings = document.getElementById('wt-ptt-rings');
        if (rings) { rings.classList.add('listening'); rings.classList.add('transmitting'); }
        const status = document.getElementById('pttStatus');
        if (status) {
            status.textContent = '🔴 SENDE...';
            status.style.color = '#ff3c3c';
            status.style.textShadow = '0 0 14px rgba(255,60,60,0.6)';
        }
        document.getElementById('wt-signal')?.classList.add('active');

        // Kanal-Öffnungs-Sound
        this.playRadioStatic(true);

        // Direkt senden — kein VAD
        this._startVoiceSend();

        // Overlay-Signal
        const activeCh = MockData.voiceChannels.find(vc => vc.active);
        const user     = AuthService.getUser();
        window.electronAPI?.updateOverlayState?.({
            type: 'voice_ptt', active: true,
            user: user?.username || 'User',
            channel: activeCh ? activeCh.name : 'Funk'
        });

        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
    },

    // Startet den MediaRecorder wenn Sprache erkannt ──────────────
    _startVoiceSend() {
        if (this.isActuallySending || !this._micStream) return;
        this.isActuallySending = true;

        const activeCh = MockData.voiceChannels.find(vc => vc.active);
        const user     = AuthService.getUser();
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';

        this._mediaRecorder = new MediaRecorder(this._micStream, { mimeType, audioBitsPerSecond: 32000 });

        this._mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0 && WebSocketService.socket?.connected) {
                const reader = new FileReader();
                reader.onloadend = () => {
                    WebSocketService.socket.emit('voice_audio_chunk', {
                        channelId: activeCh?.id || 'vc-1',
                        username:  user?.username || 'User',
                        discordId: user?.discordId || '',
                        avatar:    user?.avatar    || '',
                        mimeType,
                        data: reader.result.split(',')[1],
                    });
                };
                reader.readAsDataURL(e.data);
            }
        };

        this._mediaRecorder.start(150);

        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('voice_ptt_start', {
                channelId: activeCh?.id || 'vc-1',
                username:  user?.username || 'User',
                discordId: user?.discordId || '',
                avatar:    user?.avatar    || '',
            });
        }

        const status = document.getElementById('pttStatus');
        if (status) {
            status.textContent = '🔴 SENDE...';
            status.style.color = '#ff3c3c';
            status.style.textShadow = '0 0 14px rgba(255,60,60,0.6)';
        }
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.add('transmitting');
        const rings = document.getElementById('wt-ptt-rings');
        if (rings) rings.classList.add('transmitting');
        
        // Lokales Mic Update
        this.renderVoiceChannels();
    },

    // Pausiert den MediaRecorder bei Stille ───────────────────────
    _pauseVoiceSend() {
        if (!this.isActuallySending) return;
        this.isActuallySending = false;

        if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
            this._mediaRecorder.stop();
            this._mediaRecorder = null;
        }

        const activeCh = MockData.voiceChannels.find(vc => vc.active);
        const user     = AuthService.getUser();
        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('voice_ptt_stop', {
                channelId: activeCh?.id || 'vc-1',
                username:  user?.username || 'User',
                discordId: user?.discordId || '',
            });
        }

        const status = document.getElementById('pttStatus');
        if (status) {
            status.textContent = '🟡 WARTE AUF SPRACHE...';
            status.style.color = '#ffcc00';
            status.style.textShadow = '0 0 10px rgba(255,204,0,0.5)';
        }
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.remove('transmitting');
        const rings = document.getElementById('wt-ptt-rings');
        if (rings) rings.classList.remove('transmitting');

        // Lokales Mic Update
        this.renderVoiceChannels();
    },

    stopPTT() {
        if (!this.isSpeaking) return;
        this.isSpeaking        = false;
        this.isActuallySending = false;

        // (kein VAD mehr)

        // MediaRecorder stoppen
        if (this._mediaRecorder && this._mediaRecorder.state !== 'inactive') {
            this._mediaRecorder.stop();
            this._mediaRecorder = null;
        }
        if (this._micStream) {
            this._micStream.getTracks().forEach(t => t.stop());
            this._micStream = null;
        }

        // PTT-Stop Signal
        const activeCh = MockData.voiceChannels.find(vc => vc.active);
        const user     = AuthService.getUser();
        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('voice_ptt_stop', {
                channelId: activeCh?.id || 'vc-1',
                username:  user?.username || 'User',
                discordId: user?.discordId || '',
            });
        }

        // UI
        this.playRadioStatic(false);
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        window.electronAPI?.updateOverlayState?.({ type: 'voice_ptt', active: false });

        const btn = document.getElementById('pttBtn');
        if (btn) { btn.classList.remove('active'); btn.classList.remove('transmitting'); }
        const rings = document.getElementById('wt-ptt-rings');
        if (rings) { rings.classList.remove('listening'); rings.classList.remove('transmitting'); }
        document.getElementById('wt-signal')?.classList.remove('active');

        const status = document.getElementById('pttStatus');
        if (status) {
            const ch = MockData.voiceChannels.find(vc => vc.active);
            status.textContent = ch?.name ? `VERBUNDEN · #${ch.name.toUpperCase()}` : 'NICHT VERBUNDEN';
            status.style.color = 'var(--status-online)';
            status.style.textShadow = 'none';
        }
    },

    // ── LIVE-STREAMING via MediaSource API ──────────────────────
    _openVoiceStream(username, mimeType) {
        this._closeVoiceStream(username); // vorherigen aufräumen
        try {
            const mime = MediaSource.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus' : 'audio/webm';
            const ms    = new MediaSource();
            const audio = new Audio();
            audio.src = URL.createObjectURL(ms);

            // ── Walkie-Talkie Radio-Effekt via Web Audio ─────────
            let radioConnected = false;
            const vol = Math.min(1.0, this.pttVolume * 2.0);

            if (this.radioEffectEnabled) {
                try {
                    if (!this._radioCtx || this._radioCtx.state === 'closed') {
                        this._radioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    }
                    if (this._radioCtx.state === 'suspended') this._radioCtx.resume().catch(() => {});
                    const ctx = this._radioCtx;

                    const src = ctx.createMediaElementSource(audio);

                    // 1) Sanfter Highpass — Bässe leicht reduzieren
                    const hp = ctx.createBiquadFilter();
                    hp.type = 'highpass';
                    hp.frequency.value = 200;
                    hp.Q.value = 0.5;

                    // 2) Lowpass — Höhen sanft kappen
                    const lp = ctx.createBiquadFilter();
                    lp.type = 'lowpass';
                    lp.frequency.value = 4000;
                    lp.Q.value = 0.5;

                    // 3) Leichter Mid-Boost (Funk-Charakter, nicht nasal)
                    const peak = ctx.createBiquadFilter();
                    peak.type = 'peaking';
                    peak.frequency.value = 1800;
                    peak.Q.value = 0.8;
                    peak.gain.value = 3;

                    // 4) Sehr leichte Verzerrung (nur Wärme, kein Crunch)
                    const ws = ctx.createWaveShaper();
                    const n = 512, amount = 8;
                    const curve = new Float32Array(n);
                    for (let i = 0; i < n; i++) {
                        const x = (i * 2) / n - 1;
                        curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
                    }
                    ws.curve = curve;
                    ws.oversample = '2x';

                    // 5) Sehr leises Rauschen (kaum hörbar, nur Atmosphäre)
                    const noiseLen = ctx.sampleRate * 2;
                    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
                    const noiseData = noiseBuf.getChannelData(0);
                    for (let i = 0; i < noiseLen; i++) noiseData[i] = (Math.random() * 2 - 1);
                    const noiseNode = ctx.createBufferSource();
                    noiseNode.buffer = noiseBuf;
                    noiseNode.loop = true;
                    const noiseBpf = ctx.createBiquadFilter();
                    noiseBpf.type = 'bandpass';
                    noiseBpf.frequency.value = 2500;
                    noiseBpf.Q.value = 0.3;
                    const noiseGain = ctx.createGain();
                    noiseGain.gain.value = 0.005; // extrem leise

                    noiseNode.connect(noiseBpf);
                    noiseBpf.connect(noiseGain);

                    // 6) Master Gain
                    const masterGain = ctx.createGain();
                    masterGain.gain.value = vol;

                    // Chain: src → hp → lp → peak → waveshaper → masterGain → out
                    src.connect(hp);
                    hp.connect(lp);
                    lp.connect(peak);
                    peak.connect(ws);
                    ws.connect(masterGain);
                    noiseGain.connect(masterGain);
                    masterGain.connect(ctx.destination);

                    noiseNode.start();
                    audio.volume = 1;
                    radioConnected = true;

                    audio.addEventListener('pause', () => { try { noiseNode.stop(); } catch(e) {} }, { once: true });
                } catch(e) {
                    if (!radioConnected) audio.volume = vol;
                }
            } else {
                audio.volume = vol;
            }

            const stream = { ms, audio, sb: null, queue: [], url: audio.src };
            this._incomingStreams[username] = stream;

            ms.addEventListener('sourceopen', () => {
                try {
                    stream.sb = ms.addSourceBuffer(mime);
                    stream.sb.mode = 'sequence';
                    stream.sb.addEventListener('updateend', () => {
                        if (stream.queue.length > 0 && !stream.sb.updating) {
                            try { stream.sb.appendBuffer(stream.queue.shift()); } catch(e) {}
                        }
                    });
                    // Queued chunks die ankamen bevor sourceopen fertig war
                    if (stream.queue.length > 0 && !stream.sb.updating) {
                        try { stream.sb.appendBuffer(stream.queue.shift()); } catch(e) {}
                    }
                } catch(e) {}
            });

            audio.play().catch(() => {});
        } catch(e) {}
    },

    _appendVoiceChunk(username, bytes) {
        const stream = this._incomingStreams[username];
        if (!stream) return;
        if (stream.sb && !stream.sb.updating) {
            try { stream.sb.appendBuffer(bytes); } catch(e) { stream.queue.push(bytes); }
        } else {
            stream.queue.push(bytes);
        }
    },

    _closeVoiceStream(username) {
        const stream = this._incomingStreams[username];
        if (!stream) return;
        delete this._incomingStreams[username];
        setTimeout(() => {
            try { if (stream.ms.readyState === 'open') stream.ms.endOfStream(); } catch(e) {}
            stream.audio.pause();
            URL.revokeObjectURL(stream.url);
        }, 500);
    },

    // Fallback für direkte Blob-Wiedergabe (nicht mehr primär genutzt)
    _playIncomingAudio(chunks, mimeType) {
        try {
            const blob  = new Blob(chunks, { type: mimeType || 'audio/webm;codecs=opus' });
            const url   = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = Math.min(1.0, this.pttVolume * 2.0);
            const cleanup = () => URL.revokeObjectURL(url);
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.play().catch(cleanup);
        } catch(e) {}
    },

    // ── Wer-spricht-Anzeige updaten ──────────────────────────────
    _setSpeakerActive(username, active) {
        if (active) {
            this._activeSpeakers[username] = Date.now();
        } else {
            delete this._activeSpeakers[username];
        }
        this._renderSpeakingOverlay();
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        this.renderWTMembers();
    },

    _renderSpeakingOverlay() {
        const speakers = Object.keys(this._activeSpeakers);
        const pttStatus = document.getElementById('pttStatus');
        const waveform = document.getElementById('wt-waveform');

        if (speakers.length > 0 && !this.isSpeaking) {
            if (pttStatus) {
                pttStatus.textContent = '🔊 ' + speakers.join(', ').toUpperCase() + ' SPRICHT...';
                pttStatus.style.color = '#4DA6FF';
                pttStatus.style.textShadow = '0 0 10px rgba(0,136,255,0.6)';
            }
            if (waveform) waveform.classList.add('active');
        } else if (!this.isSpeaking) {
            if (waveform) waveform.classList.remove('active');
        }
    },

    // ── Socket.IO Voice Events registrieren ─────────────────────
    initVoiceSocketEvents(socket) {
        // Eingehende Audio-Chunks → MediaSource Live-Streaming
        socket.on('voice_audio_chunk', (data) => {
            const me = AuthService.getUser();
            if (data.username === me?.username) return;
            try {
                const binary = atob(data.data);
                const bytes  = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                this._appendVoiceChunk(data.username, bytes);
            } catch(e) {}
        });

        // Anderer User drückt PTT → neuen Live-Stream öffnen
        socket.on('voice_ptt_start', (data) => {
            const me = AuthService.getUser();
            if (data.username === me?.username) return;
            console.log('[Voice] 🔊', data.username, 'sendet...');
            this._openVoiceStream(data.username, data.mimeType || 'audio/webm;codecs=opus');
            this._setSpeakerActive(data.username, true);
            try { const s = new Audio('./chirsp.wav'); s.volume = 0.25; s.play().catch(() => {}); } catch(e) {}
        });

        // Anderer User lässt PTT los → Stream schließen
        socket.on('voice_ptt_stop', (data) => {
            const me = AuthService.getUser();
            if (data.username === me?.username) return;
            console.log('[Voice] ⏹', data.username, 'hat aufgehört.');
            this._closeVoiceStream(data.username);
            this._setSpeakerActive(data.username, false);

            const status  = document.getElementById('pttStatus');
            const waveform = document.getElementById('wt-waveform');
            const activeCh = MockData.voiceChannels.find(vc => vc.active);
            if (!this.isSpeaking && Object.keys(this._activeSpeakers).length === 0) {
                if (status) {
                    status.textContent = activeCh?.name ? `VERBUNDEN · #${activeCh.name.toUpperCase()}` : 'NICHT VERBUNDEN';
                    status.style.color = 'var(--status-online)';
                    status.style.textShadow = 'none';
                }
                if (waveform) waveform.classList.remove('active');
            }
            try { const s = new Audio('./out.wav'); s.volume = 0.25; s.play().catch(() => {}); } catch(e) {}
        });

        // Kanal-Mitglieder-Update (v1.6.1: Entfernt da nun via WebSocketService zentral)
        // (Wird oben bereits in WebSocketService.connect() gehandelt)
    },

    playRadioStatic(active) {
        try {
            if (active) {
                const snd = new Audio('./chirsp.wav');
                snd.volume = 0.35;
                snd.play().catch(() => {});
            } else {
                const snd = new Audio('./out.wav');
                snd.volume = 0.35;
                snd.play().catch(() => {});
            }
        } catch(e) {}
    },

    renderWTMembers() {
        const el = document.getElementById('wtMemberList');
        if (!el) return;

        const activeVC = MockData.voiceChannels.find(vc => vc.active);
        if (!activeVC || !activeVC.members || activeVC.members.length === 0) {
            el.innerHTML = '<div class="wt-empty-msg">Keinem Kanal beigetreten</div>';
            return;
        }

        const me = AuthService.getUser();
        el.innerHTML = activeVC.members.map(m => {
            const isMe = m === 'Du' || m === me?.username;
            const isSpeaking = !!this._activeSpeakers?.[m];
            const isTransmitting = isMe && this.isSpeaking;
            const initial = (m || 'U')[0].toUpperCase();

            const micIconReady = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" opacity="0.25"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
            const micIconTx = `<svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" class="wt-mic-tx"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
            const micIconRx = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="15" height="15" class="wt-mic-rx"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;

            let badge = '';
            let icon = micIconReady;
            if (isTransmitting) { badge = '<span class="wt-live-badge tx">TX</span>'; icon = micIconTx; }
            else if (isSpeaking)  { badge = '<span class="wt-live-badge rx">RX</span>'; icon = micIconRx; }

            const statusText = isTransmitting ? 'SENDET GERADE' : isSpeaking ? 'EMPFÄNGT AUDIO' : 'BEREIT';
            const classes = ['wt-member-item', isMe ? 'is-me' : '', isSpeaking ? 'is-speaking' : '', isTransmitting ? 'transmitting' : ''].filter(Boolean).join(' ');

            return `<div class="${classes}">
                <div class="wt-member-avatar-wrap">
                    <div class="wt-member-avatar">${initial}</div>
                    ${isSpeaking || isTransmitting ? '<div class="wt-speaking-ring"></div>' : ''}
                </div>
                <div class="wt-member-info">
                    <span class="wt-member-name">${escHtml(m)}${isMe ? ' <small class="wt-you-tag">DU</small>' : ''}</span>
                    <span class="wt-member-status">${statusText}</span>
                </div>
                ${badge}
                <div class="wt-member-mic-icon">${icon}</div>
            </div>`;
        }).join('');
    },

    renderActiveVoiceCard() {
        const activeContainer = document.getElementById('activeVoiceContainer'); 
        if (!activeContainer) return;

        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc) {
            activeContainer.innerHTML = '';
            return;
        }

        const user = AuthService.getUser();
        const avatarHtml = user?.avatar ? `<img src="${user.avatar}" class="avc-p-img">` : `<div class="avc-p-initials">${user?.username ? user.username[0].toUpperCase() : 'U'}</div>`;
        
        // Alle Teilnehmer außer mir selbst
        const otherMembers = (vc.members || []).filter(m => m !== 'Du' && m !== user?.username);

        activeContainer.innerHTML = `
            <div class="active-voice-card animated-in">
                <div class="avc-head">
                   <div class="avc-icon">📻</div>
                   <div class="avc-name">#${escHtml(vc.name)}</div>
                   <span class="status-live-badge" style="margin-left:auto;">LIVE</span>
                </div>
                <div class="avc-participants">
                    <div class="avc-p-item me">
                        ${avatarHtml}
                        <span class="avc-p-name">Du</span>
                    </div>
                    ${otherMembers.map(m => `
                        <div class="avc-p-item">
                            <div class="avc-p-initials">${m[0]?.toUpperCase() || '?'}</div>
                            <span class="avc-p-name">${escHtml(m)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    },
});


document.addEventListener('DOMContentLoaded', () => {
    App.init();
});