/**
 * EMDEN NETWORK DASHBOARD - renderer.js
 * Frontend-Logik (Renderer-Prozess)
 * 
 * Version: 1.3.7 (Discord System & UI Restoration)
 */

'use strict';

window.CURRENT_VERSION = '1.3.7';

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
            return res.json();
        } catch (e) { return null; }
    },
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
            if (data.user?.discordId !== (user?.id || user?.discordId)) {
                VoiceEngine.playIncoming(data.user?.discordId, data.audioBlob);
            }
        });
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
        setTimeout(() => toast.remove(), 4500);
        if (window.electronAPI?.sendOverlayNotification) window.electronAPI.sendOverlayNotification({ title, message, type });
    }
};

const MockData = {
    servers: [
        { id: 1, name: 'Main Node', status: 'online', ip: '91.98.124.212' },
        { id: 2, name: 'Backup Node', status: 'online', ip: '91.98.124.213' }
    ],
    channels: [{ id: 1, name: 'general' }, { id: 2, name: 'support' }],
    voiceChannels: [
        { id: 'vc-1', name: 'general', members: [], active: true },
        { id: 'vc-2', name: 'ops-room', members: [], active: false }
    ]
};

// =============================================================
// APP LOGIC
// =============================================================

const App = {
    currentView: 'overview',
    currentChat: 'general',
    isSpeaking: false,
    pttKey: localStorage.getItem('ptt_key') || 'v',

    async init() {
        console.log('[App] Initialisiere v1.3.7...');
        this.initBackgroundParallax();
        this.startClock();
        this.initPTTHandlers();
        
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
                const res = await AuthService.verify(verifyInput.value);
                if (res.success) this.showDashboard(res.user);
                else NotificationService.show('Fehler', res.error, 'error');
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
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        this.showScreen('dashboardScreen');
        this.navigate('overview');
        WebSocketService.connect();
        this.startStatsMonitor();
        this.loadLiveNews();
        this.loadRobloxState();
    },

    applyUser(user) {
        if (!user) return;
        document.querySelectorAll('.username-field, #overviewUsername').forEach(el => el.textContent = user.username);
        const img = user.avatar ? `<img src="${user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : user.username[0].toUpperCase();
        document.querySelectorAll('.avatar-field, #sidebarAvatar, #topbarAvatar').forEach(el => el.innerHTML = img);
        if (user.role === 'admin') document.querySelectorAll('.admin-only, #adminBadge').forEach(el => el.classList.remove('hidden'));
    },

    navigate(view) {
        this.currentView = view;
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        document.getElementById('view-' + view)?.classList.add('active');
        document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
        const breadcrumb = document.getElementById('topbarBreadcrumb');
        if (breadcrumb) breadcrumb.textContent = view.charAt(0).toUpperCase() + view.slice(1);
    },

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id)?.classList.add('active');
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
                    ${vc.members.map(m => `<div class="vc-member-avatar" title="${m.username}">${m.username[0]}</div>`).join('')}
                </div>
            </div>
        `).join('');
    },

    renderOnlineUsers(users) {
        const el = document.getElementById('chatOnlineUsersList');
        const badge = document.getElementById('chatOnlineCountBadge');
        if (!el) return;
        if (badge) badge.textContent = users.length;
        el.innerHTML = users.map(u => `
            <div class="online-user-item" style="display:flex; align-items:center; gap:10px; padding:6px; border-radius:8px; cursor:pointer;">
                <div style="width:32px; height:32px; border-radius:50%; background:var(--brand-blue); overflow:hidden;">
                    ${u.avatar ? `<img src="${u.avatar}" style="width:100%; height:100%; object-fit:cover;">` : u.username[0]}
                </div>
                <div style="font-size:13px; font-weight:500;">${u.username}</div>
                <div style="width:8px; height:8px; border-radius:50%; background:var(--status-online); margin-left:auto;"></div>
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
                    ${vc.members.map(m => `<div class="avc-p-item ${m.isSpeaking ? 'speaking' : ''}">${m.username}</div>`).join('')}
                </div>
            </div>
        `;
    },

    // --- CHAT ---
    sendMessage() {
        const input = document.getElementById('chatInput');
        if (!input?.value.trim()) return;
        const msg = {
            username: AuthService.getUser()?.username,
            avatar: AuthService.getUser()?.avatar,
            text: input.value.trim(),
            userId: AuthService.getUser()?.id || AuthService.getUser()?.discordId,
            to: this.currentChat
        };
        this.appendChatMessage(msg);
        WebSocketService.socket?.emit('send_message', msg);
        input.value = '';
    },

    appendChatMessage(msg) {
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const isOwn = msg.userId === (AuthService.getUser()?.id || AuthService.getUser()?.discordId);
        const html = `
            <div class="msg-item ${isOwn ? 'own' : ''}">
                <div class="msg-avatar">${msg.avatar ? `<img src="${msg.avatar}" style="width:100%; height:100%; border-radius:50%;">` : (msg.username || 'U')[0]}</div>
                <div class="msg-body">
                    <div class="msg-meta"><span class="msg-user">${escHtml(msg.username)}</span></div>
                    <div class="msg-text">${escHtml(msg.text)}</div>
                </div>
            </div>
        `;
        container.insertAdjacentHTML('beforeend', html);
        container.scrollTop = container.scrollHeight;
    },

    // --- VOICE ---
    initPTTHandlers() {
        document.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === this.pttKey && !this.isSpeaking) {
                if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
                this.startPTT();
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.key.toLowerCase() === this.pttKey) this.stopPTT();
        });
    },

    startPTT() {
        const vc = MockData.voiceChannels.find(v => v.active);
        if (!vc || this.isSpeaking) return;
        this.isSpeaking = true;
        this.renderActiveVoiceCard();
        WebSocketService.socket?.emit('voice_speaking_state', { channelId: vc.id, isSpeaking: true });
        VoiceEngine.startCapture(vc.id);
        const btn = document.getElementById('pttBtn');
        if (btn) btn.classList.add('active');
        const st = document.getElementById('pttStatus');
        if (st) st.textContent = '🔊 SENDEN...';
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
        if (st && vc) st.textContent = 'Frequenz: #' + vc.name;
    },

    selectVoiceChannel(id) {
        MockData.voiceChannels.forEach(v => v.active = (v.id === id));
        this.renderVoiceChannels();
        this.renderActiveVoiceCard();
        WebSocketService.socket?.emit('voice_channel_join', { channelId: id, user: AuthService.getUser() });
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

    // --- DATA & STATS ---
    async startStatsMonitor() {
        const update = async () => {
            const data = await ApiService.get('/api/status');
            if (data) {
                document.querySelectorAll('#liveMembers, #statMembersTotal').forEach(el => el.textContent = data.members?.toLocaleString() || '—');
                document.querySelectorAll('#liveOnline').forEach(el => el.textContent = data.onlineMembers || '0');
                document.querySelectorAll('#statDashboardUsers').forEach(el => el.textContent = data.dashboardOnline || '0');
                const conn = document.getElementById('statDiscordConnected');
                if (conn) conn.textContent = data.online ? 'Verbunden' : 'Gestreift';
            }
        };
        update();
        setInterval(update, 30000);
    },

    async loadLiveNews() {
        const container = document.getElementById('newsList');
        if (!container) return;
        try {
            const res = await fetch('https://enrp.princearmy.de/announcements.json');
            const data = await res.json();
            container.innerHTML = (data.announcements || []).map(n => `<div class="news-card"><strong>${n.title}</strong><p>${n.content}</p></div>`).join('');
        } catch (e) { container.innerHTML = '<div class="news-card">Keine Neuigkeiten verfügbar.</div>'; }
    },

    loadRobloxState() {
        const profile = JSON.parse(localStorage.getItem('rblx_profile'));
        if (profile && window.electronAPI?.showRobloxOverlay) {
            window.electronAPI.showRobloxOverlay(AuthService.getUser().discordId, profile.userId, AuthService.getUser().role === 'admin');
        }
    },

    renderServers() {
        const grid = document.getElementById('serverGrid');
        if (!grid) return;
        grid.innerHTML = MockData.servers.map(s => `<div class="server-card online"><strong>${s.name}</strong><br>${s.ip}</div>`).join('');
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
            if (!this.stream) this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
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
        new Audio(url).play().finally(() => URL.revokeObjectURL(url));
    }
};

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;