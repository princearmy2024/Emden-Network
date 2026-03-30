/**
 * EMDEN NETWORK ROBLOX OVERLAY — roblox-overlay-renderer.js
 * Läuft im transparenten Electron-Overlay-Fenster
 */

'use strict';

// CONFIG
const OVL_CONFIG = {
    API_URL: 'http://localhost:5009',
    EMDEN_PLACE_ID: 12716055617,
    ON_DUTY_ROLE_ID: 'PLACEHOLDER_ON_DUTY_ROLE_ID',
};

const Overlay = (() => {
    let socket         = null;
    let discordId      = '';
    let robloxId       = '';
    let isAdmin        = false;
    let cmdVisible     = false;
    let playtimeStart  = null;
    let playtimeTimer  = null;
    let bigAnnTimeout  = null;

    // ─── VOICE STATE ────────────────────────────────────────────
    let voiceChannelId    = 'vc-1';
    let voiceUsername     = 'User';
    let voiceDiscordId    = '';
    let voiceAvatar       = '';
    let voiceMimeType     = 'audio/webm;codecs=opus';
    let isPTTHeld         = false;   // V-Taste gedrückt?
    let isActuallySending = false;   // Wir senden gerade aktiv?
    let micStream         = null;
    let mediaRecorder     = null;
    let keepaliveInterval = null;
    let activeSpeakers    = {};      // { username: timestamp }

    // VAD (Voice Activity Detection) — Audio-Level-Check
    let vadContext    = null;
    let vadAnalyser   = null;
    let vadBuffer     = null;
    let vadInterval   = null;
    const VAD_THRESHOLD = 8; // 0–255, je höher desto strenger

    // ─── INIT ───────────────────────────────────────────────────
    function init() {
        const p    = new URLSearchParams(window.location.search);
        discordId  = p.get('discordId') || '';
        robloxId   = p.get('robloxId')  || '';
        isAdmin    = p.get('admin') === '1';
        voiceDiscordId = discordId;

        // User-Info aus dem Dashboard localStorage lesen
        try {
            const session = JSON.parse(localStorage.getItem('en_session') || 'null');
            if (session?.user) {
                voiceUsername = session.user.username || 'User';
                voiceAvatar   = session.user.avatar   || '';
            }
        } catch(_) {}

        document.body.style.opacity   = '1';
        document.body.style.transition = 'opacity 0.8s ease';

        startClock();
        connectSocket();
        setupKeys();
        startRandomTips();
        initOverlayPTT();

        if (typeof lucide !== 'undefined') lucide.createIcons();

        if (window.electronAPI?.onToggleRobloxCmd) {
            window.electronAPI.onToggleRobloxCmd(() => toggleCmd());
        }

        // Voice PTT State vom Dashboard (Sync wenn beide Fenster offen)
        if (window.electronAPI?.onUpdateOverlayState) {
            window.electronAPI.onUpdateOverlayState((state) => {
                if (state.type === 'voice_ptt') {
                    showSpeakingIndicator(state.active, state.user || 'User', state.channel || 'Funk', true, voiceAvatar);
                }
            });
        }
    }

    // ─── PTT IM OVERLAY ─────────────────────────────────────────
    function initOverlayPTT() {
        if (!window.electronAPI) return;

        // V-Taste gedrückt (globaler Shortcut aus main.js)
        window.electronAPI.onOverlayPTTStart(() => {
            if (!isPTTHeld) {
                isPTTHeld = true;
                openMic();
            }
        });

        // V-Taste losgelassen (via Keepalive-Timeout aus main.js)
        window.electronAPI.onOverlayPTTStop(() => {
            isPTTHeld = false;
            closeMic();
        });
    }

    // Mikrofon öffnen + VAD starten
    async function openMic() {
        if (micStream) return;

        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 16000,
                }
            });
        } catch(e) {
            console.error('[Overlay PTT] Mikrofon-Fehler:', e.message);
            micStream = null;
            return;
        }

        // VAD: AnalyserNode messen ob Sprache vorhanden
        vadContext  = new (window.AudioContext || window.webkitAudioContext)();
        const src   = vadContext.createMediaStreamSource(micStream);
        vadAnalyser = vadContext.createAnalyser();
        vadAnalyser.fftSize = 512;
        vadBuffer   = new Uint8Array(vadAnalyser.frequencyBinCount);
        src.connect(vadAnalyser);

        // Alle 80ms Audio-Level prüfen
        vadInterval = setInterval(() => {
            if (!isPTTHeld) return;

            vadAnalyser.getByteFrequencyData(vadBuffer);
            const avg = vadBuffer.reduce((a, b) => a + b, 0) / vadBuffer.length;

            if (avg > VAD_THRESHOLD) {
                // Sprache erkannt → falls noch nicht am senden, anfangen
                if (!isActuallySending) startSending();
            } else {
                // Stille → falls am senden, stoppen
                if (isActuallySending) pauseSending();
            }
        }, 80);

        console.log('[Overlay PTT] 🎙 Kanal offen, warte auf Sprache...');
    }

    // Mikrofon schließen + alles aufräumen
    function closeMic() {
        clearInterval(vadInterval);
        vadInterval = null;

        stopSending(); // MediaRecorder stoppen falls aktiv

        if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
        }
        if (vadContext) {
            vadContext.close().catch(() => {});
            vadContext  = null;
            vadAnalyser = null;
            vadBuffer   = null;
        }

        isPTTHeld      = false;
        isActuallySending = false;

        window.electronAPI?.pttStop();
        console.log('[Overlay PTT] 🔕 Kanal geschlossen.');
    }

    // MediaRecorder starten wenn Sprache erkannt
    function startSending() {
        if (isActuallySending || !micStream) return;
        isActuallySending = true;

        voiceMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus' : 'audio/webm';

        mediaRecorder = new MediaRecorder(micStream, {
            mimeType: voiceMimeType,
            audioBitsPerSecond: 32000,
        });

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0 && socket?.connected) {
                const reader = new FileReader();
                reader.onloadend = () => {
                    socket.emit('voice_audio_chunk', {
                        channelId: voiceChannelId,
                        username:  voiceUsername,
                        discordId: voiceDiscordId,
                        avatar:    voiceAvatar,
                        mimeType:  voiceMimeType,
                        data:      reader.result.split(',')[1],
                    });
                };
                reader.readAsDataURL(e.data);
            }
            // Keepalive für main.js damit er weiß V ist noch gedrückt
            window.electronAPI?.pttKeepalive();
        };

        mediaRecorder.start(150);

        // PTT-Start an Channel senden
        if (socket?.connected) {
            socket.emit('voice_ptt_start', {
                channelId: voiceChannelId,
                username:  voiceUsername,
                discordId: voiceDiscordId,
                avatar:    voiceAvatar,
            });
        }

        showSpeakingIndicator(true, voiceUsername, voiceChannelId, true, voiceAvatar);

        // Keepalive-Intervall
        keepaliveInterval = setInterval(() => {
            window.electronAPI?.pttKeepalive();
        }, 100);

        console.log('[Overlay PTT] 🔴 Sprache erkannt — sende...');
    }

    // MediaRecorder pausieren wenn Stille
    function pauseSending() {
        if (!isActuallySending) return;
        isActuallySending = false;

        clearInterval(keepaliveInterval);
        keepaliveInterval = null;

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            mediaRecorder = null;
        }

        // PTT-Stop an Channel senden (kurze Stille = Pause)
        if (socket?.connected) {
            socket.emit('voice_ptt_stop', {
                channelId: voiceChannelId,
                username:  voiceUsername,
                discordId: voiceDiscordId,
            });
        }

        showSpeakingIndicator(false, voiceUsername, voiceChannelId, true);
        console.log('[Overlay PTT] ⏸ Stille erkannt — pausiert.');
    }

    // Wenn V losgelassen: Alles sauber stoppen
    function stopSending() {
        isActuallySending = false;

        clearInterval(keepaliveInterval);
        keepaliveInterval = null;

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            mediaRecorder = null;
        }

        if (socket?.connected) {
            socket.emit('voice_ptt_stop', {
                channelId: voiceChannelId,
                username:  voiceUsername,
                discordId: voiceDiscordId,
            });
        }

        showSpeakingIndicator(false, voiceUsername, voiceChannelId, true);
    }

    // ─── EINGEHENDE AUDIO CHUNKS ABSPIELEN ──────────────────────
    function playIncomingAudio(base64data, mimeType) {
        try {
            const binary = atob(base64data);
            const bytes  = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioCtx();
            ctx.decodeAudioData(bytes.buffer, (decoded) => {
                const src  = ctx.createBufferSource();
                const gain = ctx.createGain();
                gain.gain.value = 1.5;
                src.buffer = decoded;
                src.connect(gain);
                gain.connect(ctx.destination);
                src.start(0);
                src.onended = () => ctx.close();
            }, () => ctx.close());
        } catch(_) {}
    }

    // ─── SPEAKING INDICATOR UI ──────────────────────────────────
    function showSpeakingIndicator(active, username, channel, isSelf = false, avatarUrl = "") {
        const area   = document.getElementById('voice-status-area');
        const nameEl = document.getElementById('voice-username');
        const chanEl = document.getElementById('voice-channel-name');
        const card   = document.querySelector('.voice-status-card');
        const avatarCont = document.getElementById('voice-avatar-container');
        if (!area) return;

        if (active) {
            if (nameEl) nameEl.textContent = username;
            if (chanEl) chanEl.textContent = '#' + channel;
            
            // Set Color 🔴 (Senden) vs 🟢 (Empfangen)
            const speakingColor = isSelf ? '#ef4444' : '#10b981';
            
            if (card) {
                card.style.borderLeftColor = speakingColor;
            }
            if (avatarCont) {
                avatarCont.style.borderColor = speakingColor;
                avatarCont.style.setProperty('--ring-color', speakingColor);
                avatarCont.style.animation = 'speak-ring-pulse 1.5s infinite cubic-bezier(0.16, 1, 0.3, 1)';
                
                let micIconHtml = `<div class="voice-icon"><i data-lucide="mic"></i></div>`;
                if (avatarUrl) {
                    avatarCont.innerHTML = `<img src="${avatarUrl}" />` + micIconHtml;
                } else {
                    avatarCont.innerHTML = `<span style="color:#fff;font-weight:700;font-size:16px;">${username[0].toUpperCase()}</span>` + micIconHtml;
                }
                if (window.lucide) lucide.createIcons();
            }
            
            area.classList.add('visible');
        } else {
            const others = Object.keys(activeSpeakers).filter(u => u !== username);
            if (others.length === 0) {
                area.classList.remove('visible');
            } else {
                const nextUser = others[0];
                if (nameEl) nameEl.textContent = nextUser;
                const speakingColor = '#10b981';
                
                if (card) card.style.borderLeftColor = speakingColor;
                if (avatarCont) {
                    avatarCont.style.borderColor = speakingColor;
                    avatarCont.style.setProperty('--ring-color', speakingColor);
                    
                    // We don't have the avatar of other active speakers cached directly here easily, 
                    // so we revert to initials for the fallback overlay
                    let micIconHtml = `<div class="voice-icon"><i data-lucide="mic"></i></div>`;
                    avatarCont.innerHTML = `<span style="color:#fff;font-weight:700;font-size:16px;">${nextUser[0].toUpperCase()}</span>` + micIconHtml;
                    if (window.lucide) lucide.createIcons();
                }
            }
        }
    }

    // ─── OVERLAY VISIBILITY ─────────────────────────────────────
    let isGameRunning = false;
    function setGameRunning(running, startTime = null) {
        isGameRunning = running;
        if (running) {
            setTimeout(() => document.getElementById('info-bar').classList.add('visible'), 100);
            startPlaytime(startTime);
        } else {
            document.getElementById('info-bar').classList.remove('visible');
            stopPlaytime();
        }
    }

    // ─── CLOCK ──────────────────────────────────────────────────
    function startClock() {
        const tick = () => {
            const d  = new Date();
            const hh = String(d.getHours()).padStart(2,'0');
            const mm = String(d.getMinutes()).padStart(2,'0');
            document.getElementById('clock').textContent = `${hh}:${mm} Uhr`;
        };
        tick();
        setInterval(tick, 15000);
    }

    // ─── PLAYTIME ───────────────────────────────────────────────
    function startPlaytime(startTime) {
        playtimeStart = startTime || Date.now();
        if (playtimeTimer) clearInterval(playtimeTimer);
        playtimeTimer = setInterval(tickPlaytime, 1000);
        tickPlaytime();
    }

    function tickPlaytime() {
        const s  = Math.floor((Date.now() - playtimeStart) / 1000);
        const hh = String(Math.floor(s / 3600)).padStart(2,'0');
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2,'0');
        const ss = String(s % 60).padStart(2,'0');
        document.getElementById('playtime').textContent = `${hh}:${mm}:${ss}`;
    }

    function stopPlaytime() {
        if (playtimeTimer) clearInterval(playtimeTimer);
        document.getElementById('playtime').textContent = '00:00:00';
    }

    // ─── SUPPORTER COUNT ────────────────────────────────────────
    function setSupporter(count) {
        document.getElementById('supporter-count').textContent = `Supporter: ${count}`;
    }

    // ─── SMALL NOTIFICATIONS ────────────────────────────────────
    const MAX_NOTIFS = 3;

    function notify({ title, text, type = 'announce', duration = 7000 }) {
        const area    = document.getElementById('notif-area');
        const current = area.querySelectorAll('.notif-card:not(.out)');
        if (current.length >= MAX_NOTIFS) dismiss(current[current.length - 1]);

        const icons   = { ticket: 'ticket', admin: 'shield', announce: 'megaphone' };
        const icoName = icons[type] || 'megaphone';
        const time    = new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});

        const el = document.createElement('div');
        el.className = `notif-card ${type}`;
        el.innerHTML = `
            <span class="notif-ico"><i data-lucide="${icoName}"></i></span>
            <div>
                <div class="notif-title">${esc(title)}</div>
                <div class="notif-text">${esc(text)}</div>
                <div class="notif-time">${time}</div>
            </div>`;
        area.insertBefore(el, area.firstChild);
        if (typeof lucide !== 'undefined') lucide.createIcons();
        setTimeout(() => dismiss(el), duration);
    }

    function dismiss(el) {
        if (!el || el.classList.contains('out')) return;
        el.classList.add('out');
        setTimeout(() => el.remove(), 320);
    }

    // ─── BIG ANNOUNCEMENT ───────────────────────────────────────
    function bigAnnounce({ title, text, duration = 8000 }) {
        document.getElementById('big-ann-title').textContent = title;
        document.getElementById('big-ann-text').textContent  = text;
        document.getElementById('big-ann').classList.add('visible');
        if (bigAnnTimeout) clearTimeout(bigAnnTimeout);
        bigAnnTimeout = setTimeout(() =>
            document.getElementById('big-ann').classList.remove('visible'), duration);
        notify({ title, text, type: 'announce', duration: 5000 });
    }

    // ─── RANDOM TIPS ──────────────────────────────────────────
    const TIPS = [
        { title: 'Discord Announcement', text: 'Neues Event startet heute Abend! Schau im Kanal vorbei.' },
        { title: 'Team-Suche', text: 'Bewirb dich jetzt im Discord für das Taxi-Team.' },
        { title: 'Social Media', text: 'Willst du coole Events sehen? Dann schau auf dem Discord vorbei.' },
        { title: 'Support', text: 'Probleme im Spiel? Eröffne ein Ticket auf unserem Discord.' }
    ];

    function startRandomTips() {
        setInterval(() => {
            if (!isGameRunning) return;
            const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
            notify(tip);
        }, 1000 * 60 * 8);
    }

    // ─── F3 COMMAND BAR ─────────────────────────────────────────
    function toggleCmd() {
        if (!isAdmin) return;
        cmdVisible = !cmdVisible;
        document.getElementById('cmd-bar').classList.toggle('visible', cmdVisible);
        if (window.electronAPI?.overlayRequestFocus) {
            window.electronAPI.overlayRequestFocus(cmdVisible);
        }
        if (cmdVisible)
            setTimeout(() => document.getElementById('cmd-input').focus(), 360);
    }

    function setupKeys() {
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && cmdVisible) toggleCmd();
            if (e.key === 'Enter'  && cmdVisible) execCmd();

            // F4 = Debug: Spiel-Erkennung simulieren
            if (e.key === 'F4') {
                e.preventDefault();
                setGameRunning(!isGameRunning);
            }
        });
    }

    function execCmd() {
        const val = document.getElementById('cmd-input').value.trim();
        if (!val) return;
        console.log('[CMD]', val);
        document.getElementById('cmd-input').value = '';
        toggleCmd();
    }

    // ─── SOCKET.IO ──────────────────────────────────────────────
    function connectSocket() {
        socket = io(OVL_CONFIG.API_URL, {
            transports: ['websocket', 'polling'],
            reconnectionAttempts: 10,
            reconnectionDelay: 3000,
        });

        socket.on('connect', () => {
            console.log('[Overlay] Socket verbunden');
            if (discordId) socket.emit('overlay_client_connect', { discordId, robloxId, isAdmin });

            // Voice Channel beitreten
            socket.emit('voice_channel_join', {
                channelId: voiceChannelId,
                username:  voiceUsername,
                discordId: voiceDiscordId,
            });
        });

        socket.on('overlay_supporter_count', ({ count }) => setSupporter(count));

        socket.on(`overlay_game_start_${discordId}`, ({ startTime }) => setGameRunning(true, startTime));
        socket.on(`overlay_game_end_${discordId}`,   ()               => setGameRunning(false));

        if (window.electronAPI) {
            socket.on('overlay_game_start_test', (data) => setGameRunning(true, data.startTime));
        }

        notify({ title: 'Emden Network', text: 'Overlay aktiv & bereit.', type: 'info' });

        socket.on('overlay_notification',               handleNotif);
        socket.on(`overlay_notification_${discordId}`, handleNotif);
        socket.on('overlay_big_announcement', bigAnnounce);

        socket.on('overlay_new_ticket', ({ ticketId, reason }) => {
            if (!isAdmin) return;
            notify({ title: `Neues Ticket #${ticketId}`, text: reason || 'Kein Grund angegeben', type: 'ticket', duration: 15000 });
        });

        // ── VOICE EVENTS ──────────────────────────────────────
        socket.on('voice_ptt_start', (data) => {
            if (data.username === voiceUsername) return;
            activeSpeakers[data.username] = Date.now();
            showSpeakingIndicator(true, data.username, data.channelId, false, data.avatar || '');
        });

        socket.on('voice_ptt_stop', (data) => {
            if (data.username === voiceUsername) return;
            delete activeSpeakers[data.username];
            showSpeakingIndicator(false, data.username, data.channelId, false);
        });

        socket.on('voice_audio_chunk', (data) => {
            if (data.username === voiceUsername) return;
            playIncomingAudio(data.data, data.mimeType);
        });
    }

    function handleNotif(data) {
        if (data.adminOnly && !isAdmin) return;
        notify(data);
    }

    // ─── UTILS ──────────────────────────────────────────────────
    function esc(s) {
        return String(s)
            .replace(/&/g,'&amp;')
            .replace(/</g,'&lt;')
            .replace(/>/g,'&gt;');
    }

    return { init, toggleCmd };
})();

window.addEventListener('DOMContentLoaded', () => Overlay.init());
