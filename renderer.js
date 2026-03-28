'use strict';

window.CURRENT_VERSION = '1.5.0';

const CONFIG = {
    API_URL: 'http://91.98.124.212:5009',
    // FIX: API_KEY gehört NICHT ins Frontend — serverseitig absichern!
    // Temporär gelassen aber NICHT in Production verwenden
    API_KEY: 'emden-super-secret-key-2026',
};

// =============================================================
// SERVICES
// =============================================================

const AuthService = {
    session: null,
    async verify(code) {
        try {
            const res = await fetch(`${CONFIG.API_URL}/api/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify({ code: code.trim() }),
                signal: AbortSignal.timeout(12000),
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
            return { success: false, error: 'Verbindungsfehler: ' + err.message };
        }
    },
    saveSession() { localStorage.setItem('en_session', JSON.stringify(this.session)); },
    loadSession() {
        try {
            const raw = localStorage.getItem('en_session');
            if (raw) { this.session = JSON.parse(raw); return true; }
        } catch (e) { }
        return false;
    },
    logout() { this.session = null; localStorage.removeItem('en_session'); },
    getUser() { return this.session?.user || null; },
    isLoggedIn() { return !!this.session?.token; },
};

const ApiService = {
    async get(endpoint) {
        try {
            const res = await fetch(`${CONFIG.API_URL}${endpoint}`, {
                headers: { 'x-api-key': CONFIG.API_KEY }
            });
            return await res.json();
        } catch (e) { return null; }
    },
    async post(endpoint, body) {
        try {
            const res = await fetch(`${CONFIG.API_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify(body)
            });
            return await res.json();
        } catch (e) { return null; }
    }
};

const WebSocketService = {
    socket: null,
    connect() {
        if (!window.io) { console.warn('[WS] socket.io nicht geladen'); return; }
        this.socket = window.io(CONFIG.API_URL);

        this.socket.on('connect', () => {
            const user = AuthService.getUser();
            if (user) this.socket.emit('client_online', { ...user, discordId: user.id || user.discordId });
        });

        this.socket.on('receive_message', (msg) => App.appendChatMessage(msg));
        this.socket.on('online_users', (users) => App.renderOnlineUsers(users));
        this.socket.on('voice_state_update', (channels) => {
            MockData.voiceChannels = channels;
            App.renderVoiceChannels();
            App.renderActiveVoiceCard();
        });
        this.socket.on('voice_audio_relay', (data) => {
            const user = AuthService.getUser();
            const myId = user?.id || user?.discordId;
            if (data.user?.discordId !== myId) {
                VoiceEngine.playIncoming(data.user?.discordId, data.audioBlob);
            }
        });

        // Discord Live Stats update
        this.socket.on('discord_stats', (data) => {
            if (data.members) document.querySelectorAll('#liveMembers, #statMembersTotal').forEach(el => el.textContent = data.members.toLocaleString());
            if (data.onlineMembers) document.getElementById('liveOnline').textContent = data.onlineMembers;
        });

        const myId = AuthService.getUser()?.discordId;
        if (myId) {
            this.socket.on(`roblox_connected_${myId}`, (profile) => App.finishRobloxVerify(profile));
            this.socket.on(`roblox_error_${myId}`, (err) => NotificationService.show('Roblox Fehler', err.error || 'Verbindung fehlgeschlagen', 'error'));
        }
    }
};

const NotificationService = {
    show(title, message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<div><strong>${escHtml(title)}</strong><br>${escHtml(message)}</div>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 5500);
        // FIX: Prüfe ob electronAPI verfügbar ist
        if (window.electronAPI?.sendOverlayNotification) {
            window.electronAPI.sendOverlayNotification({ title, message, type });
        }
    }
};

const MockData = {
    servers: [
        { id: 1, name: 'Main Node', status: 'online', ip: '91.98.124.212' },
        { id: 2, name: 'Backup Node', status: 'online', ip: '91.98.124.213' }
    ],
    channels: [{ id: 1, name: 'general' }, { id: 2, name: 'support' }],
    voiceChannels: []
};

// =============================================================
// MAIN APP
// =============================================================

