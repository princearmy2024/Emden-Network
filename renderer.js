/**
 * EMDEN NETWORK DASHBOARD - renderer.js
 * Frontend-Logik (Renderer-Prozess)
 * 
 * Version: 1.3.5 (Fix renderChannels & init error)
 */

'use strict';

window.CURRENT_VERSION = '1.3.5';

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
                signal: AbortSignal.timeout(8000),
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
            return res.json();
        } catch (e) { return null; }
    },
    async post(endpoint, body) {
        try {
            const res = await fetch(`${CONFIG.API_URL}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.API_KEY },
                body: JSON.stringify(body)
            });
            return res.json();
        } catch (e) { return null; }
    },
};

const UserRegistry = {
    get() { try { return JSON.parse(localStorage.getItem('en_members') || '{}'); } catch (e) { return {}; } },
    update(users) {
        const registry = this.get();
        users.forEach(u => {
            const id = u.discordId || u.id || u.username;
            if (id) registry[id] = { ...u, discordId: id, lastSeen: Date.now() };
        });
        localStorage.setItem('en_members', JSON.stringify(registry));
    }
};

const WebSocketService = {
    socket: null,
    connect() {
        if (!window.io) return;
        this.socket = window.io(CONFIG.API_URL);
        
        this.socket.on('connect', () => {
            const user = AuthService.getUser();
            if (user) this.socket.emit('client_online', { discordId: user.discordId, username: user.username, role: user.role });
        });

        this.socket.on('receive_message', (msg) => App.appendChatMessage(msg));
        this.socket.on('voice_state_update', (channels) => {
            MockData.voiceChannels = channels;
            App.renderVoiceChannels();
            App.renderActiveVoiceCard();
        });

        this.socket.on('voice_audio_relay', (data) => {
            const user = AuthService.getUser();
            if (data.user?.discordId !== user?.discordId) {
                VoiceEngine.playIncoming(data.user?.discordId, data.audioBlob);
            }
        });
        
        setInterval(() => {
            const user = AuthService.getUser();
            if (user && this.socket?.connected) this.socket.emit('client_online', { discordId: user.discordId, username: user.username });
        }, 20000);
    }
};

const NotificationService = {
    show(title, message, type = 'info') {
        if (document.getElementById('toggleSound')?.checked !== false) this.playSmoothSound(type);
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `<div><strong>${escHtml(title)}</strong><br>${escHtml(message)}</div>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
        if (window.electronAPI?.sendOverlayNotification) window.electronAPI.sendOverlayNotification({ title, message, type });
    },
    playSmoothSound(type) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.setValueAtTime(type === 'error' ? 220 : 880, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(); osc.stop(ctx.currentTime + 0.5);
        } catch (e) {}
    }
};

const MockData = {
    servers: [
        { id: 1, name: 'Main Node', status: 'online', ip: '91.98.124.212', ping: 12, uptime: '99.9%' },
        { id: 2, name: 'Backup Node', status: 'online', ip: '91.98.124.213', ping: 25, uptime: '99.8%' }
    ],
    channels: [{ id: 1, name: 'general', desc: 'Haupt-Chat', members: 5 }],
    voiceChannels: [
        { id: 'vc-1', name: 'general', type: 'public', active: true, members: [], owner: 'Admin' },
        { id: 'vc-2', name: 'staff', type: 'private', active: false, members: [], owner: 'Admin', password: '123' }
    ]
};

// =============================================================
// MAIN APP OBJECT
// =============================================================

