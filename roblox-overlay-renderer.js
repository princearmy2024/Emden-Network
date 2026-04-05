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

        // Panels sofort sichtbar — NUR für Admins
        setTimeout(() => {
            if (isAdmin) {
                document.body.classList.add('overlay-active');
                document.body.classList.add('is-admin');
            }
            setGameRunning(true);
        }, 300);

        // Click outside Mod Panel → Focus zurück ans Spiel
        document.addEventListener('mousedown', (e) => {
            if (!modSlideOpen) return;
            const panel = document.getElementById('mod-slide');
            if (panel && !panel.contains(e.target) && !e.target.closest('#mod-trigger')) {
                toggleModSlide();
            }
        });

        // Mod Trigger Button — Focus anfordern bei Hover (sonst click-through!)
        const modTrigger = document.getElementById('mod-trigger');
        if (modTrigger) {
            modTrigger.addEventListener('mouseenter', () => {
                if (window.electronAPI?.overlayRequestFocus) window.electronAPI.overlayRequestFocus(true);
                else if (window.electronAPI?.requestOverlayFocus) window.electronAPI.requestOverlayFocus(true);
            });
            modTrigger.addEventListener('mouseleave', () => {
                if (!modSlideOpen) {
                    if (window.electronAPI?.overlayRequestFocus) window.electronAPI.overlayRequestFocus(false);
                    else if (window.electronAPI?.requestOverlayFocus) window.electronAPI.requestOverlayFocus(false);
                }
            });
        }

        // Mod Bar: User-Info setzen
        try {
            const session = JSON.parse(localStorage.getItem('en_session') || 'null');
            if (session?.user) {
                const barName = document.getElementById('modBarName');
                const barAv = document.getElementById('modBarAv');
                if (barName) barName.textContent = session.user.username || 'Moderator';
                if (barAv && session.user.avatar) barAv.innerHTML = '<img src="' + session.user.avatar + '">';
            }
        } catch(_) {}

        startClock();
        connectSocket();
        setupKeys();
        startRandomTips();
        initOverlayPTT();

        if (typeof lucide !== 'undefined') lucide.createIcons();

        // Mod-Hint für Admins anzeigen
        if (isAdmin) {
            const hint = document.getElementById('mod-hint');
            if (hint) hint.style.display = 'flex';
        }

        // Mod-Panel interaktive Elemente (legacy, nicht mehr genutzt)
        if (isAdmin && false) {
            const toggle = document.getElementById('mod-toggle');
            if (toggle) {
                toggle.classList.add('visible');
                // Gespeicherte Position laden
                try {
                    const saved = JSON.parse(localStorage.getItem('mod_toggle_pos'));
                    if (saved) { toggle.style.left = saved.x + 'px'; toggle.style.top = saved.y + 'px'; }
                } catch(e) {}

                // Hover über interaktive Elemente → Maus-Events aktivieren
                let isDragging = false, dragStartX, dragStartY, startLeft, startTop, moved = false;

                toggle.addEventListener('mouseenter', () => {
                    if (!modPanelVisible && window.electronAPI?.requestOverlayFocus) {
                        window.electronAPI.requestOverlayFocus(true);
                    }
                });
                toggle.addEventListener('mouseleave', () => {
                    if (!modPanelVisible && !isDragging && window.electronAPI?.requestOverlayFocus) {
                        window.electronAPI.requestOverlayFocus(false);
                    }
                });

                // Draggable
                toggle.addEventListener('mousedown', (e) => {
                    isDragging = true; moved = false;
                    dragStartX = e.clientX; dragStartY = e.clientY;
                    startLeft = toggle.offsetLeft; startTop = toggle.offsetTop;
                    toggle.style.transition = 'none'; toggle.style.zIndex = '999';
                    e.preventDefault();
                });
                document.addEventListener('mousemove', (e) => {
                    if (!isDragging) return;
                    const dx = e.clientX - dragStartX, dy = e.clientY - dragStartY;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
                    toggle.style.left = (startLeft + dx) + 'px';
                    toggle.style.top = (startTop + dy) + 'px';
                });
                document.addEventListener('mouseup', () => {
                    if (!isDragging) return;
                    isDragging = false;
                    toggle.style.transition = ''; toggle.style.zIndex = '';
                    localStorage.setItem('mod_toggle_pos', JSON.stringify({ x: toggle.offsetLeft, y: toggle.offsetTop }));
                    if (!moved) Overlay.toggleModPanel();
                });
            }

            // Info-Bar Hover → auch klickbar machen
            document.querySelectorAll('.info-card').forEach(card => {
                card.addEventListener('mouseenter', () => {
                    if (window.electronAPI?.requestOverlayFocus) window.electronAPI.requestOverlayFocus(true);
                });
                card.addEventListener('mouseleave', () => {
                    if (!modPanelVisible && window.electronAPI?.requestOverlayFocus) window.electronAPI.requestOverlayFocus(false);
                });
            });
        }

        if (window.electronAPI?.onToggleRobloxCmd) {
            window.electronAPI.onToggleRobloxCmd(() => toggleCmd());
        }

        // F4: Overlay komplett an/aus (Panels + alles)
        if (window.electronAPI?.onToggleModPanel) {
            window.electronAPI.onToggleModPanel(() => {
                toggleOverlayVisibility();
            });
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
    let overlayHidden = false;

    function toggleOverlayVisibility() {
        overlayHidden = !overlayHidden;
        if (overlayHidden) {
            // Alles verstecken
            document.body.classList.remove('overlay-active');
            if (modSlideOpen) toggleModSlide();
        } else {
            // Alles wieder zeigen
            if (isAdmin) document.body.classList.add('overlay-active');
        }
    }

    function setGameRunning(running, startTime = null) {
        isGameRunning = running;
        if (running) {
            setTimeout(() => {
                if (!overlayHidden) {
                    document.body.classList.add('overlay-active');
                }
                document.getElementById('info-bar').classList.add('visible');
            }, 100);
            startPlaytime(startTime);
        } else {
            document.body.classList.remove('overlay-active');
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

    // ─── MOD SLIDE PANEL ────────────────────────────────────
    const API_URL = 'http://91.98.124.212:5009';
    const API_KEY = 'emden-super-secret-key-2026';
    let modSlideOpen = false;
    let modSelectedUser = null;
    let modSelectedAction = null;
    let modSearchTimer = null;

    function requestFocus(on) {
        if (window.electronAPI?.overlayRequestFocus) window.electronAPI.overlayRequestFocus(on);
        else if (window.electronAPI?.requestOverlayFocus) window.electronAPI.requestOverlayFocus(on);
    }

    function toggleModSlide() {
        modSlideOpen = !modSlideOpen;
        const panel = document.getElementById('mod-slide');
        if (!panel) return;
        panel.classList.toggle('open', modSlideOpen);
        document.body.classList.toggle('mod-open', modSlideOpen);

        requestFocus(modSlideOpen);
        if (modSlideOpen) {
            setTimeout(() => document.getElementById('modSearchInput')?.focus(), 350);
        }
    }

    // Legacy compat
    function toggleModPanel() { toggleModSlide(); }

    async function searchModUser(query) {
        clearTimeout(modSearchTimer);
        const results = document.getElementById('modResults');
        if (!query || query.length < 2) {
            results.innerHTML = '<div class="mod-res-empty">Username eingeben</div>';
            results.classList.remove('show');
            return;
        }
        results.innerHTML = '<div class="mod-res-empty">Suche...</div>';
        results.classList.add('show');

        modSearchTimer = setTimeout(async () => {
            try {
                const r = await fetch('https://users.roblox.com/v1/usernames/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usernames: [query], excludeBannedUsers: false })
                });
                const data = await r.json();
                if (!data.data?.length) {
                    results.innerHTML = '<div class="mod-res-empty">Nicht gefunden</div>';
                    return;
                }

                const u = data.data[0];
                let avatar = '', created = '', displayName = u.displayName || u.name;
                try {
                    const [pRes, aRes] = await Promise.all([
                        fetch('https://users.roblox.com/v1/users/' + u.id),
                        fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + u.id + '&size=150x150&format=Png&isCircular=false')
                    ]);
                    const pData = await pRes.json();
                    const aData = await aRes.json();
                    avatar = aData.data?.[0]?.imageUrl || '';
                    displayName = pData.displayName || displayName;
                    created = pData.created ? new Date(pData.created).toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'}) : '';
                } catch(e) {}

                results.innerHTML = `<div class="mod-usr" onclick="Overlay.selectModUser(${u.id}, '${esc(u.name)}', '${esc(displayName)}', '${esc(avatar)}', '${esc(created)}')">
                    <div class="mod-usr-av">${avatar ? '<img src="'+avatar+'">' : esc((u.name[0]||'?').toUpperCase())}</div>
                    <div><div class="mod-usr-name">${esc(displayName)}</div><div class="mod-usr-id">@${esc(u.name)} · ${u.id}${created ? ' · '+created : ''}</div></div></div>`;
            } catch(e) {
                results.innerHTML = '<div class="mod-res-empty" style="color:#ff6b6b">Fehler</div>';
            }
        }, 400);
    }

    async function selectModUser(id, username, displayName, avatar, created) {
        modSelectedUser = { id, username, displayName, avatar, created };
        // Dropdown schliessen
        const results = document.getElementById('modResults');
        results.classList.remove('show');
        document.getElementById('modSearchInput').value = '';

        // Selected-Leiste
        const sel = document.getElementById('modSelectedUser');
        if (sel) {
            sel.innerHTML = `<span>${esc(displayName)} (@${esc(username)}) · ${id}</span><button class="mod-sel-x" onclick="Overlay.clearModUser(event)">&times;</button>`;
            sel.classList.add('show');
        }

        // Profile anzeigen
        document.getElementById('modProfileEmpty').style.display = 'none';
        const content = document.getElementById('modProfileContent');
        content.style.display = 'flex';

        // Name + ID
        document.getElementById('modProfileName').textContent = displayName;
        document.getElementById('modProfileId').textContent = '@' + username + ' · ' + id;
        document.getElementById('modProfileCreated').textContent = created ? 'Erstellt: ' + created : '';

        // Full-Body Avatar laden
        const avatarEl = document.getElementById('modAvatarFull');
        avatarEl.innerHTML = '<div class="mod-res-empty">Lade...</div>';
        try {
            const avRes = await fetch('https://thumbnails.roblox.com/v1/users/avatar?userIds=' + id + '&size=352x352&format=Png&isCircular=false');
            const avData = await avRes.json();
            const fullBody = avData.data?.[0]?.imageUrl;
            if (fullBody) {
                avatarEl.innerHTML = '<img src="' + fullBody + '" />';
            } else {
                avatarEl.innerHTML = avatar ? '<img src="' + avatar + '" />' : '';
            }
        } catch(e) {
            avatarEl.innerHTML = avatar ? '<img src="' + avatar + '" />' : '';
        }

        // Discord-Lookup
        const discordInfo = document.getElementById('modDiscordInfo');
        discordInfo.style.display = 'none';
        try {
            const lookupRes = await fetch(API_URL + '/api/roblox/lookup?robloxId=' + id, {
                headers: { 'x-api-key': API_KEY }
            });
            const lookupData = await lookupRes.json();
            if (lookupData.linked && lookupData.discordUsername) {
                document.getElementById('modDiscordName').textContent = lookupData.discordUsername;

                // Rollen
                const rolesEl = document.getElementById('modDiscordRoles');
                rolesEl.innerHTML = (lookupData.roles || []).map(r =>
                    `<span class="mod-discord-role" style="color:${r.color};border-color:${r.color}33">${esc(r.name)}</span>`
                ).join('');

                // Status
                const statusMap = { online: '🟢 Online', idle: '🌙 Abwesend', dnd: '⛔ Nicht stören', offline: '⚫ Offline' };
                document.getElementById('modDiscordStatus').textContent =
                    lookupData.inServer ? (statusMap[lookupData.status] || 'Offline') : 'Nicht im Server';

                discordInfo.style.display = 'flex';
            }
        } catch(e) {}

        updateModSendBtn();
    }

    function clearModUser(e) {
        e?.stopPropagation();
        modSelectedUser = null;
        modSelectedAction = null;
        document.querySelectorAll('.mod-act').forEach(a => a.classList.remove('on'));
        const sel = document.getElementById('modSelectedUser');
        if (sel) { sel.classList.remove('show'); sel.innerHTML = ''; }
        // Profile zurücksetzen
        document.getElementById('modProfileEmpty').style.display = 'flex';
        document.getElementById('modProfileContent').style.display = 'none';
        document.getElementById('modDiscordInfo').style.display = 'none';
        updateModSendBtn();
    }

    function pickModAction(type, el) {
        modSelectedAction = type;
        document.querySelectorAll('.mod-act').forEach(a => a.classList.remove('on'));
        el.classList.add('on');
        updateModSendBtn();
    }

    function updateModSendBtn() {
        const btn = document.getElementById('modSendBtn');
        if (btn) btn.disabled = !(modSelectedUser && modSelectedAction);
    }

    async function sendModAction() {
        if (!modSelectedUser || !modSelectedAction) return;
        const reason = document.getElementById('modReasonInput')?.value?.trim() || 'Kein Grund';
        const user = modSelectedUser;
        const moderator = voiceUsername || 'Unbekannt';

        document.getElementById('modSendBtn').disabled = true;

        try {
            const res = await fetch(API_URL + '/api/mod-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
                body: JSON.stringify({
                    userId: user.id, username: user.username,
                    displayName: user.displayName, avatar: user.avatar,
                    created: user.created || '', reason,
                    action: modSelectedAction, moderator,
                    moderatorAvatar: voiceAvatar || ''
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Fehler');
            showModMsg('✓ ' + modSelectedAction + ' gesendet', 'ok');
            document.getElementById('modReasonInput').value = '';
            modSelectedAction = null;
            document.querySelectorAll('.mod-act').forEach(a => a.classList.remove('on'));
        } catch(e) {
            showModMsg('✗ Fehler beim Senden', 'err');
        }
        updateModSendBtn();
    }

    function showModMsg(text, type) {
        const m = document.getElementById('modMsg');
        if (m) { m.textContent = text; m.className = 'mod-msg ' + type; setTimeout(() => { m.textContent = ''; m.className = 'mod-msg'; }, 3000); }
    }

    return { init, toggleCmd, toggleModSlide, toggleModPanel, searchModUser, selectModUser, clearModUser, pickModAction, sendModAction };
})();

window.addEventListener('DOMContentLoaded', () => Overlay.init());