const App = {
    currentView: 'overview',
    currentChat: 'general',
    isSpeaking: false,
    pttKey: localStorage.getItem('ptt_key') || 'v',
    pttVolume: parseFloat(localStorage.getItem('ptt_volume') || '0.5'),
    pttSoundUrl: localStorage.getItem('ptt_sound_url') || '',
    selectedMicId: localStorage.getItem('selected_mic') || 'default',
    isMonitoring: false,

    async init() {
        console.log('[App] Starte v1.5.0...');
        this.initBackgroundParallax();
        this.startClock();
        this.initPTTHandlers();
        this.initSettingsUI();

        if (AuthService.loadSession() && AuthService.isLoggedIn()) {
            this.showDashboard(AuthService.getUser());
        } else {
            this.showScreen('loginScreen');
            this.initLoginHandlers();
        }

        // FIX: electronAPI Guard
        if (window.electronAPI?.onUpdateDownloaded) {
            window.electronAPI.onUpdateDownloaded(() => {
                const btn = document.getElementById('updateBtn');
                if (btn) btn.style.display = 'block';
                const banner = document.getElementById('updateBanner');
                if (banner) banner.classList.remove('hidden');
                NotificationService.show('Update bereit!', 'Bitte neu starten.', 'success');
            });
        }
    },

    initLoginHandlers() {
        const btnVerify = document.getElementById('btnVerify');
        const verifyInput = document.getElementById('verifyInput');
        const btnDiscord = document.getElementById('btnDiscord');

        if (btnVerify && verifyInput) {
            const doVerify = async () => {
                if (!verifyInput.value.trim()) return;
                btnVerify.disabled = true;
                const res = await AuthService.verify(verifyInput.value);
                if (res.success) this.showDashboard(res.user);
                else {
                    NotificationService.show('Fehler', res.error, 'error');
                    btnVerify.disabled = false;
                }
            };
            btnVerify.addEventListener('click', doVerify);
            // Enter-Taste im Input
            verifyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doVerify(); });
        }

        if (btnDiscord) {
            btnDiscord.addEventListener('click', () => {
                window.open('https://discord.com/channels/@me', '_blank');
            });
        }
    },

    showDashboard(user) {
        this.applyUser(user);
        this.renderChannels();
        this.renderServers();
        this.showScreen('dashboardScreen');
        this.navigate('overview');
        WebSocketService.connect();
        
        // WalkieTalkie NACH connect() initialisieren
        setTimeout(() => WalkieTalkie.init(), 500);

        this.startStatsMonitor();
        this.loadAnnouncements(); 
        this.loadGithubChangelog(); 
        this.loadRobloxState();
    },

    applyUser(user) {
        if (!user) return;
        // FIX: Dynamische Begrüßung statt hardcoded "Guten Abend"
        const hour = new Date().getHours();
        const greeting = hour < 12 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : hour < 22 ? 'Guten Abend' : 'Gute Nacht';
        const greetingEl = document.querySelector('.ov-greeting');
        if (greetingEl) greetingEl.innerHTML = `${greeting}, <span class="ov-username" id="overviewUsername">${escHtml(user.username)}</span>`;

        document.querySelectorAll('.username-field, #settingsUsername').forEach(el => el.textContent = user.username);
        const img = user.avatar
            ? `<img src="${user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
            : user.username[0].toUpperCase();
        document.querySelectorAll('.avatar-field, #sidebarAvatar, #topbarAvatar, #settingsAvatar').forEach(el => el.innerHTML = img);
        document.querySelectorAll('#settingsRole').forEach(el => el.textContent = user.role === 'admin' ? 'Administrator' : 'Benutzer');
        if (user.role === 'admin') {
            document.querySelectorAll('.admin-only, #adminBadge').forEach(el => el.classList.remove('hidden'));
        }
    },

    navigate(view) {
        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById('view-' + view);
        if (target) target.classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => {
            n.classList.toggle('active', n.dataset.view === view);
        });
        const labels = {
            overview: 'Übersicht', messages: 'Nachrichten', notifications: 'Benachrichtigungen',
            channels: 'Channels', walkie: 'Walkie-Talkie', servers: 'Server',
            settings: 'Einstellungen', admin: 'Admin Panel'
        };
        const breadcrumb = document.getElementById('topbarBreadcrumb');
        if (breadcrumb) breadcrumb.textContent = labels[view] || view;
    },

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(id);
        if (target) target.classList.add('active');
    },

    // FIX: showModal hinzugefügt — wurde in index.html aufgerufen aber fehlte
    showModal(type) {
        NotificationService.show('Info', `"${type}" noch nicht implementiert.`, 'info');
    },

    // FIX: showUpdateDialog hinzugefügt — wurde in index.html aufgerufen aber fehlte
    showUpdateDialog() {
        const banner = document.getElementById('updateBanner');
        if (banner) banner.classList.remove('hidden');
    },

    // --- RENDERERS ---
    renderChannels() {
        const el = document.getElementById('channelList');
        if (!el) return;
        el.innerHTML = MockData.channels.map(ch => `
            <div class="channel-item" onclick="App.openChat('${ch.name}')">
                <span>#</span> ${escHtml(ch.name)}
            </div>
        `).join('');
    },

    openChat(name) {
        this.currentChat = name;
        this.navigate('messages');
        const el = document.getElementById('activeChatName');
        if (el) el.textContent = '#' + name;
    },

    renderVoiceChannels() {
        const el = document.querySelector('.voice-channels');
        if (!el) return;
        el.innerHTML = '<div class="section-title">Sprachkanäle</div>' + MockData.voiceChannels.map(vc => `
            <div class="voice-channel-item ${vc.active ? 'active' : ''}" onclick="App.selectVoiceChannel('${vc.id}')">
                <div class="vc-info">
                    <div class="vc-icon">${vc.active ? '🔊' : '📻'}</div>
                    <div class="vc-name">#${escHtml(vc.name)}</div>
                </div>
                <div class="vc-members">
                    ${(vc.members || []).map(m => `<div class="vc-member-avatar" title="${escHtml(m.username)}" style="background:var(--brand-blue)">${m.username[0]}</div>`).join('')}
                </div>
            </div>
        `).join('');
    },

    renderOnlineUsers(users) {
        const el = document.getElementById('chatOnlineUsersList');
        if (!el) return;
        const badge = document.getElementById('chatOnlineCountBadge');
        if (badge) badge.textContent = users.length;
        const countText = document.getElementById('chatHeaderOnlineText');
        if (countText) countText.textContent = users.length + ' online';
        el.innerHTML = users.map(u => `
            <div class="online-user-item">
                <div class="user-avatar-small" style="background:#2b2d31;">
                    ${u.avatar ? `<img src="${escHtml(u.avatar)}" style="width:100%;height:100%;object-fit:cover;">` : (u.username || '?')[0]}
                </div>
                <span>${escHtml(u.username)}</span>
                <div class="status-dot online"></div>
            </div>
        `).join('');
    },

    renderActiveVoiceCard() {
        const el = document.getElementById('activeVoiceContainer');
        if (!el) return;
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc) { el.innerHTML = ''; return; }
        const myId = AuthService.getUser()?.id || AuthService.getUser()?.discordId;
        el.innerHTML = `
            <div class="active-voice-card">
                <div class="avc-head">
                    <span>${escHtml(vc.name)}</span>
                    <button class="avc-leave" onclick="App.leaveVoiceChannel()">✕</button>
                </div>
                <div class="avc-participants">
                    <div class="avc-p-item ${this.isSpeaking ? 'speaking' : ''}">
                        <div class="p-avatar">Du</div>
                        <span class="p-name">Du</span>
                    </div>
                    ${(vc.members || []).filter(m => m.discordId !== myId).map(m => `
                        <div class="avc-p-item ${m.isSpeaking ? 'speaking' : ''}">
                            <div class="p-avatar" style="background:var(--brand-blue)">${m.username[0]}</div>
                            <span class="p-name">${escHtml(m.username)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    },

    renderServers() {
        const grid = document.getElementById('serverGrid');
        if (!grid) return;
        grid.innerHTML = MockData.servers.map(s => `
            <div class="server-card ${s.status}">
                <strong>${escHtml(s.name)}</strong><br>${escHtml(s.ip)}
            </div>
        `).join('');
    },

    // --- CHAT ---
    sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input?.value.trim()) return;
        const user = AuthService.getUser();
        const msg = {
            username: user?.username,
            avatar: user?.avatar,
            text: input.value.trim(),
            userId: user?.id || user?.discordId,
            to: this.currentChat,
            timestamp: Date.now()
        };
        this.appendChatMessage(msg);
        WebSocketService.socket?.emit('send_message', msg);
        input.value = '';
    },

    appendChatMessage(msg) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const user = AuthService.getUser();
        const isOwn = msg.userId === (user?.id || user?.discordId);
        const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const avatarHtml = msg.avatar
            ? `<img src="${escHtml(msg.avatar)}" style="width:100%;height:100%;border-radius:50%;">`
            : escHtml((msg.username || 'U')[0]);
        container.insertAdjacentHTML('beforeend', `
            <div class="msg-item ${isOwn ? 'own' : ''}">
                <div class="msg-avatar">${avatarHtml}</div>
                <div class="msg-body">
                    <div class="msg-meta">
                        <span class="msg-user">${escHtml(msg.username || 'Unbekannt')}</span>
                        <span class="msg-time">${time}</span>
                    </div>
                    <div class="msg-text">${escHtml(msg.text)}</div>
                </div>
            </div>
        `);
        container.scrollTop = container.scrollHeight;
    },

    // --- VOICE ---
    initPTTHandlers() {
        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() !== this.pttKey.toLowerCase()) return;
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
            if (this.isSpeaking) return;
            e.preventDefault();
            this.startPTT();
        });
        document.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === this.pttKey.toLowerCase()) this.stopPTT();
        });
    },

    startPTT() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc || this.isSpeaking) return;
        this.isSpeaking = true;
        this.renderActiveVoiceCard();
        if (this.pttSoundUrl) {
            const audio = new Audio(this.pttSoundUrl);
            audio.volume = this.pttVolume;
            audio.play().catch(() => { });
        }
        WebSocketService.socket?.emit('voice_speaking_state', { channelId: vc.id, isSpeaking: true });
        VoiceEngine.startCapture(vc.id, this.selectedMicId);
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.add('active');
        const st = document.getElementById('pttStatus');
        if (st) st.textContent = '🔊 SENDEN...';
        if (window.electronAPI?.updateOverlayState) {
            window.electronAPI.updateOverlayState({ type: 'voice_ptt', active: true, user: AuthService.getUser()?.username, channel: vc.name });
        }
    },

    stopPTT() {
        if (!this.isSpeaking) return;
        this.isSpeaking = false;
        this.renderActiveVoiceCard();
        const vc = MockData.voiceChannels.find(v => v.active);
        WebSocketService.socket?.emit('voice_speaking_state', { channelId: vc?.id, isSpeaking: false });
        VoiceEngine.stopCapture();
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.remove('active');
        const st = document.getElementById('pttStatus');
        if (st) st.textContent = vc ? 'Frequenz: #' + vc.name : 'Nicht verbunden';
        if (window.electronAPI?.updateOverlayState) {
            window.electronAPI.updateOverlayState({ type: 'voice_ptt', active: false });
        }
    },

    selectVoiceChannel(id) {
        MockData.voiceChannels.forEach(v => v.active = (v.id === id));
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        WebSocketService.socket?.emit('voice_channel_join', { channelId: id, user: AuthService.getUser() });
        const vc = MockData.voiceChannels.find(v => v.active);
        const st = document.getElementById('pttStatus');
        if (st && vc) st.textContent = 'Frequenz: #' + vc.name;
    },

    leaveVoiceChannel() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc) return;
        vc.active = false;
        WebSocketService.socket?.emit('voice_channel_leave', { channelId: vc.id });
        VoiceEngine.releaseStream(); // FIX: Stream freigeben beim Verlassen
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        const st = document.getElementById('pttStatus');
        if (st) st.textContent = 'Nicht verbunden';
    },

    // --- SETTINGS ---
    async initSettingsUI() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === 'audioinput');
            const select = document.getElementById('micSelect');
            if (select) {
                select.innerHTML = mics.map(m => `<option value="${m.deviceId}" ${m.deviceId === this.selectedMicId ? 'selected' : ''}>${escHtml(m.label || 'Mikrofon')}</option>`).join('');
            }
        } catch (e) { }
        const pttIn = document.getElementById('pttKeyInput');
        if (pttIn) pttIn.value = this.pttKey.toUpperCase();
        const volSl = document.querySelector('.volume-slider');
        if (volSl) volSl.value = this.pttVolume;
        const sndIn = document.getElementById('pttSoundInput');
        if (sndIn) sndIn.value = this.pttSoundUrl;
    },

    setMic(id) { this.selectedMicId = id; localStorage.setItem('selected_mic', id); },
    setVolume(v) { this.pttVolume = parseFloat(v); localStorage.setItem('ptt_volume', v); },
    setPTTKey(k) { if (k) { this.pttKey = k.toLowerCase(); localStorage.setItem('ptt_key', k.toLowerCase()); } },
    setPTTSound(url) { this.pttSoundUrl = url; localStorage.setItem('ptt_sound_url', url); },

    toggleMonitoring() {
        this.isMonitoring = !this.isMonitoring;
        const btn = document.getElementById('btnMonitor');
        if (btn) btn.innerHTML = `<span>🎧 Abhören: ${this.isMonitoring ? 'AN' : 'AUS'}</span>`;
        if (btn) btn.classList.toggle('active', this.isMonitoring);
        VoiceEngine.setMonitoring(this.isMonitoring);
    },

    // --- ROBLOX ---
    async startRobloxVerify() {
        this.showScreenPart('rblxStateDisconnected', false);
        this.showScreenPart('rblxStateVerifying', true);
        this.showScreenPart('rblxStep1', true);
        this.showScreenPart('rblxStep2', false);
    },

    async robloxStep1() {
        const input = document.getElementById('rblxUsernameInput');
        if (!input?.value) return;
        const res = await ApiService.post('/api/roblox/start-verify', {
            discordId: AuthService.getUser().discordId,
            robloxUsername: input.value
        });
        if (res?.success) {
            document.getElementById('rblxCodeBox').textContent = res.code;
            this.showScreenPart('rblxStep1', false);
            this.showScreenPart('rblxStep2', true);
        } else {
            NotificationService.show('Fehler', res?.error || 'Account nicht gefunden', 'error');
        }
    },

    async robloxStep2() {
        const btn = document.getElementById('rblxConfirmBtn');
        const txt = document.getElementById('rblxConfirmText');
        if (btn) btn.disabled = true;
        if (txt) txt.textContent = 'Prüfe...';
        const res = await ApiService.post('/api/roblox/confirm-verify', {
            discordId: AuthService.getUser().discordId
        });
        if (res?.success && res.profile) {
            this.finishRobloxVerify(res.profile);
        } else {
            NotificationService.show('Nicht gefunden', 'Code nicht in Bio gefunden. Warte ggf. 1-2 Min.', 'warn');
            if (btn) btn.disabled = false;
            if (txt) txt.textContent = 'Verifizieren';
        }
    },

    finishRobloxVerify(profile) {
        localStorage.setItem('rblx_profile', JSON.stringify(profile));
        this.loadRobloxState();
        NotificationService.show('Erfolg', 'Roblox erfolgreich verknüpft!', 'success');
    },

    disconnectRoblox() {
        localStorage.removeItem('rblx_profile');
        // FIX: "Trost" war ein Placeholder — geändert zu sinnvollem Titel
        this.loadRobloxState();
        NotificationService.show('Getrennt', 'Roblox Account wurde entkoppelt.', 'info');
        // FIX: Overlay verstecken wenn Roblox getrennt
        if (window.electronAPI?.hideRobloxOverlay) window.electronAPI.hideRobloxOverlay();
    },

    loadRobloxState() {
        const profile = JSON.parse(localStorage.getItem('rblx_profile') || 'null');
        if (profile) {
            this.showScreenPart('rblxStateDisconnected', false);
            this.showScreenPart('rblxStateVerifying', false);
            this.showScreenPart('rblxStateConnected', true);
            const safe = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            safe('rblxDisplayName', profile.displayName);
            safe('rblxUsername', '@' + profile.username);
            safe('rblxUserId', profile.userId);
            safe('rblxCreated', profile.created ? new Date(profile.created).toLocaleDateString('de-DE') : '—');
            safe('rblxConnectedAt', new Date().toLocaleDateString('de-DE'));
            const avatar = document.getElementById('rblxAvatar');
            if (avatar) avatar.src = profile.avatar || '';
            // FIX: Guard für electronAPI
            if (window.electronAPI?.showRobloxOverlay) {
                const user = AuthService.getUser();
                window.electronAPI.showRobloxOverlay(user.discordId, profile.userId, user.role === 'admin');
            }
        } else {
            this.showScreenPart('rblxStateDisconnected', true);
            this.showScreenPart('rblxStateVerifying', false);
            this.showScreenPart('rblxStateConnected', false);
        }
    },

    // FIX: Konsistente Methode — nur classList, kein style.display Mix
    showScreenPart(id, show) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !show);
    },

    // --- DATA & STATS ---
    async startStatsMonitor() {
        const update = async () => {
            const data = await ApiService.get('/api/status');
            if (!data) return;
            document.querySelectorAll('#liveMembers, #statMembersTotal').forEach(el => el.textContent = data.members?.toLocaleString() || '—');
            document.querySelectorAll('#liveOnline').forEach(el => el.textContent = data.onlineMembers || '0');
            document.querySelectorAll('#statDashboardUsers').forEach(el => el.textContent = data.dashboardOnline || '0');
            const conn = document.getElementById('statDiscordConnected');
            if (conn) conn.textContent = data.online ? 'Verbunden' : 'Nicht verbunden';
            const dls = document.getElementById('discordLinkStatus');
            if (dls) { dls.textContent = data.online ? 'Verbunden' : 'Getrennt'; dls.classList.toggle('online', !!data.online); }
        };
        update();
        setInterval(update, 20000);
    },

    // FIX: War loadLiveNews mit falschem Element-ID — jetzt korrekt announcementList
    async loadAnnouncements() {
        const container = document.getElementById('announcementList');
        if (!container) return;
        try {
            // FIX: Nutze CONFIG.API_URL statt veralteter Subdomain
            const res = await fetch(`${CONFIG.API_URL}/api/announcements`);
            const data = await res.json();
            if (!data.announcements?.length) {
                container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">Keine Ankündigungen.</div>';
                return;
            }
            container.innerHTML = data.announcements.map(n => `
                <div class="announcement-item">
                    <strong>${escHtml(n.title)}</strong>
                    <p>${escHtml(n.content)}</p>
                </div>
            `).join('');
        } catch (e) {
            container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">Ankündigungen nicht verfügbar.</div>';
        }
    },

    // FIX: Changelog laden — wurde nie aufgerufen
    async loadGithubChangelog() {
        const container = document.getElementById('changelogList');
        if (!container) return;
        try {
            const releases = await window.electronAPI?.getGithubChangelog?.()
                || await fetch('https://api.github.com/repos/princearmy2024/Emden-Network/releases?per_page=3').then(r => r.json()).catch(() => []);
            if (!releases?.length) {
                container.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">Kein Changelog verfügbar.</div>';
                return;
            }
            container.innerHTML = releases.map(r => `
                <div class="changelog-item">
                    <div class="cl-version">${escHtml(r.tag_name)}</div>
                    <div class="cl-date">${new Date(r.published_at).toLocaleDateString('de-DE')}</div>
                    <div class="cl-body">${escHtml((r.body || 'Keine Änderungsnotizen.').substring(0, 200))}</div>
                </div>
            `).join('');
        } catch (e) {
            container.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">Changelog nicht ladbar.</div>';
        }
    },

    startClock() {
        const tick = () => {
            const d = new Date();
            const clock = document.getElementById('ovClock');
            const dateEl = document.getElementById('ovDate');
            if (clock) clock.textContent = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
            if (dateEl) dateEl.textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
        };
        tick();
        setInterval(tick, 1000);
    },

    initBackgroundParallax() {
        document.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth - 0.5) * 15;
            const y = (e.clientY / window.innerHeight - 0.5) * 15;
            document.querySelectorAll('.splash-grid').forEach(g => g.style.transform = `translate(${x}px, ${y}px)`);
        });
    },

    showNotification(t, m, ty) { NotificationService.show(t, m, ty); },
    logout() { AuthService.logout(); location.reload(); },
    openRobloxProfile(e) {
        e.preventDefault();
        const profile = JSON.parse(localStorage.getItem('rblx_profile') || 'null');
        if (profile) window.open(`https://www.roblox.com/users/${profile.userId}/profile`, '_blank');
    },
    testRobloxOverlay() {
        const profile = JSON.parse(localStorage.getItem('rblx_profile') || 'null');
        if (profile && window.electronAPI?.showRobloxOverlay) {
            window.electronAPI.showRobloxOverlay(AuthService.getUser().discordId, profile.userId, true);
        }
    }
};

// =============================================================
// VOICE ENGINE
// =============================================================

const VoiceEngine = {
    mediaRecorder: null,
    stream: null,
    monitorNode: null,
    audioCtx: null,

    async startCapture(channelId, deviceId) {
        try {
            if (!this.stream) {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
                        echoCancellation: true,
                        noiseSuppression: true
                    }
                });
            }
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    WebSocketService.socket?.emit('voice_audio_relay', {
                        channelId,
                        audioBlob: e.data,
                        user: AuthService.getUser()
                    });
                }
            };
            this.mediaRecorder.start(250);
        } catch (e) {
            console.error('[VoiceEngine] Capture Error:', e);
            NotificationService.show('Mikrofon Fehler', 'Zugriff verweigert oder Gerät nicht gefunden.', 'error');
        }
    },

    stopCapture() {
        if (this.mediaRecorder?.state !== 'inactive') this.mediaRecorder?.stop();
    },

    // FIX: Stream freigeben — vorher nie released
    releaseStream() {
        this.stopCapture();
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
    },

    playIncoming(userId, blob) {
        try {
            const url = URL.createObjectURL(new Blob([blob], { type: 'audio/webm' }));
            const a = new Audio(url);
            a.volume = App.pttVolume;
            a.play().finally(() => URL.revokeObjectURL(url));
        } catch (e) {
            console.error('[VoiceEngine] Playback Error:', e);
        }
    },

    setMonitoring(active) {
        if (active) {
            if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (!this.stream) return;
            const source = this.audioCtx.createMediaStreamSource(this.stream);
            this.monitorNode = this.audioCtx.createGain();
            this.monitorNode.gain.value = 0.5;
            source.connect(this.monitorNode);
            this.monitorNode.connect(this.audioCtx.destination);
        } else {
            this.monitorNode?.disconnect();
            this.monitorNode = null;
        }
    }
};

