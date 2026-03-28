/**
 * EMDEN NETWORK DASHBOARD - renderer.js
 * Frontend-Logik (Renderer-Prozess)
 * 
 * Version: 1.3.8 (Stabilitäts- & Funktions-Update)
 */

'use strict';

window.CURRENT_VERSION = '1.3.8';

const CONFIG = {
    API_URL: 'http://91.98.124.212:5009',
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
                signal: AbortSignal.timeout(10000),
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
        } catch (e) {}
        return false;
    },
    logout() { this.session = null; localStorage.removeItem('en_session'); },
    getUser() { return this.session?.user || null; },
    isLoggedIn() { return !!this.session?.token; },
};

const ApiService = {
    async get(endpoint) {
        try {
            const res = await fetch(`${CONFIG.API_URL}${endpoint}`, { headers: { 'x-api-key': CONFIG.API_KEY } });
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
        if (!window.io) return;
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

        // Roblox Integration Real-time
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
        setTimeout(() => toast.remove(), 5000);
        if (window.electronAPI?.sendOverlayNotification) window.electronAPI.sendOverlayNotification({ title, message, type });
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
// MAIN APP OBJECT
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
        console.log('[App] Starte v1.3.8...');
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
    },

    initLoginHandlers() {
        const btnVerify = document.getElementById('btnVerify');
        const verifyInput = document.getElementById('verifyInput');
        const btnDiscord = document.getElementById('btnDiscord');

        if (btnVerify && verifyInput) {
            btnVerify.onclick = async () => {
                btnVerify.disabled = true;
                const res = await AuthService.verify(verifyInput.value);
                if (res.success) this.showDashboard(res.user);
                else {
                    NotificationService.show('Verifizierung fehlgeschlagen', res.error, 'error');
                    btnVerify.disabled = false;
                }
            };
        }
        if (btnDiscord) {
            btnDiscord.onclick = () => window.open('https://discord.com/channels/@me', '_blank');
        }
    },

    showDashboard(user) {
        this.applyUser(user);
        this.renderChannels();
        this.renderServers();
        this.showScreen('dashboardScreen');
        this.navigate('overview');
        WebSocketService.connect();
        this.startStatsMonitor();
        this.loadLiveNews();
        this.loadRobloxState();
    },

    applyUser(user) {
        if (!user) return;
        document.querySelectorAll('.username-field, #overviewUsername, #settingsUsername').forEach(el => el.textContent = user.username);
        const img = user.avatar ? `<img src="${user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : user.username[0].toUpperCase();
        document.querySelectorAll('.avatar-field, #sidebarAvatar, #topbarAvatar, #settingsAvatar').forEach(el => el.innerHTML = img);
        document.querySelectorAll('#settingsRole').forEach(el => el.textContent = user.role === 'admin' ? 'Administrator' : 'Benutzer');
        if (user.role === 'admin') document.querySelectorAll('.admin-only, #adminBadge').forEach(el => el.classList.remove('hidden'));
    },

    navigate(view) {
        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById('view-' + view);
        if (target) target.classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
        const breadcrumb = document.getElementById('topbarBreadcrumb');
        if (breadcrumb) breadcrumb.textContent = view.charAt(0).toUpperCase() + view.slice(1);
    },

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(id);
        if (target) target.classList.add('active');
    },

    // --- RENDERERS ---
    renderChannels() {
        const el = document.getElementById('channelList');
        if (!el) return;
        el.innerHTML = MockData.channels.map(ch => `
            <div class="channel-item" onclick="App.currentChat='${ch.name}'; App.navigate('messages'); document.getElementById('activeChatName').textContent='#${ch.name}'">
                <span>#</span> ${ch.name}
            </div>
        `).join('');
    },

    renderVoiceChannels() {
        const el = document.querySelector('.voice-channels');
        if (!el) return;
        el.innerHTML = '<div class="section-title">Sprachkanäle</div>' + MockData.voiceChannels.map(vc => `
            <div class="voice-channel-item ${vc.active ? 'active' : ''}" onclick="App.selectVoiceChannel('${vc.id}')">
                <div class="vc-info">
                    <div class="vc-icon">${vc.active ? '🔊' : '📻'}</div>
                    <div class="vc-name">#${vc.name}</div>
                </div>
                <div class="vc-members">
                    ${vc.members.map(m => `<div class="vc-member-avatar" title="${m.username}" style="background:var(--brand-blue)">${m.username[0]}</div>`).join('')}
                </div>
            </div>
        `).join('');
    },

    renderOnlineUsers(users) {
        const el = document.getElementById('chatOnlineUsersList');
        if (!el) return;
        const badge = document.getElementById('chatOnlineCountBadge');
        if (badge) badge.textContent = users.length;
        el.innerHTML = users.map(u => `
            <div class="online-user-item">
                <div class="user-avatar-small" style="background:#2b2d31;">
                    ${u.avatar ? `<img src="${u.avatar}" style="width:100%;height:100%;object-fit:cover;">` : u.username[0]}
                </div>
                <span>${u.username}</span>
                <div class="status-dot online"></div>
            </div>
        `).join('');
    },

    renderActiveVoiceCard() {
        const el = document.getElementById('activeVoiceContainer');
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!el) return;
        if (!vc) { el.innerHTML = ''; return; }
        
        el.innerHTML = `
            <div class="active-voice-card">
                <div class="avc-head">
                    <span>${vc.name}</span>
                    <button class="avc-leave" onclick="App.leaveVoiceChannel()">✕</button>
                </div>
                <div class="avc-participants">
                    <div class="avc-p-item ${this.isSpeaking ? 'speaking' : ''}">
                        <div class="p-avatar">Du</div>
                        <span class="p-name">Du</span>
                    </div>
                    ${vc.members.filter(m => m.discordId !== (AuthService.getUser()?.id || AuthService.getUser()?.discordId)).map(m => `
                        <div class="avc-p-item ${m.isSpeaking ? 'speaking' : ''}">
                            <div class="p-avatar" style="background:var(--brand-blue)">${m.username[0]}</div>
                            <span class="p-name">${m.username}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
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
        const html = `
            <div class="msg-item ${isOwn ? 'own' : ''}">
                <div class="msg-avatar">${msg.avatar ? `<img src="${msg.avatar}" style="width:100%;height:100%;border-radius:50%;">` : (msg.username || 'U')[0]}</div>
                <div class="msg-body">
                    <div class="msg-meta"><span class="msg-user">${escHtml(msg.username)}</span><span class="msg-time">${time}</span></div>
                    <div class="msg-text">${escHtml(msg.text)}</div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
        container.scrollTop = container.scrollHeight;
    },

    // --- VOICE / PTT ---
    initPTTHandlers() {
        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === this.pttKey.toLowerCase() && !this.isSpeaking) {
                if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
                e.preventDefault();
                this.startPTT();
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === this.pttKey.toLowerCase()) {
                this.stopPTT();
            }
        });
    },

    startPTT() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc || this.isSpeaking) return;
        
        this.isSpeaking = true;
        this.renderActiveVoiceCard();
        
        // Funk Sound
        if (this.pttSoundUrl) {
            const audio = new Audio(this.pttSoundUrl);
            audio.volume = this.pttVolume;
            audio.play().catch(() => {});
        }

        WebSocketService.socket?.emit('voice_speaking_state', { channelId: vc.id, isSpeaking: true });
        VoiceEngine.startCapture(vc.id, this.selectedMicId);
        
        // UI Updates
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.add('active');
        const st = document.getElementById('pttStatus');
        if (st) st.textContent = '🔊 SENDEN...';
        
        // Overlay Update
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

        // UI Updates
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.remove('active');
        const st = document.getElementById('pttStatus');
        if (st && vc) st.textContent = 'Frequenz: #' + vc.name;

        // Overlay Update
        if (window.electronAPI?.updateOverlayState) {
            window.electronAPI.updateOverlayState({ type: 'voice_ptt', active: false });
        }
    },

    selectVoiceChannel(id) {
        MockData.voiceChannels.forEach(v => v.active = (v.id === id));
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        WebSocketService.socket?.emit('voice_channel_join', { channelId: id, user: AuthService.getUser() });
        const st = document.getElementById('pttStatus');
        const name = MockData.voiceChannels.find(v => v.active)?.name;
        if (st) st.textContent = 'Frequenz: #' + name;
    },

    leaveVoiceChannel() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (vc) {
            vc.active = false;
            WebSocketService.socket?.emit('voice_channel_leave', { channelId: vc.id });
            this.renderVoiceChannels();
            this.renderActiveVoiceCard();
            const st = document.getElementById('pttStatus');
            if (st) st.textContent = 'Nicht verbunden';
        }
    },

    // --- SETTINGS ---
    async initSettingsUI() {
        // Mic Liste
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === 'audioinput');
            const select = document.getElementById('micSelect');
            if (select) {
                select.innerHTML = mics.map(m => `<option value="${m.deviceId}" ${m.deviceId === this.selectedMicId ? 'selected' : ''}>${m.label || 'Mikrofon'}</option>`).join('');
            }
        } catch (e) {}

        // Inputs füllen
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

    // --- ROBLOX CONNECT ---
    async startRobloxVerify() {
        this.showScreenPart('rblxStateDisconnected', false);
        this.showScreenPart('rblxStateVerifying', true);
        this.showScreenPart('rblxStep1', true);
        this.showScreenPart('rblxStep2', false);
    },

    async robloxStep1() {
        const input = document.getElementById('rblxUsernameInput');
        if (!input?.value) return;
        const res = await ApiService.post('/api/roblox/start-verify', { discordId: AuthService.getUser().discordId, robloxUsername: input.value });
        if (res && res.success) {
            document.getElementById('rblxCodeBox').textContent = res.code;
            this.showScreenPart('rblxStep1', false);
            this.showScreenPart('rblxStep2', true);
        } else {
            NotificationService.show('Fehler', res?.error || 'Account konnte nicht gefunden werden', 'error');
        }
    },

    async robloxStep2() {
        const btn = document.getElementById('rblxConfirmBtn');
        const txt = document.getElementById('rblxConfirmText');
        if (btn) btn.disabled = true;
        if (txt) txt.textContent = 'Prüfe...';
        
        const res = await ApiService.post('/api/roblox/confirm-verify', { discordId: AuthService.getUser().discordId });
        // Falls Callback via Socket kommt, passiert das automatisch. 
        // Falls API direkt antwortet:
        if (res && res.success && res.profile) {
            this.finishRobloxVerify(res.profile);
        } else {
            NotificationService.show('Nicht gefunden', 'Code wurde in der Bio nicht gefunden. Bitte warte ggf. 1-2 Minuten.', 'warn');
            if (btn) btn.disabled = false;
            if (txt) txt.textContent = 'Verifizieren';
        }
    },

    finishRobloxVerify(profile) {
        localStorage.setItem('rblx_profile', JSON.stringify(profile));
        this.loadRobloxState();
        NotificationService.show('Erfolg', 'Roblox Account erfolgreich verknüpft!', 'success');
    },

    disconnectRoblox() {
        localStorage.removeItem('rblx_profile');
        this.loadRobloxState();
        NotificationService.show('Verbindung getrennt', 'Roblox Account entkoppelt.', 'info');
    },

    loadRobloxState() {
        const profile = JSON.parse(localStorage.getItem('rblx_profile'));
        if (profile) {
            this.showScreenPart('rblxStateDisconnected', false);
            this.showScreenPart('rblxStateVerifying', false);
            this.showScreenPart('rblxStateConnected', true);
            
            document.getElementById('rblxDisplayName').textContent = profile.displayName;
            document.getElementById('rblxUsername').textContent = '@' + profile.username;
            document.getElementById('rblxUserId').textContent = profile.userId;
            document.getElementById('rblxCreated').textContent = profile.created ? new Date(profile.created).toLocaleDateString('de-DE') : '—';
            document.getElementById('rblxConnectedAt').textContent = new Date().toLocaleDateString('de-DE');
            
            const avatar = document.getElementById('rblxAvatar');
            if (avatar) avatar.src = profile.avatar || '';
            
            if (window.electronAPI?.showRobloxOverlay) {
                window.electronAPI.showRobloxOverlay(AuthService.getUser().discordId, profile.userId, AuthService.getUser().role === 'admin');
            }
        } else {
            this.showScreenPart('rblxStateDisconnected', true);
            this.showScreenPart('rblxStateVerifying', false);
            this.showScreenPart('rblxStateConnected', false);
        }
    },

    showScreenPart(id, show) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !show);
        if (el && show && (id === 'rblxStep1' || id === 'rblxStep2')) el.style.display = 'block';
        else if (el && !show && (id === 'rblxStep1' || id === 'rblxStep2')) el.style.display = 'none';
    },

    // --- DATA MONITORing ---
    async startStatsMonitor() {
        const update = async () => {
            const data = await ApiService.get('/api/status');
            if (data) {
                document.querySelectorAll('#liveMembers, #statMembersTotal').forEach(el => el.textContent = data.members?.toLocaleString() || '—');
                document.querySelectorAll('#liveOnline').forEach(el => el.textContent = data.onlineMembers || '0');
                document.querySelectorAll('#statDashboardUsers').forEach(el => el.textContent = data.dashboardOnline || '0');
                const conn = document.getElementById('statDiscordConnected');
                if (conn) conn.textContent = data.online ? 'Verbunden' : 'Offline';
                const dls = document.getElementById('discordLinkStatus');
                if (dls) {
                    dls.textContent = data.online ? 'Verbunden' : 'Getrennt';
                    dls.classList.toggle('online', data.online);
                }
            }
        };
        update();
        setInterval(update, 20000);
    },

    async loadLiveNews() {
        const container = document.getElementById('newsList');
        if (!container) return;
        try {
            const res = await fetch('https://enrp.princearmy.de/announcements.json');
            const data = await res.json();
            container.innerHTML = (data.announcements || []).map(n => `<div class="news-card"><strong>${n.title}</strong><p>${n.content}</p></div>`).join('');
        } catch (e) { container.innerHTML = '<div class="news-card">Keine News verfügbar.</div>'; }
    },

    startClock() {
        setInterval(() => {
            const d = new Date();
            const clock = document.getElementById('ovClock');
            const dateEl = document.getElementById('ovDate');
            if (clock) clock.textContent = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
            if (dateEl) dateEl.textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
        }, 1000);
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
        const profile = JSON.parse(localStorage.getItem('rblx_profile'));
        if (profile) window.open(`https://www.roblox.com/users/${profile.userId}/profile`, '_blank');
    },
    testRobloxOverlay() {
        const profile = JSON.parse(localStorage.getItem('rblx_profile'));
        if (profile && window.electronAPI?.showRobloxOverlay) {
            window.electronAPI.showRobloxOverlay(AuthService.getUser().discordId, profile.userId, true);
        }
    }
};

// =============================================================
// AUDIO ENGINE
// =============================================================

const VoiceEngine = {
    mediaRecorder: null,
    stream: null,
    monitorNode: null,
    audioCtx: null,

    async startCapture(channelId, deviceId) {
        try {
            if (!this.stream) {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true } });
            }
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) WebSocketService.socket?.emit('voice_audio_relay', { channelId, audioBlob: e.data, user: AuthService.getUser() });
            };
            this.mediaRecorder.start(250);
        } catch (e) { console.error('[VoiceEngine] Capture Error:', e); }
    },
    stopCapture() { if (this.mediaRecorder?.state !== 'inactive') this.mediaRecorder?.stop(); },
    
    playIncoming(userId, blob) {
        const url = URL.createObjectURL(new Blob([blob], { type: 'audio/webm' }));
        const a = new Audio(url);
        a.volume = App.pttVolume;
        a.play().finally(() => URL.revokeObjectURL(url));
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

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;