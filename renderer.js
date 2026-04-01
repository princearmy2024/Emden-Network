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

let CURRENT_VERSION = '2.0.1'; // Stand: 30.03.2026 (Versions-Synchronisierung, Konsistenz-Fix)

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
                announceOnline();
                // Nach Socket-Verbindung sofort Status neu holen (für frische User-Liste)
                setTimeout(() => this._fetchStatus(), 2000);
                // ── VOICE EVENTS registrieren (nach jeder Verbindung) ──
                App.initVoiceSocketEvents(this.socket);
            });

            this.socket.on('disconnect', () => {
                console.log('[Socket] Getrennt.');
            });
            
            this.socket.on('chat_message', (data) => {
                if (window.App && App.appendChatMessage) {
                    App.appendChatMessage(data);
                }
            });

            // Alle 20s nochmal melden
            if (this._announceInterval) clearInterval(this._announceInterval);
            this._announceInterval = setInterval(announceOnline, 20000);

            this.socket.on('chat_history', (msgs) => {
                const chatBox = document.getElementById('chatMessages');
                if (chatBox) chatBox.innerHTML = '';

                const now = Date.now();
                const oneDay = 24 * 60 * 60 * 1000;

                // 24h FILTER: Nur Nachrichten der letzten 24 Stunden anzeigen
                const freshMsgs = msgs.filter(m => {
                    const msgTime = (m.id && !isNaN(m.id)) ? parseInt(m.id) : now;
                    return (now - msgTime) < oneDay;
                });

                freshMsgs.forEach(m => App.appendChatMessage(m));
            });

            this.socket.on('receive_message', (msg) => {
                App.appendChatMessage(msg);
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
const App = {
    currentView: 'overview',
    currentChat: 'general',
    messages: [], // Zentraler Speicher für Filterung
    _clockInterval: null,

    // --- INIT ---
    async init() {
        console.log(`[App] Initialisiere Dashboard v1.6.6...`);
        
        // Background Parallax Effekt für den High-End Look
        this.initBackgroundParallax();
        
        try {
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

            if (AuthService.loadSession() && AuthService.isLoggedIn()) {
                this.showDashboard(AuthService.getUser());
                this.renderActiveVoiceCard(); // Active Voice Card beim Start laden
                this.syncSoundUI(); // Key & Audio in UI laden
            } else {
                this.showScreen('loginScreen');
                this.initLoginHandlers();
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
        WebSocketService.connect();
        this.loadLiveNews(); // News live von der Website laden

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
            const imgUrl = user.avatar || user.PFB || user.pfb;
            if (imgUrl) {
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
    },

    renderFullUserList(onlineUsers) {
        // Konsolen-Log für den Detektiv in dir (zum Debuggen)
        console.log('[Presence] Online Users vom Server:', onlineUsers);

        const registry = UserRegistry.get();

        // 1. Online-User in die Registry aufnehmen (falls sie noch nicht da sind)
        onlineUsers.forEach(u => {
            const id = u.discordId || u.id || u.username;
            if (id) {
                // Wir aktualisieren hier auch die echten Daten, falls der Server was neues geschickt hat
                registry[id] = { ...u, discordId: id, lastSeen: Date.now() };
            }
        });

        // 2. Online-IDs für den grünen Punkt sammeln
        const onlineIds = new Set(onlineUsers.map(u => u.discordId || u.id || u.username));

        // 3. Die Liste erst JETZT aus der Registry ziehen (nachdem die neuen drin sind!)
        const now = Date.now();
        const CUTOFF = 30 * 60 * 1000;  // 30 minutes
        const allMembers = Object.values(registry).filter(u => 
            onlineIds.has(u.discordId) || 
            (now - u.lastSeen) < CUTOFF
        );

        // Zähler nur für ECHTE online Leute
        const onlineCount = onlineUsers.length;
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
                    <img src="${u.avatar}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;position:relative;z-index:1;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
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
                    <span class="ovn-name">${escHtml(u.username)}</span>
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
        
        // UI im Header aktualisieren
        const headTitle = document.getElementById('activeChatName');
        if (headTitle) headTitle.textContent = name.startsWith('@') ? name : '#' + name;
        
        const headSub = document.getElementById('chatHeaderOnlineText');
        if (headSub) {
            if (name.startsWith('@')) {
                headSub.textContent = 'Privatchat mit ' + name.substring(1);
            } else {
                // Standard-Handling...
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
        
        // Sound-Feedback (Walkie-Talkie Vibe)
        this.playBlip(700, 0.05);

        // Chat-Verlauf neu rendern
        this.renderCurrentChat();
    },

    renderCurrentChat() {
        const msgs = document.getElementById('chatMessages');
        if (!msgs) return;
        msgs.innerHTML = '';
        
        const user = AuthService.getUser();
        const filtered = this.messages.filter(m => {
            if (this.currentChat.startsWith('@')) {
                // PN Logik: (An @User und von mir) ODER (An mich und von @User)
                const targetName = this.currentChat.substring(1);
                return (m.to === this.currentChat && m.userId === user.discordId) || 
                       (m.to === '@' + user.username && m.username === targetName);
            } else {
                // Global/Channel Logik
                return m.to === this.currentChat || (!m.to && this.currentChat === 'general');
            }
        });

        // Die letzten 50 Nachrichten rendern
        filtered.slice(-50).forEach(m => this._renderSingleMessage(m));
        msgs.scrollTop = msgs.scrollHeight;
    },

    appendChatMessage(msg) {
        // In Speicher ablegen
        const isExists = this.messages.some(m => m.id === msg.id);
        if (!isExists) {
            this.messages.push(msg);
            // Retention: Nur Nachrichten von heute behalten (ca. 24h)
            const oneDay = 24 * 60 * 60 * 1000;
            const now = Date.now();
            this.messages = this.messages.filter(m => {
                const msgTime = typeof m.id === 'number' ? m.id : now;
                return (now - msgTime) < oneDay;
            });
        }

        // Falls Nachricht für aktuellen Chat bestimmt ist -> sofort anzeigen
        const user = AuthService.getUser();
        let shouldShow = false;
        if (this.currentChat.startsWith('@')) {
            const targetName = this.currentChat.substring(1);
            shouldShow = (msg.to === this.currentChat && msg.userId === user.discordId) || 
                         (msg.to === '@' + user.username && msg.username === targetName);
        } else {
            shouldShow = (msg.to === this.currentChat || (!msg.to && this.currentChat === 'general'));
        }

        if (shouldShow) {
            this._renderSingleMessage(msg);
            // Sound bei fremden Nachrichten
            if (msg.username !== user.username) this.playBlip(900, 0.08);
        }
    },

    _renderSingleMessage(msg) {
        const msgs = document.getElementById('chatMessages');
        if (!msgs) return;
        const user = AuthService.getUser();
        const isOwn = user?.discordId === msg.userId;

        // Vermeiden, dass Nachrichten doppelt im DOM auftauchen
        if (msgs.querySelector(`[data-msgid="${msg.id}"]`)) return;

        const initial = (msg.username || 'U')[0].toUpperCase();
        const el = document.createElement('div');
        el.className = 'msg-item ' + (isOwn ? 'own' : '');
        el.setAttribute('data-msgid', msg.id);

        const imgUrl = msg.avatar || msg.PFB || msg.pfb;
        const avatarHtml = imgUrl
            ? `<img src="${imgUrl}" style="width:100%;height:100%;border-radius:inherit;object-fit:cover;" onerror="this.onerror=null; this.src=''; this.parentElement.innerHTML='<div class=\'avatar-fallback-inner\'>${initial}</div>';">`
            : `<div class="avatar-fallback-inner">${initial}</div>`;
        
        const timestamp = msg.timestamp || new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

        if (isOwn) {
            el.innerHTML = `
              <div class="msg-body">
                <div class="msg-meta"><span class="msg-user">Du</span><span class="msg-time">${timestamp}</span></div>
                <div class="msg-text">${escHtml(msg.text)}</div>
              </div>
              <div class="msg-avatar you">${avatarHtml}</div>
            `;
        } else {
            el.innerHTML = `
              <div class="msg-avatar">${avatarHtml}</div>
              <div class="msg-body">
                <div class="msg-meta"><span class="msg-user">${escHtml(msg.username)}</span><span class="msg-time">${timestamp}</span></div>
                <div class="msg-text">${escHtml(msg.text)}</div>
              </div>
            `;
        }
        msgs.appendChild(el);
        msgs.scrollTop = msgs.scrollHeight;
    },

    // --- SOUND ENGINE (Walkie-Talkie Effects) ---
    playBlip(freq = 800, duration = 0.1) {
        try {
            // Shared AudioContext wiederverwenden — nie mehr als 1 gleichzeitig
            if (!this._blipCtx || this._blipCtx.state === 'closed') {
                this._blipCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this._blipCtx.state === 'suspended') this._blipCtx.resume().catch(() => {});
            const context = this._blipCtx;

            const osc = context.createOscillator();
            const gain = context.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, context.currentTime);
            osc.frequency.exponentialRampToValueAtTime(freq / 2, context.currentTime + duration);
            gain.gain.setValueAtTime(0.05, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + duration);
            osc.connect(gain);
            gain.connect(context.destination);
            osc.start();
            osc.stop(context.currentTime + duration);
        } catch (e) {
            // AudioContext nicht verfügbar — kein Crash
        }
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
            title.textContent = '🔊 Sprachkanal erstellen';
            body.innerHTML = `
                <div class="input-group">
                    <label class="input-label">KANAL-NAME</label>
                    <input type="text" id="newVoiceName" class="input-field" placeholder="z.B. team-call">
                </div>
                <div class="input-group" style="margin-top:15px;">
                    <label class="input-label">KANAL-TYP</label>
                    <div style="display:flex; gap:10px; margin-top:8px;">
                        <label style="flex:1; cursor:pointer;" onclick="App._tempVoiceType='public'; document.querySelectorAll('.v-type-opt').forEach(el=>el.classList.remove('active')); this.querySelector('.v-type-opt').classList.add('active')">
                            <div class="v-type-opt active">🌐 Öffentlich</div>
                        </label>
                        <label style="flex:1; cursor:pointer;" onclick="App._tempVoiceType='private'; document.querySelectorAll('.v-type-opt').forEach(el=>el.classList.remove('active')); this.querySelector('.v-type-opt').classList.add('active'); document.getElementById('vcPasswordGroup').classList.remove('hidden')">
                            <div class="v-type-opt">🔒 Privat</div>
                        </label>
                    </div>
                </div>
                <div class="input-group hidden" id="vcPasswordGroup" style="margin-top:15px; animation: slideDown 0.3s ease;">
                    <label class="input-label">KANAL-PASSWORT</label>
                    <input type="password" id="newVoicePassword" class="input-field" placeholder="Passwort festlegen">
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px; margin-top:20px;">
                    <button class="btn btn-primary" onclick="App.createVoiceChannel()" style="width:100%;">Erstellen</button>
                    <button class="btn btn-ghost" onclick="App.closeModal()" style="width:100%;">Abbrechen</button>
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

        const title = '<div class="section-title">Sprachkanäle</div>';
        const activeVC = MockData.voiceChannels.find(vc => vc.active);
        const html = MockData.voiceChannels.map(vc => `
            <div class="voice-channel-item ${vc.active ? 'active' : ''}" onclick="App.selectVoiceChannel('${vc.id}')">
                <div class="vc-info">
                    <div class="vc-icon">${vc.active ? '🔊' : vc.type === 'private' ? '🔒' : '📻'}</div>
                    <div class="vc-name">#${escHtml(vc.name)}</div>
                    ${vc.active ? '<span class="status-live-badge">LIVE</span>' : ''}
                </div>
                ${vc.active ? `<button class="vc-leave-btn" onclick="event.stopPropagation(); App.leaveVoiceChannel('${vc.id}')" title="Kanal verlassen">✕</button>` : ''}
            </div>
        `).join('');

        listContainer.innerHTML = title + html;
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
    sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input || !input.value.trim()) return;
        
        const msg = input.value.trim();
        input.value = '';

        if (WebSocketService.socket?.connected) {
            WebSocketService.socket.emit('chat_message', {
                channel: this.currentChat || 'general',
                message: msg
            });
            // Hinzufügen der eigenen Nachricht ins Chatfenster
            this.appendChatMessage({
                username: AuthService.getUser()?.username,
                message: msg
            });
        } else {
            NotificationService.show('Verbindungsfehler', 'Keine Verbindung zum Chat-Server aktiv.', 'error');
        }
    },
    
    appendChatMessage(data) {
        const chatBox = document.querySelector('.chat-messages');
        if (!chatBox) return;
        
        const isOwn = data.username === AuthService.getUser()?.username;
        const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

        const html = `
            <div class="msg-item ${isOwn ? 'own' : ''}">
                ${!isOwn ? `<div class="msg-avatar" style="background:${this.getStringColor?.(data.username) || '#0088FF'}">${data.username ? data.username[0].toUpperCase() : 'U'}</div>` : ''}
                <div class="msg-body">
                    <div class="msg-meta"><span class="msg-user">${isOwn ? 'Du' : escHtml(data.username || 'System')}</span><span class="msg-time">${time}</span></div>
                    <div class="msg-text">${escHtml(data.message || '')}</div>
                </div>
                ${isOwn ? `<div class="msg-avatar you" style="background:var(--accent-blue)">U</div>` : ''}
            </div>
        `;
        
        chatBox.insertAdjacentHTML('beforeend', html);
        chatBox.scrollTop = chatBox.scrollHeight;
    },

    getStringColor(str) {
        let hash = 0;
        if (!str) return 'var(--accent-blue)';
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        return `hsl(${Math.abs(hash) % 360}, 70%, 50%)`;
    }
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
    async startRobloxVerify() {
        const user = AuthService.getUser();
        if (!user?.discordId) {
            NotificationService.show('Fehler', 'Nicht eingeloggt.', 'error');
            return;
        }

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
            if (e.key.toLowerCase() === this.pttKey && !this.isSpeaking) {
                const active = document.activeElement;
                if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
                this.startPTT();
            }
        });
        // V-Taste LOSLASSEN → Kanal schließen
        document.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === this.pttKey) {
                this.stopPTT();
            }
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

    // Busy-Ton: drei absteigende Pieptöne wenn Kanal belegt ──────
    _playBusyTone() {
        try {
            if (!this._blipCtx || this._blipCtx.state === 'closed') {
                this._blipCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this._blipCtx.state === 'suspended') this._blipCtx.resume().catch(() => {});
            const ctx = this._blipCtx;
            const now = ctx.currentTime;
            [[440, 0, 0.07], [370, 0.09, 0.07], [311, 0.18, 0.12]].forEach(([freq, t, dur]) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'square';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.1, now + t);
                gain.gain.exponentialRampToValueAtTime(0.001, now + t + dur);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now + t);
                osc.stop(now + t + dur);
            });
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

                    // 1) Highpass — alles unter 300 Hz weg (Funk hat keine Bässe)
                    const hp = ctx.createBiquadFilter();
                    hp.type = 'highpass';
                    hp.frequency.value = 300;
                    hp.Q.value = 0.7;

                    // 2) Lowpass — alles über 3400 Hz weg (schmaler Funk-Kanal)
                    const lp = ctx.createBiquadFilter();
                    lp.type = 'lowpass';
                    lp.frequency.value = 3400;
                    lp.Q.value = 0.7;

                    // 3) Mid-Boost bei 1.5 kHz (typischer Funk-Nasal-Sound)
                    const peak = ctx.createBiquadFilter();
                    peak.type = 'peaking';
                    peak.frequency.value = 1500;
                    peak.Q.value = 1.5;
                    peak.gain.value = 6;

                    // 4) Verzerrung (stärkerer Funk-Crunch)
                    const ws = ctx.createWaveShaper();
                    const n = 512, amount = 40;
                    const curve = new Float32Array(n);
                    for (let i = 0; i < n; i++) {
                        const x = (i * 2) / n - 1;
                        curve[i] = ((Math.PI + amount) * x) / (Math.PI + amount * Math.abs(x));
                    }
                    ws.curve = curve;
                    ws.oversample = '4x';

                    // 5) Leises Rauschen (Funk-Static im Hintergrund)
                    const noiseLen = ctx.sampleRate * 2;
                    const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
                    const noiseData = noiseBuf.getChannelData(0);
                    for (let i = 0; i < noiseLen; i++) noiseData[i] = (Math.random() * 2 - 1);
                    const noiseNode = ctx.createBufferSource();
                    noiseNode.buffer = noiseBuf;
                    noiseNode.loop = true;
                    const noiseBpf = ctx.createBiquadFilter();
                    noiseBpf.type = 'bandpass';
                    noiseBpf.frequency.value = 2000;
                    noiseBpf.Q.value = 0.5;
                    const noiseGain = ctx.createGain();
                    noiseGain.gain.value = 0.012; // sehr leise — nur Atmosphäre

                    noiseNode.connect(noiseBpf);
                    noiseBpf.connect(noiseGain);

                    // 6) Master Gain
                    const masterGain = ctx.createGain();
                    masterGain.gain.value = vol * 1.1;

                    // Chain: src → hp → lp → peak → waveshaper → masterGain → out
                    src.connect(hp);
                    hp.connect(lp);
                    lp.connect(peak);
                    peak.connect(ws);
                    ws.connect(masterGain);
                    noiseGain.connect(masterGain); // Rauschen zum Master mixen
                    masterGain.connect(ctx.destination);

                    noiseNode.start();
                    audio.volume = 1;
                    radioConnected = true;

                    // Noise stoppen wenn Stream endet
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
            this.playBlip(800, 0.05);
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
            this.playBlip(600, 0.05);
        });

        // Kanal-Mitglieder-Update (v1.6.1: Entfernt da nun via WebSocketService zentral)
        // (Wird oben bereits in WebSocketService.connect() gehandelt)
    },

    playRadioStatic(active) {
        if (active) {
            // Einmal kurz abspielen beim Drücken — kein Loop
            const openSound = new Audio(this.pttSoundUrl);
            openSound.volume = 0.15;
            openSound.play().catch(() => {});
        } else {
            // End-Beep beim Loslassen
            this.playBlip(500, 0.1);
            setTimeout(() => this.playBlip(400, 0.05), 100);
        }
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