// =============================================================
// WALKIE-TALKIE MODULE (v1.5.0)
// =============================================================

const WalkieTalkie = {
    channels: [],
    currentChannel: null,
    isPTTActive: false,
    pttLockedBy: null,

    init() {
        console.log('[WalkieTalkie] Initialisiere Funk-Module...');
        WebSocketService.socket?.emit('walkie_get_channels');
        this.setupSocketListeners();
    },

    setupSocketListeners() {
        const s = WebSocketService.socket;
        if (!s) return;

        s.on('walkie_channels', (list) => { this.channels = list; this.renderChannels(); });
        s.on('walkie_channel_created', (ch) => { this.channels.push(ch); this.renderChannels(); });
        s.on('walkie_channel_deleted', ({ channelId }) => {
            this.channels = this.channels.filter(ch => ch.id !== channelId);
            if (this.currentChannel?.id === channelId) this.leaveChannel();
            this.renderChannels();
        });
        
        s.on('walkie_user_joined', ({ channelId, user }) => {
            const ch = this.channels.find(c => c.id === channelId);
            if (ch) {
                if (!ch.members) ch.members = [];
                if (!ch.members.find(m => (m.id || m.discordId) === (user.id || user.discordId))) {
                    ch.members.push(user);
                    this.renderChannels();
                }
            }
        });

        s.on('walkie_user_left', ({ channelId, userId }) => {
            const ch = this.channels.find(c => c.id === channelId);
            if (ch && ch.members) {
                ch.members = ch.members.filter(m => (m.id || m.discordId) !== userId);
                this.renderChannels();
            }
        });

        s.on('walkie_ptt_start', ({ channelId, user }) => {
            if (this.currentChannel?.id === channelId) {
                this.pttLockedBy = user;
                this.updateUIStatus();
            }
        });

        s.on('walkie_ptt_stop', ({ channelId }) => {
            if (this.currentChannel?.id === channelId) {
                this.pttLockedBy = null;
                this.updateUIStatus();
            }
        });

        s.on('walkie_audio', ({ audioBlob, user }) => {
            if (this.currentChannel) {
                VoiceEngine.playIncoming(user.id || user.discordId, audioBlob);
            }
        });
    },

    renderChannels() {
        const container = document.getElementById('walkieChannelList');
        if (!container) return;
        
        container.innerHTML = `<div class="section-title">Funkkanäle (${this.channels.length})</div>` + 
        this.channels.map(ch => `
            <div class="voice-channel-item ${this.currentChannel?.id === ch.id ? 'active' : ''}" onclick="WalkieTalkie.joinChannel('${ch.id}')">
                <div class="vc-info">
                    <div class="vc-icon">${ch.isPrivate ? '🔒' : '🔊'}</div>
                    <div class="vc-name">#${escHtml(ch.name)}</div>
                </div>
                <div class="vc-members">
                    ${(ch.members || []).length > 0 ? `<div class="vc-member-avatar" style="font-size:10px; font-weight:700;">${ch.members.length}</div>` : ''}
                </div>
            </div>
        `).join('');
    },

    async joinChannel(id) {
        const ch = this.channels.find(c => c.id === id);
        if (!ch) return;
        if (this.currentChannel?.id === id) return;

        if (ch.isPrivate) {
            const pass = prompt('Bitte Passwort für #' + ch.name + ' eingeben:');
            if (!pass) return;
            const ok = await new Promise(resolve => {
                WebSocketService.socket.emit('walkie_check_password', { channelId: id, password: pass }, resolve);
            });
            if (!ok) return NotificationService.show('Fehler', 'Falsches Passwort!', 'error');
        }

        if (this.currentChannel) this.leaveChannel();
        this.currentChannel = ch;
        WebSocketService.socket.emit('walkie_join', { channelId: id, user: AuthService.getUser() });
        this.renderChannels();
        this.updateUIStatus();
        NotificationService.show('Funk verbunden', '#' + ch.name + ' beigetreten.', 'success');
    },

    leaveChannel() {
        if (!this.currentChannel) return;
        WebSocketService.socket.emit('walkie_leave', { channelId: this.currentChannel.id, user: AuthService.getUser() });
        this.currentChannel = null;
        this.pttLockedBy = null;
        this.renderChannels();
        this.updateUIStatus();
    },

    updateUIStatus() {
        const btn = document.getElementById('pttBtn');
        const status = document.getElementById('pttStatus');
        if (!btn || !status) return;

        if (this.pttLockedBy) {
            const user = AuthService.getUser();
            const isMe = (this.pttLockedBy.id === (user.id || user.discordId)) || (this.pttLockedBy.discordId === (user.id || user.discordId));
            btn.classList.toggle('locked', !isMe);
            status.innerHTML = isMe ? '<span style="color:var(--brand-blue)">🔊 DU FUNKST...</span>' : `<span style="color:var(--status-warn)">🚫 BELEGT: ${escHtml(this.pttLockedBy.username)}</span>`;
        } else {
            btn.classList.remove('locked');
            status.textContent = this.currentChannel ? `Empfang: #${this.currentChannel.name}` : 'Nicht verbunden';
        }
    },

    showCreateModal() { document.getElementById('walkieCreateModal').classList.remove('hidden'); },
    hideCreateModal() { document.getElementById('walkieCreateModal').classList.add('hidden'); },

    createChannel() {
        const name = document.getElementById('walkieNewName').value.trim();
        const isPrivate = document.getElementById('walkieNewPrivate').checked;
        const password = document.getElementById('walkieNewPass').value;

        if (!name) return NotificationService.show('Fehler', 'Bitte Namen angeben', 'error');
        WebSocketService.socket.emit('walkie_create_channel', { 
            name, isPrivate, password, owner: AuthService.getUser() 
        });
        this.hideCreateModal();
        document.getElementById('walkieNewName').value = '';
        document.getElementById('walkieNewPass').value = '';
    }
};

// =============================================================
// UTILS
// =============================================================

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

window.WalkieTalkie = WalkieTalkie;
document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;