const App = {
    currentView: 'overview',
    currentChat: 'general',
    messages: [],
    isSpeaking: false,
    pttKey: localStorage.getItem('ptt_key') || 'v',
    pttVolume: parseFloat(localStorage.getItem('ptt_volume') || '0.5'),
    selectedMicId: localStorage.getItem('selected_mic') || 'default',
    _staticLoop: null,

    async init() {
        console.log('[App] Starting v1.3.5...');
        this.initBackgroundParallax();
        this.startClock();
        this.initPTTHandlers();
        
        if (AuthService.loadSession() && AuthService.isLoggedIn()) {
            this.showDashboard(AuthService.getUser());
        } else {
            this.showScreen('loginScreen');
            this.initLoginHandlers();
        }
        
        if (window.electronAPI) {
            window.electronAPI.onUpdateDownloaded(() => {
                const btn = document.getElementById('updateBtn');
                if (btn) btn.style.display = 'block';
                NotificationService.show('Update bereit!', 'Bitte neu starten.', 'success');
            });
        }
    },

    initLoginHandlers() {
        const btn = document.getElementById('loginBtn');
        const input = document.getElementById('loginInput');
        if (btn && input) {
            btn.onclick = async () => {
                const res = await AuthService.verify(input.value);
                if (res.success) this.showDashboard(res.user);
                else NotificationService.show('Fehler', res.error, 'error');
            };
        }
    },

    showDashboard(user) {
        this.applyUser(user);
        this.renderChannels();
        this.renderServers();
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        this.showScreen('dashboardScreen');
        this.navigate('overview');
        WebSocketService.connect();
        this.loadLiveNews();
        this.loadRobloxState();
    },

    applyUser(user) {
        if (!user) return;
        document.querySelectorAll('.username-field').forEach(el => el.textContent = user.username);
        const img = user.avatar ? `<img src="${user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : user.username[0].toUpperCase();
        document.querySelectorAll('.avatar-field').forEach(el => el.innerHTML = img);
    },

    navigate(view) {
        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + view)?.classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
    },

    renderChannels() {
        const el = document.getElementById('channelList');
        if (!el) return;
        el.innerHTML = MockData.channels.map(ch => `<div class="channel-item" onclick="App.currentChat='${ch.name}'; App.navigate('messages')"><span>#</span> ${ch.name}</div>`).join('');
    },

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id)?.classList.add('active');
    },

    // --- CHAT ---
    sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input?.value.trim()) return;
        const msg = {
            id: Date.now(),
            username: AuthService.getUser()?.username,
            avatar: AuthService.getUser()?.avatar,
            text: input.value.trim(),
            userId: AuthService.getUser()?.discordId,
            to: this.currentChat
        };
        this.appendChatMessage(msg);
        WebSocketService.socket?.emit('send_message', msg);
        input.value = '';
    },

    appendChatMessage(msg) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const isOwn = msg.userId === AuthService.getUser()?.discordId;
        const html = `
            <div class="msg-item ${isOwn ? 'own' : ''}">
                <div class="msg-avatar">${msg.avatar ? `<img src="${msg.avatar}" style="width:100%;height:100%;border-radius:50%;">` : (msg.username || 'U')[0]}</div>
                <div class="msg-body">
                    <div class="msg-meta"><span>${escHtml(msg.username)}</span></div>
                    <div class="msg-text">${escHtml(msg.text)}</div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
        container.scrollTop = container.scrollHeight;
    },

    // --- VOICE / PTT ---
    async initPTTHandlers() {
        this._staticLoop = new Audio('https://www.soundjay.com/communication/radio-static-1.mp3');
        this._staticLoop.loop = true;
        this._staticLoop.volume = this.pttVolume * 0.1;

        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === this.pttKey && !this.isSpeaking) {
                if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
                this.startPTT();
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === this.pttKey) this.stopPTT();
        });

        if (window.electronAPI?.onGlobalPTT) {
            window.electronAPI.onGlobalPTT((active) => {
                if (active) this.isSpeaking ? this.stopPTT() : this.startPTT();
            });
        }
    },

    startPTT() {
        if (this.isSpeaking) return;
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc) return;
        this.isSpeaking = true;
        this._staticLoop?.play().catch(() => {});
        this.renderActiveVoiceCard();
        
        WebSocketService.socket?.emit('voice_speaking_state', { channelId: vc.id, isSpeaking: true });
        VoiceEngine.startCapture(vc.id);
        
        window.electronAPI?.updateOverlayState?.({ type: 'voice_ptt', active: true, user: AuthService.getUser()?.username, channel: vc.name });
        
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.add('active');
        const st = document.getElementById('pttStatus');
        if (st) st.textContent = '🔊 SENDEN...';
    },

    stopPTT() {
        if (!this.isSpeaking) return;
        this.isSpeaking = false;
        this._staticLoop?.pause();
        this._staticLoop.currentTime = 0;
        this.renderActiveVoiceCard();

        const vc = MockData.voiceChannels.find(v => v.active);
        WebSocketService.socket?.emit('voice_speaking_state', { channelId: vc?.id, isSpeaking: false });
        VoiceEngine.stopCapture();

        window.electronAPI?.updateOverlayState?.({ type: 'voice_ptt', active: false });
        
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.remove('active');
        const st = document.getElementById('pttStatus');
        if (st && vc) st.textContent = 'Frequenz: #' + vc.name;
    },

    selectVoiceChannel(id) {
        const vc = MockData.voiceChannels.find(v => v.id === id);
        if (vc?.type === 'private') {
            const p = prompt('Passwort:');
            if (p !== vc.password) return;
        }
        MockData.voiceChannels.forEach(v => v.active = (v.id === id));
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        WebSocketService.socket?.emit('voice_channel_join', { channelId: id });
    },

    leaveVoiceChannel() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (vc) {
            vc.active = false;
            WebSocketService.socket?.emit('voice_channel_leave', { channelId: vc.id });
            this.renderVoiceChannels();
            this.renderActiveVoiceCard();
        }
    },

    renderVoiceChannels() {
        const el = document.querySelector('.voice-channels');
        if (!el) return;
        el.innerHTML = MockData.voiceChannels.map(vc => `
            <div class="voice-channel-item ${vc.active ? 'active' : ''}" onclick="App.selectVoiceChannel('${vc.id}')">
                <span>${vc.active ? '🔊' : '📻'} #${vc.name}</span>
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
                <div class="avc-head"><span>#${vc.name}</span> <button onclick="App.leaveVoiceChannel()">X</button></div>
                <div class="avc-participants">
                    <div class="avc-p-item ${this.isSpeaking ? 'speaking' : ''}"><span>Du</span></div>
                    ${vc.members.filter(m => m !== 'Du').map(m => `<div class="avc-p-item ${m.isSpeaking ? 'speaking' : ''}">${m.username}</div>`).join('')}
                </div>
            </div>
        `;
    },

    // --- MISC ---
    startClock() {
        setInterval(() => {
            const d = new Date();
            const el = document.getElementById('ovClock');
            if (el) el.textContent = d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
        }, 1000);
    },

    initBackgroundParallax() {
        document.addEventListener('mousemove', (e) => {
            const x = (e.clientX / window.innerWidth - 0.5) * 15;
            const y = (e.clientY / window.innerHeight - 0.5) * 15;
            document.querySelectorAll('.splash-grid').forEach(g => g.style.transform = `translate(${x}px, ${y}px)`);
        });
    },

    async loadLiveNews() {
        const container = document.getElementById('newsList');
        if (!container) return;
        try {
            const res = await fetch('https://enrp.princearmy.de/announcements.json');
            const data = await res.json();
            container.innerHTML = (data.announcements || []).map(n => `<div class="news-card"><strong>${n.title}</strong><p>${n.content}</p></div>`).join('');
        } catch (e) { container.innerHTML = 'Fehler beim Laden.'; }
    },

    renderServers() {
        const grid = document.getElementById('serverGrid');
        if (!grid) return;
        grid.innerHTML = MockData.servers.map(s => `<div class="server-card ${s.status}"><strong>${s.name}</strong><br>${s.ip}</div>`).join('');
    },

    loadRobloxState() {
        const profile = JSON.parse(localStorage.getItem('rblx_profile'));
        if (profile) {
            document.getElementById('rblxStateConnected')?.classList.remove('hidden');
            document.getElementById('rblxStateDisconnected')?.classList.add('hidden');
            if (window.electronAPI?.showRobloxOverlay) window.electronAPI.showRobloxOverlay(AuthService.getUser().discordId, profile.userId, AuthService.getUser().role === 'admin');
        }
    },

    logout() { AuthService.logout(); location.reload(); }
};

// =============================================================
// AUDIO ENGINE
// =============================================================

const VoiceEngine = {
    mediaRecorder: null,
    stream: null,
    async startCapture(channelId) {
        try {
            if (!this.stream) this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) WebSocketService.socket?.emit('voice_audio_relay', { channelId, audioBlob: e.data, user: AuthService.getUser() });
            };
            this.mediaRecorder.start(250);
        } catch (e) { console.error(e); }
    },
    stopCapture() { if (this.mediaRecorder?.state !== 'inactive') this.mediaRecorder?.stop(); },
    playIncoming(userId, blob) {
        const url = URL.createObjectURL(new Blob([blob], { type: 'audio/webm' }));
        new Audio(url).play().finally(() => URL.revokeObjectURL(url));
    }
};

// =============================================================
// BOOT
// =============================================================

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

document.addEventListener('DOMContentLoaded', () => App.init());

// Global exposed methods
window.App = App;
window.AuthService = AuthService;
window.NotificationService = NotificationService;