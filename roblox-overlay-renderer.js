/**
 * EMDEN NETWORK ROBLOX OVERLAY — roblox-overlay-renderer.js
 * Läuft im transparenten Electron-Overlay-Fenster
 */

'use strict';

// CONFIG
const OVL_CONFIG = {
    API_URL: 'http://91.98.124.212:5009',
    EMDEN_PLACE_ID: 12716055617,
    ON_DUTY_ROLE_ID: 'PLACEHOLDER_ON_DUTY_ROLE_ID',
};

const Overlay = (() => {
    let socket         = null;
    let discordId      = '';
    let robloxId       = '';
    let robloxUsername  = ''; // Wird beim Init von API geholt
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
        const isStaff = p.get('staff') === '1';
        // Admins gelten als Staff (Tickets/Support/etc) — sonst gated overlay-Funktionen
        window._isStaff = isStaff || isAdmin;
        window._isAdmin = isAdmin;
        voiceDiscordId = discordId;

        // User-Info aus dem Dashboard localStorage lesen
        try {
            const session = JSON.parse(localStorage.getItem('en_session') || 'null');
            if (session?.user) {
                voiceUsername = session.user.username || 'User';
                voiceAvatar   = session.user.avatar   || '';
            }
        } catch(_) {}

        // Roblox Username von API holen (fuer Panic-Teleport)
        if (robloxId) {
            fetch(`https://users.roblox.com/v1/users/${robloxId}`)
                .then(r => r.json())
                .then(data => {
                    if (data.name) {
                        robloxUsername = data.name;
                        console.log(`[Overlay] Roblox Username: ${robloxUsername}`);
                    }
                })
                .catch(() => {});
        }

        document.body.style.opacity   = '1';
        document.body.style.transition = 'opacity 0.8s ease';

        // Performance Mode aus Dashboard-Settings uebernehmen
        if (localStorage.getItem('perf_mode') === 'true') {
            document.body.classList.add('perf-mode');
            document.body.style.transition = 'none';
        }

        // Start: GAR NICHTS — kein Intro, kein Watermark, kein Overlay
        if (isAdmin) document.body.classList.add('is-admin');
        if (isStaff || isAdmin) document.body.classList.add('is-staff');
        setGameRunning(true);

        // Gespeicherte Settings laden
        loadSettings();

        // Click outside Mod Panel → schließen (wenn nicht gepinnt)
        document.addEventListener('mousedown', (e) => {
            if (!modSlideOpen) return;
            const panel = document.getElementById('mod-slide');
            const isOutside = panel && !panel.contains(e.target) && !e.target.closest('#mod-trigger');
            if (!isOutside) return;

            if (!modPinned) {
                toggleModSlide();
            }
            // Wenn gepinnt: nichts tun — Hover-System regelt den Focus
        });

        // Hover-System für gepinntes Panel: Focus nur wenn Maus drüber
        let modFocusTimer = null;
        const modSlideEl = document.getElementById('mod-slide');
        if (modSlideEl) {
            modSlideEl.addEventListener('mouseenter', () => {
                if (modSlideOpen) {
                    clearTimeout(modFocusTimer);
                    modFocusTimer = null;
                    requestFocus(true);
                }
            });
            modSlideEl.addEventListener('mouseleave', () => {
                if (modSlideOpen && modPinned) {
                    // Delay bevor Focus abgegeben wird — verhindert Flicker
                    // beim Wechsel zwischen Elementen im Panel
                    clearTimeout(modFocusTimer);
                    modFocusTimer = setTimeout(() => {
                        if (modPinned && modSlideOpen) requestFocus(false);
                        modFocusTimer = null;
                    }, 300);
                }
            });
            modSlideEl.addEventListener('wheel', (e) => {
                if (modSlideOpen) e.stopPropagation();
            }, { passive: true });
        }

        // Shift Buttons — Hover Focus
        const shiftSection = document.getElementById('panelShift');
        if (shiftSection) {
            shiftSection.addEventListener('mouseenter', () => requestFocus(true));
            shiftSection.addEventListener('mouseleave', () => { if (!settingsOpen && !modSlideOpen) requestFocus(false); });
        }

        // Panic Button — Hover Focus
        const panicBtn = document.getElementById('panicBtn');
        if (panicBtn) {
            panicBtn.addEventListener('mouseenter', () => requestFocus(true));
            panicBtn.addEventListener('mouseleave', () => { if (!settingsOpen && !modSlideOpen) requestFocus(false); });
        }

        // Settings Button — Hover Focus
        const settingsBtn = document.querySelector('.panel-settings-btn');
        if (settingsBtn) {
            settingsBtn.addEventListener('mouseenter', () => requestFocus(true));
            settingsBtn.addEventListener('mouseleave', () => { if (!settingsOpen && !modSlideOpen) requestFocus(false); });
        }

        // Settings Panel — gleicher Hover-Focus
        const settingsEl = document.getElementById('settings-panel');
        if (settingsEl) {
            settingsEl.addEventListener('mouseenter', () => { if (settingsOpen) requestFocus(true); });
            settingsEl.addEventListener('mouseleave', () => { if (settingsOpen && !modSlideOpen) requestFocus(false); });
        }

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

        // Teleport: Command wurde in Zwischenablage kopiert
        if (window.electronAPI?.onTeleportClipboard) {
            window.electronAPI.onTeleportClipboard((data) => {
                notify({
                    title: `TP: ${data.username}`,
                    text: `"${data.command}" kopiert — Drueck "-" dann Strg+V und Enter`,
                    type: 'admin',
                    duration: 12000,
                });
            });
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
    let overlayHidden = true;
    let introPlayed = false;

    function toggleOverlayVisibility() {
        const isActive = document.body.classList.contains('overlay-active');
        if (isActive) {
            document.body.classList.remove('overlay-active');
            document.body.classList.add('watermark-visible');
            if (modSlideOpen) toggleModSlide();
            overlayHidden = true;
        } else {
            if (!introPlayed) {
                // Startsound nur beim ersten Mal (mit Intro zusammen) — nicht im Perf Mode
                if (!document.body.classList.contains('perf-mode')) {
                    try {
                        const snd = document.getElementById('ovStartSound');
                        if (snd) { snd.currentTime = 0; snd.volume = 0.4; snd.play().catch(() => {}); }
                    } catch(e) {}
                }
                introPlayed = true;
                document.body.classList.remove('watermark-visible');
                playIntro(() => {
                    document.body.classList.add('overlay-active');
                    overlayHidden = false;
                });
            } else {
                document.body.classList.add('overlay-active');
                document.body.classList.remove('watermark-visible');
                overlayHidden = false;
            }
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
        const el = document.getElementById('supporter-count');
        if (el) el.textContent = `${count} Supporter`;
        console.log('[Overlay] Supporter count:', count);
    }

    // ─── SMALL NOTIFICATIONS ────────────────────────────────────
    const MAX_NOTIFS = 3;

    function notify({ title, text, type = 'announce', duration = 7000 }) {
        const area    = document.getElementById('notif-area');
        const current = area.querySelectorAll('.notif-card:not(.out)');
        if (current.length >= MAX_NOTIFS) dismiss(current[current.length - 1]);

        const icons   = {
            ticket: 'ticket',
            admin: 'shield',
            announce: 'megaphone',
            mention: 'at-sign',
            support: 'headphones',
            streak: 'flame',
            info: 'info',
        };
        const icoName = icons[type] || 'bell';
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
        window._overlaySocket = socket; // Expose for PanicSystem

        socket.on('connect', () => {
            console.log('[Overlay] Socket verbunden');
            if (discordId) socket.emit('overlay_client_connect', { discordId, robloxId, isAdmin });

            // Voice Channel beitreten
            socket.emit('voice_channel_join', {
                channelId: voiceChannelId,
                username:  voiceUsername,
                discordId: voiceDiscordId,
            });
            // Stale-State Fix: Support-Cases bei jedem Reconnect re-fetchen
            if (window.SupportOverlay?.loadInitial) {
                setTimeout(() => SupportOverlay.loadInitial(), 500);
            }
        });

        socket.on('overlay_supporter_count', ({ count }) => setSupporter(count));

        socket.on(`overlay_game_start_${discordId}`, ({ startTime }) => setGameRunning(true, startTime));
        socket.on(`overlay_game_end_${discordId}`,   ()               => setGameRunning(false));

        // Shift sync: wenn jemand anderes (oder Dashboard) shift ändert
        socket.on('shift_update', (data) => {
            if (data.discordId === discordId) OverlayShift._syncFromServer(data);
        });

        // Support-Case Live-Panel (Staff-only)
        socket.on('support_case_new',    (c) => SupportOverlay.add(c));
        socket.on('support_case_update', (c) => SupportOverlay.update(c));
        socket.on('support_case_closed', (c) => SupportOverlay.remove(c.caseId));

        // Mod-Eintrag: Custom Notification (top, glass, sound)
        socket.on('mod_new_entry', (entry) => {
            showOverlayModNotif(entry);
            // Live-History aktualisieren
            if (_modHistoryCache) {
                _modHistoryCache.unshift(entry);
                if (_modHistoryCache.length > 15) _modHistoryCache.pop();
                const c = document.getElementById('modLiveHistory');
                if (c) renderModHistory(c, _modHistoryCache);
            }
        });

        // Panic Alert empfangen
        socket.on('panic_alert', (data) => {
            console.log('[PANIC] Alert empfangen:', data.username, data.robloxUsername, '| panicAlert element:', !!document.getElementById('panicAlert'));
            PanicSystem.showAlert(data);
        });

        // Panic Accepted: ALLE sehen wer angenommen hat
        socket.on('panic_accepted', (data) => {
            console.log(`[PANIC] ${data.acceptedBy} hat angenommen (target: ${data.targetUsername})`);
            // Panic-Alert schliessen bei allen (jemand kuemmert sich)
            PanicSystem.dismiss();

            if (data.targetDiscordId === discordId) {
                // Du bist der Panic-Sender
                notify({ title: 'Hilfe kommt!', text: `${data.acceptedBy} kommt zu dir!`, type: 'admin', duration: 10000 });
            } else {
                // Alle anderen sehen wer angenommen hat
                notify({ title: 'Panic angenommen', text: `${data.acceptedBy} hilft ${data.targetUsername}`, type: 'info', duration: 8000 });
            }
        });

        if (window.electronAPI) {
            socket.on('overlay_game_start_test', (data) => setGameRunning(true, data.startTime));
        }

        notify({ title: 'Emden Network', text: 'Overlay aktiv & bereit.', type: 'info' });

        socket.on('overlay_notification',               handleNotif);
        socket.on(`overlay_notification_${discordId}`, handleNotif);
        socket.on('overlay_big_announcement', bigAnnounce);

        socket.on('overlay_new_ticket', (data) => {
            const { ticketId, reason, channelName } = data || {};
            notify({ title: `📩 Neues Ticket`, text: `#${channelName || ticketId} — ${reason || 'Neues Ticket'}`, type: 'ticket', duration: 15000 });
            // Neuer Ticket-Toast mit Claim-Button (wenn channelId vorhanden)
            if (data?.channelId) TicketCtrl.onNewTicket(data);
        });
        socket.on('ticket_claimed', (data) => TicketCtrl.onClaimed(data));
        socket.on('ticket_message', (data) => TicketCtrl.onMessage(data));
        socket.on('ticket_closed',  (data) => TicketCtrl.onClosed(data));

        // Persönliche Mention
        socket.on(`dc_mention_${discordId}`, (data) => {
            notify({ title: data.title, text: data.message, type: 'mention', duration: 12000 });
        });

        // Support-Warteraum
        socket.on('support_waiting', (data) => {
            if (data.action === 'join') {
                notify({ title: '🎧 Support-Warteraum', text: `${data.username} wartet in ${data.channelName}`, type: 'support', duration: 15000 });
                try { const a = new Audio('./supportwarteraumsound.mp3'); a.volume = 0.5; a.play().catch(()=>{}); } catch(e) {}
            }
        });

        // Streak
        socket.on('streak_complete', (data) => {
            notify({ title: '🔥 Streak!', text: `${data.username} — ${data.streak} Tage!`, type: 'streak', duration: 8000 });
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
    let modPinned = false;
    let modSelectedUser = null;
    let modSelectedAction = null;
    let modSearchTimer = null;
    let modHistoryData = [];

    function requestFocus(on) {
        if (window.electronAPI?.overlayRequestFocus) window.electronAPI.overlayRequestFocus(on);
        else if (window.electronAPI?.requestOverlayFocus) window.electronAPI.requestOverlayFocus(on);
    }

    let _modHistoryCache = null;

    async function loadModHistory() {
        const container = document.getElementById('modLiveHistory');
        if (!container) return;

        // Sofort aus Cache
        if (_modHistoryCache) {
            renderModHistory(container, _modHistoryCache);
        }

        try {
            const res = await fetch(API_URL + '/api/mod-log?limit=15&discordId=' + encodeURIComponent(discordId), { headers: { 'x-api-key': API_KEY } });
            const data = await res.json();
            if (data.success && data.log?.length) {
                _modHistoryCache = data.log;
                renderModHistory(container, data.log);
            } else if (data.success) {
                container.innerHTML = `<div style="font-size:10px;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Letzte Einträge</div>
                    <div style="text-align:center;padding:20px;color:rgba(255,255,255,0.2);font-size:10px;">Keine Einträge vorhanden</div>`;
            }
        } catch(e) {
            console.warn('[Mod-History] Fehler beim Laden:', e);
            if (!_modHistoryCache) {
                container.innerHTML = `<div style="font-size:10px;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Letzte Einträge</div>
                    <div style="text-align:center;padding:20px;color:rgba(255,255,255,0.2);font-size:10px;">Verbindungsfehler — erneut versuchen</div>`;
            }
        }
    }

    function renderModHistory(container, entries) {
        const actionColors = { Ban: '#ff6b6b', Kick: '#f59e0b', Warn: '#3b82f6', 'One Day Ban': '#ff8c00', Notiz: '#8b5cf6' };
        container.innerHTML = `<div style="font-size:10px;color:rgba(255,255,255,0.25);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Letzte Einträge</div>` +
            entries.map((e, i) => {
                const color = actionColors[e.action] || '#3b82f6';
                const date = e.date ? new Date(e.date).toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit'}) : '';
                const time = e.date ? new Date(e.date).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';
                return `<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.05);border-left:3px solid ${color};border-radius:8px;padding:10px 12px;animation:fadeInUp .3s ease ${i*0.05}s both;">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                        <img src="${e.moderatorAvatar || e.modAvatar || ''}" style="width:20px;height:20px;border-radius:50%;border:1px solid rgba(255,255,255,0.1);" onerror="this.style.display='none'">
                        <span style="font-size:11px;font-weight:600;color:#fff;">${esc(e.moderator || '?')}</span>
                        <span style="font-size:8px;font-weight:700;background:${color}22;color:${color};padding:1px 5px;border-radius:3px;text-transform:uppercase;">${esc(e.action || '?')}</span>
                        <span style="margin-left:auto;font-size:9px;color:rgba(255,255,255,0.2);font-family:monospace;">${time}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="font-size:11px;color:rgba(255,255,255,0.6);">${esc(e.displayName || e.username || '?')}</span>
                        <span style="font-size:9px;color:rgba(255,255,255,0.2);">· ${date}</span>
                    </div>
                    ${e.reason && e.reason !== 'Kein Grund' ? `<div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:3px;">Grund: ${esc(e.reason).substring(0,60)}</div>` : ''}
                </div>`;
            }).join('');
    }

    function toggleModSlide() {
        modSlideOpen = !modSlideOpen;
        const panel = document.getElementById('mod-slide');
        if (!panel) return;
        panel.classList.toggle('open', modSlideOpen);
        document.body.classList.toggle('mod-open', modSlideOpen);

        if (modSlideOpen) {
            // Andere Panels schliessen — nur eines gleichzeitig
            try {
                const tk = document.getElementById('ticket-overlay');
                if (tk && tk.classList.contains('open') && window.TicketCtrl?.close) TicketCtrl.close();
                const gsg9 = document.getElementById('gsg9-slide');
                if (gsg9 && gsg9.classList.contains('open') && window.Overlay?.toggleGSG9) Overlay.toggleGSG9();
                const tt = document.getElementById('tiktok-slide');
                if (tt && tt.classList.contains('open') && window.Overlay?.toggleTiktok) Overlay.toggleTiktok();
            } catch(_) {}
            requestFocus(true);
            setTimeout(() => document.getElementById('modSearchInput')?.focus(), 350);
            loadModHistory();
        } else {
            // Focus erst nach kurzer Verzoegerung abgeben — verhindert dass Click-up auf X
            // durch das Panel hindurch zur Roblox-Map geht (Mouse-Leak-Bug).
            setTimeout(() => { requestFocus(false); }, 80);
            modPinned = false;
            const btn = document.getElementById('modPinBtn');
            if (btn) btn.classList.remove('pinned');
        }
    }

    // Legacy compat
    function toggleModPanel() { toggleModSlide(); }

    async function searchModUser(query) {
        clearTimeout(modSearchTimer);
        const results = document.getElementById('modResults');
        if (!query || query.length < 2) {
            results.innerHTML = '<div class="mod-res-empty">Username, ID oder Anzeigename</div>';
            results.classList.remove('show');
            return;
        }
        results.innerHTML = '<div class="mod-res-empty">Suche...</div>';
        results.classList.add('show');

        modSearchTimer = setTimeout(async () => {
            try {
                let u = null;

                // 1. Wenn nur Zahlen → direkt als User-ID suchen
                if (/^\d+$/.test(query.trim())) {
                    try {
                        const idRes = await fetch('https://users.roblox.com/v1/users/' + query.trim());
                        if (idRes.ok) {
                            const idData = await idRes.json();
                            if (idData.id) u = { id: idData.id, name: idData.name, displayName: idData.displayName };
                        }
                    } catch(e) {}
                }

                // 2. Wenn nicht per ID gefunden → Username-Suche
                if (!u) {
                    const r = await fetch('https://users.roblox.com/v1/usernames/users', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ usernames: [query], excludeBannedUsers: false })
                    });
                    const data = await r.json();
                    if (data.data?.length) u = data.data[0];
                }

                // 3. Wenn immer noch nicht → Display Name Suche
                if (!u) {
                    try {
                        const searchRes = await fetch('https://users.roblox.com/v1/users/search?keyword=' + encodeURIComponent(query) + '&limit=1');
                        const searchData = await searchRes.json();
                        if (searchData.data?.length) {
                            const s = searchData.data[0];
                            u = { id: s.id, name: s.name, displayName: s.displayName || s.name };
                        }
                    } catch(e) {}
                }

                if (!u) {
                    results.innerHTML = '<div class="mod-res-empty">Nicht gefunden</div>';
                    return;
                }
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
            sel.innerHTML = `<span>${esc(displayName)} (<span class="mod-copy" onclick="event.stopPropagation();navigator.clipboard.writeText('${esc(username)}');this.textContent='Kopiert!';setTimeout(()=>this.textContent='@${esc(username)}',800)" title="Username kopieren" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">@${esc(username)}</span>) · <span class="mod-copy" onclick="event.stopPropagation();navigator.clipboard.writeText('${id}');this.textContent='Kopiert!';setTimeout(()=>this.textContent='${id}',800)" title="ID kopieren" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;">${id}</span></span><button class="mod-sel-x" onclick="Overlay.clearModUser(event)">&times;</button>`;
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

        // Mod-History laden
        const historyEl = document.getElementById('modHistory');
        const historyTitle = document.getElementById('modHistoryTitle');
        const historyList = document.getElementById('modHistoryList');
        historyEl.style.display = 'none';
        try {
            const histRes = await fetch(API_URL + '/api/mod-history?userId=' + id + '&discordId=' + encodeURIComponent(discordId), {
                headers: { 'x-api-key': API_KEY }
            });
            const histData = await histRes.json();
            if (histData.success && histData.count > 0) {
                // Speichere History-Daten für Detail-Ansicht
                modHistoryData = histData.entries;
                historyTitle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ${histData.count} Eintrag${histData.count > 1 ? 'e' : ''}`;
                historyList.innerHTML = histData.entries.map((h, i) => {
                    const emoji = h.action === 'Ban' ? '🔨' : h.action === 'Kick' ? '👢' : '⚠️';
                    const cls = (h.action || '').toLowerCase();
                    const date = h.date ? new Date(h.date).toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'}) : '—';
                    const time = h.date ? new Date(h.date).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit'}) : '';
                    const modAvHtml = h.modAvatar ? `<div class="mod-history-mod-av"><img src="${h.modAvatar}" /></div>` : `<div class="mod-history-mod-av" style="display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:rgba(255,255,255,0.3);">${esc((h.moderator||'?')[0].toUpperCase())}</div>`;
                    return `<div class="mod-history-entry ${cls}" onclick="Overlay.openHistoryDetail(${i})" style="cursor:pointer;">
                        <div class="mod-history-emoji">${emoji}</div>
                        <div class="mod-history-info">
                            <div class="mod-history-action"><span class="tag ${cls}">${esc(h.action || '?')}</span> ${esc(h.displayName || '—')}</div>
                            <div class="mod-history-reason">${esc(h.reason || 'Kein Grund')}</div>
                            <div class="mod-history-meta"><span>${date} ${time}</span><span>von ${esc(h.moderator || '?')}</span></div>
                        </div>
                        ${modAvHtml}
                    </div>`;
                }).join('');
                historyEl.style.display = 'flex';
            } else if (histData.success && histData.count === 0) {
                historyTitle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> 0 Einträge`;
                historyList.innerHTML = `<div style="padding:16px;text-align:center;font-size:11px;color:rgba(255,255,255,0.3);">Keine vorherigen Einträge</div>`;
                historyEl.style.display = 'flex';
            } else {
                console.warn('[Mod-History] API-Fehler:', histData.error || 'Unbekannt');
                historyTitle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ? Einträge`;
                historyList.innerHTML = `<div style="padding:16px;text-align:center;font-size:11px;color:#ff6b6b;">Fehler: ${esc(histData.error || 'Laden fehlgeschlagen')}</div>`;
                historyEl.style.display = 'flex';
            }
        } catch(e) {
            console.warn('[Mod-History] Exception:', e);
            historyTitle.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ? Einträge`;
            historyList.innerHTML = `<div style="padding:16px;text-align:center;font-size:11px;color:#ff6b6b;">Verbindungsfehler</div>`;
            historyEl.style.display = 'flex';
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
        // Profile + History + Detail zurücksetzen
        document.getElementById('modProfileEmpty').style.display = 'flex';
        document.getElementById('modProfileContent').style.display = 'none';
        document.getElementById('modDiscordInfo').style.display = 'none';
        document.getElementById('modHistory').style.display = 'none';
        document.getElementById('modDetail').style.display = 'none';
        modHistoryData = [];
        updateModSendBtn();
        // Live-History sofort aus Cache anzeigen
        if (_modHistoryCache) {
            const c = document.getElementById('modLiveHistory');
            if (c) renderModHistory(c, _modHistoryCache);
        }
    }

    function pickModAction(type, el) {
        modSelectedAction = type;
        document.querySelectorAll('.mod-act').forEach(a => a.classList.remove('on'));
        el.classList.add('on');
        // Notiz-Textfeld immer einblenden wenn eine Aktion gewählt ist
        const notizBox = document.getElementById('modNotizBox');
        if (notizBox) notizBox.style.display = 'block';
        const notizInp = document.getElementById('modNotizInput');
        if (notizInp) notizInp.placeholder = type === 'Notiz' ? 'Notiz eingeben...' : 'Notiz hinzufügen (optional)...';
        updateModSendBtn();
    }

    function updateModSendBtn() {
        const btn = document.getElementById('modSendBtn');
        if (btn) btn.disabled = !(modSelectedUser && modSelectedAction);
    }

    // ─── BILD-UPLOAD FÜR MOD-EINTRÄGE ─────────────────────
    let modImageBase64 = null;

    function _handleModImage(input) {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            modImageBase64 = e.target.result; // data:image/png;base64,...
            const thumb = document.getElementById('modImgThumb');
            const preview = document.getElementById('modImgPreview');
            if (thumb) thumb.src = modImageBase64;
            if (preview) preview.style.display = 'block';
            document.getElementById('modImgBtn').style.borderColor = 'rgba(0,136,255,0.5)';
            document.getElementById('modImgBtn').style.color = '#0088ff';
        };
        reader.readAsDataURL(file);
    }

    function _clearModImage() {
        modImageBase64 = null;
        const preview = document.getElementById('modImgPreview');
        if (preview) preview.style.display = 'none';
        document.getElementById('modImgInput').value = '';
        document.getElementById('modImgBtn').style.borderColor = 'rgba(255,255,255,0.1)';
        document.getElementById('modImgBtn').style.color = 'rgba(255,255,255,0.5)';
    }

    // Paste-Support: Bild aus Zwischenablage einfügen
    document.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                const file = item.getAsFile();
                const reader = new FileReader();
                reader.onload = (ev) => {
                    modImageBase64 = ev.target.result;
                    const thumb = document.getElementById('modImgThumb');
                    const preview = document.getElementById('modImgPreview');
                    if (thumb) thumb.src = modImageBase64;
                    if (preview) preview.style.display = 'block';
                    document.getElementById('modImgBtn').style.borderColor = 'rgba(0,136,255,0.5)';
                    document.getElementById('modImgBtn').style.color = '#0088ff';
                };
                reader.readAsDataURL(file);
                break;
            }
        }
    });

    async function sendModAction() {
        if (!modSelectedUser || !modSelectedAction) return;
        const reason = document.getElementById('modReasonInput')?.value?.trim() || 'Kein Grund';
        const notiz = document.getElementById('modNotizInput')?.value?.trim() || '';
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
                    moderatorDiscordId: voiceDiscordId || discordId || '',
                    moderatorAvatar: voiceAvatar || '',
                    evidence: modImageBase64 || null,
                    notiz: notiz || null
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Fehler');
            showModMsg('✓ ' + modSelectedAction + ' gesendet', 'ok');
            document.getElementById('modReasonInput').value = '';
            const notizInp = document.getElementById('modNotizInput'); if (notizInp) notizInp.value = '';
            const notizBox = document.getElementById('modNotizBox'); if (notizBox) notizBox.style.display = 'none';
            modSelectedAction = null;
            _clearModImage(); // Bild zurücksetzen
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

    // ─── INTRO SEQUENCE ──────────────────────────────────────
    function playIntro(onComplete) {
        const intro = document.getElementById('intro-overlay');
        if (!intro) { onComplete(); return; }

        // Performance Mode: Intro komplett ueberspringen
        if (document.body.classList.contains('perf-mode')) {
            intro.classList.add('gone');
            onComplete();
            return;
        }

        // Username setzen
        const usernameEl = document.getElementById('introUsername');
        if (usernameEl) usernameEl.textContent = voiceUsername || 'User';

        // Intro sichtbar machen
        intro.classList.remove('gone', 'fade-out');
        intro.classList.add('playing');

        const line = document.getElementById('introLine');
        const textGroup = document.getElementById('introTextGroup');
        const logo = document.getElementById('introLogo');
        const greeting = document.getElementById('introGreeting');

        // Reset
        [line, textGroup, logo, greeting].forEach(el => { if (el) el.classList.remove('show'); });

        // Cinematic Timeline — more dramatic
        setTimeout(() => { if (line) line.classList.add('show'); }, 300);
        setTimeout(() => { if (textGroup) textGroup.classList.add('show'); }, 800);
        setTimeout(() => { if (logo) logo.classList.add('show'); }, 2000);
        setTimeout(() => { if (greeting) greeting.classList.add('show'); }, 3200);

        // Fade out
        setTimeout(() => { intro.classList.add('fade-out'); }, 5000);

        // Entfernen + Overlay aktivieren
        setTimeout(() => {
            intro.classList.add('gone');
            intro.classList.remove('playing');
            onComplete();
        }, 6500);
    }

    // ─── SETTINGS ────────────────────────────────────────────
    let settingsOpen = false;
    const SETTINGS_KEY = 'en_overlay_settings_' + discordId;
    const COLOR_MAP = {
        'default':   { solid: 'rgba(6,8,18,', mid: 'rgba(10,18,40,', fade: 'rgba(14,24,55,' },
        'pure-dark': { solid: 'rgba(6,6,6,',  mid: 'rgba(10,10,10,', fade: 'rgba(16,16,16,' },
        'navy':      { solid: 'rgba(8,16,32,', mid: 'rgba(14,28,56,', fade: 'rgba(18,36,70,' },
        'purple':    { solid: 'rgba(14,8,22,', mid: 'rgba(28,14,48,', fade: 'rgba(38,20,60,' },
        'green':     { solid: 'rgba(6,14,10,', mid: 'rgba(8,24,16,',  fade: 'rgba(12,32,22,' },
        'red':       { solid: 'rgba(14,6,6,',  mid: 'rgba(28,10,10,', fade: 'rgba(38,16,16,' },
    };
    let currentColor = 'default';

    function toggleSettings() {
        settingsOpen = !settingsOpen;
        const panel = document.getElementById('settings-panel');
        if (panel) panel.classList.toggle('open', settingsOpen);
        if (settingsOpen) requestFocus(true);
        else if (!modSlideOpen) requestFocus(false);
    }

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (!saved) return;
            const el = (id) => document.getElementById(id);
            if (saved.fadeEnabled !== undefined) el('settFadeEnabled').checked = saved.fadeEnabled;
            if (saved.fadeStr) el('settFadeStr').value = saved.fadeStr;
            if (saved.gridEnabled !== undefined) el('settGridEnabled').checked = saved.gridEnabled;
            if (saved.shimmerEnabled !== undefined) el('settShimmerEnabled').checked = saved.shimmerEnabled;
            if (saved.logoOpacity) el('settLogoOpacity').value = saved.logoOpacity;
            if (saved.wmOpacity) el('settWmOpacity').value = saved.wmOpacity;
            if (saved.modPanelOpacity) { const mp = el('settModPanelOpacity'); if (mp) mp.value = saved.modPanelOpacity; }
            if (saved.color) {
                currentColor = saved.color;
                document.querySelectorAll('.settings-color-opt').forEach(o => o.classList.toggle('active', o.dataset.color === saved.color));
            }
            applySetting();
        } catch(e) {}
    }

    function saveSettings() {
        try {
            const data = {
                fadeEnabled: document.getElementById('settFadeEnabled').checked,
                fadeStr: document.getElementById('settFadeStr').value,
                gridEnabled: document.getElementById('settGridEnabled').checked,
                shimmerEnabled: document.getElementById('settShimmerEnabled').checked,
                logoOpacity: document.getElementById('settLogoOpacity').value,
                wmOpacity: document.getElementById('settWmOpacity').value,
                modPanelOpacity: document.getElementById('settModPanelOpacity')?.value || 92,
                color: currentColor,
            };
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
        } catch(e) {}
    }

    function applySetting() {
        const fadeOn = document.getElementById('settFadeEnabled').checked;
        const fadeStr = parseInt(document.getElementById('settFadeStr').value);
        const gridOn = document.getElementById('settGridEnabled').checked;
        const shimmerOn = document.getElementById('settShimmerEnabled').checked;
        const logoOp = parseInt(document.getElementById('settLogoOpacity').value);
        const wmOp = parseInt(document.getElementById('settWmOpacity').value);
        const mpOp = parseInt(document.getElementById('settModPanelOpacity')?.value || '92');

        // Update value displays
        document.getElementById('settFadeStrVal').textContent = fadeStr + '%';
        document.getElementById('settLogoVal').textContent = logoOp + '%';
        document.getElementById('settWmVal').textContent = wmOp + '%';
        const mpVal = document.getElementById('settModPanelOpacityVal');
        if (mpVal) mpVal.textContent = mpOp + '%';

        // Toggle classes
        document.body.classList.toggle('no-fade', !fadeOn);
        document.body.classList.toggle('no-grid', !gridOn);
        document.body.classList.toggle('no-shimmer', !shimmerOn);

        // Fade strength — update CSS variables
        const str = fadeStr / 100;
        const c = COLOR_MAP[currentColor] || COLOR_MAP['default'];
        document.documentElement.style.setProperty('--panel-solid', c.solid + (str * 0.95).toFixed(2) + ')');
        document.documentElement.style.setProperty('--panel-mid', c.mid + (str * 0.6).toFixed(2) + ')');
        document.documentElement.style.setProperty('--panel-fade', c.fade + (str * 0.2).toFixed(2) + ')');

        // Mod-Panel Alpha: wirkt auf #mod-slide-bg + .mod-detail
        document.documentElement.style.setProperty('--mod-panel-alpha', (mpOp / 100).toFixed(3));

        // Logo opacity
        const logoImg = document.getElementById('logo-img');
        if (logoImg) logoImg.style.opacity = (logoOp / 100).toFixed(2);

        // Watermark opacity
        const wmImg = document.querySelector('#bg-watermark img');
        if (wmImg) wmImg.style.opacity = (wmOp / 100).toFixed(2);

        saveSettings();
    }

    function pickColor(color, el) {
        currentColor = color;
        document.querySelectorAll('.settings-color-opt').forEach(o => o.classList.remove('active'));
        if (el) el.classList.add('active');
        applySetting();
    }

    function resetSettings() {
        currentColor = 'default';
        document.getElementById('settFadeEnabled').checked = true;
        document.getElementById('settFadeStr').value = 92;
        document.getElementById('settGridEnabled').checked = true;
        document.getElementById('settShimmerEnabled').checked = true;
        document.getElementById('settLogoOpacity').value = 70;
        document.getElementById('settWmOpacity').value = 4;
        const mp = document.getElementById('settModPanelOpacity');
        if (mp) mp.value = 92;
        document.querySelectorAll('.settings-color-opt').forEach(o => o.classList.toggle('active', o.dataset.color === 'default'));
        applySetting();
    }

    // ─── PANEL PIN/UNPIN ─────────────────────────────────────
    let panelPinned = true;

    function togglePanelPin() {
        panelPinned = !panelPinned;
        const panel = document.getElementById('panel-left');
        const btn = document.getElementById('panelPinBtn');
        if (panel) panel.classList.toggle('collapsed', !panelPinned);
        if (btn) btn.classList.toggle('unpinned', !panelPinned);
    }

    function openHistoryDetail(index) {
        const h = modHistoryData[index];
        if (!h) return;

        const detail = document.getElementById('modDetail');
        const content = document.getElementById('modDetailContent');
        if (!detail || !content) return;

        const emoji = h.action === 'Ban' ? '🔨' : h.action === 'Kick' ? '👢' : '⚠️';
        const cls = (h.action || '').toLowerCase();
        const date = h.date ? new Date(h.date).toLocaleDateString('de-DE', {weekday:'long', day:'2-digit',month:'2-digit',year:'numeric'}) : '—';
        const time = h.date ? new Date(h.date).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
        const userName = modSelectedUser?.displayName || modSelectedUser?.username || '—';
        const userId = modSelectedUser?.id || '—';

        content.innerHTML = `
            <div class="detail-card">
                <div class="detail-action-bar ${cls}">
                    <div class="detail-action-emoji">${emoji}</div>
                    <div class="detail-action-info">
                        <div class="detail-action-title">${esc(h.action || '?')}</div>
                        <div class="detail-action-sub">Eintrag #${h.index || index + 1}${h.source === 'trident' ? ' · Trident' : ''}</div>
                    </div>
                    <span class="detail-action-tag ${cls}">${esc(h.action || '?')}</span>
                </div>
                <div class="detail-body">
                    <div class="detail-row">
                        <span class="detail-label">User</span>
                        <span class="detail-value">${esc(h.displayName || userName)}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">User ID</span>
                        <span class="detail-value muted" style="font-family:var(--font-mono);font-size:11px;">${esc(String(userId))}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Datum</span>
                        <span class="detail-value">${date}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">Uhrzeit</span>
                        <span class="detail-value">${time}</span>
                    </div>
                </div>
                <div class="detail-reason-section">
                    <div class="detail-reason-label">Grund</div>
                    <div class="detail-reason-box">${esc(h.reason || 'Kein Grund angegeben')}</div>
                </div>
                <div class="detail-mod">
                    ${h.modAvatar
                        ? `<div class="detail-mod-av"><img src="${h.modAvatar}" /></div>`
                        : `<div class="detail-mod-av">${esc((h.moderator||'?')[0].toUpperCase())}</div>`
                    }
                    <div>
                        <div class="detail-mod-name">${esc(h.moderator || 'Unbekannt')}</div>
                        <div class="detail-mod-role">Moderator</div>
                    </div>
                </div>
            </div>`;

        // Lucide Icons refreshen
        if (typeof lucide !== 'undefined') lucide.createIcons();

        detail.style.display = 'flex';
    }

    function closeHistoryDetail() {
        const detail = document.getElementById('modDetail');
        if (detail) detail.style.display = 'none';
    }

    function toggleModPin() {
        modPinned = !modPinned;
        const btn = document.getElementById('modPinBtn');
        if (btn) btn.classList.toggle('pinned', modPinned);
        // Wenn gerade gepinnt: Focus abgeben damit Spiel sofort spielbar
        // Focus kommt zurück wenn Maus über Panel hovert
        if (modPinned && modSlideOpen) {
            requestFocus(false);
        }
    }

    // ─── GSG9 PANEL ────────────────────────────────────────
    let gsg9Open = false;

    async function toggleGSG9() {
        gsg9Open = !gsg9Open;
        const panel = document.getElementById('gsg9-slide');
        if (!panel) return;
        if (gsg9Open) {
            panel.style.transform = 'translateY(0)';
            panel.style.pointerEvents = 'auto';
            requestFocus(true);
            loadGSG9();
        } else {
            panel.style.transform = 'translateY(100%)';
            panel.style.pointerEvents = 'none';
            requestFocus(false);
        }
    }

    let _gsg9Cache = null;

    async function loadGSG9() {
        const container = document.getElementById('gsg9Content');
        if (!container) return;

        // Sofort aus Cache anzeigen (wenn vorhanden)
        if (_gsg9Cache) {
            renderGSG9(container, _gsg9Cache);
        } else {
            container.innerHTML = '<div style="text-align:center;padding:20px;color:rgba(255,255,255,0.3);font-size:11px;">Lade...</div>';
        }

        // Im Hintergrund aktualisieren
        try {
            const res = await fetch(API_URL + '/api/gsg9', { headers: { 'x-api-key': API_KEY } });
            const data = await res.json();
            if (!data.success || !data.teams?.length) {
                if (!_gsg9Cache) container.innerHTML = '<div style="text-align:center;padding:20px;color:rgba(255,255,255,0.3);font-size:11px;">Keine Daten</div>';
                return;
            }
            _gsg9Cache = data.teams;
            renderGSG9(container, data.teams);
        } catch(e) {
            if (!_gsg9Cache) container.innerHTML = `<div style="text-align:center;padding:20px;color:#ff6b6b;font-size:11px;">Fehler: ${e.message}</div>`;
            console.error('[GSG9] Load error:', e);
        }
    }

    function renderGSG9(container, teams) {
        if (!container || !teams) return;
        try {
            container.innerHTML = teams.map(team => {
                const members = team.members.length > 0
                    ? team.members.map(m => {
                        const statusColor = m.status === 'online' ? '#22c55e' : m.status === 'idle' ? '#f59e0b' : m.status === 'dnd' ? '#ef4444' : '#6b7280';
                        const nameColor = m.onDuty ? '#ff69b4' : 'rgba(255,255,255,0.85)';
                        const dutyBadge = m.onDuty ? '<span style="font-size:8px;font-weight:700;background:rgba(255,105,180,0.15);color:#ff69b4;padding:1px 5px;border-radius:3px;margin-left:4px;text-transform:uppercase;letter-spacing:.04em;">On Duty</span>' : '';
                        const robloxBadge = m.robloxId ? `<span onclick="event.stopPropagation();Overlay._showGSG9Profile('${m.discordId}','${m.robloxId}')" style="cursor:pointer;font-size:8px;font-weight:700;background:rgba(59,130,246,0.15);color:#3b82f6;padding:1px 5px;border-radius:3px;margin-left:auto;flex-shrink:0;">ROBLOX</span>` : '';
                        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;transition:all .2s;animation:fadeInUp .3s ease both;" onmouseenter="this.style.background='rgba(255,255,255,0.04)'" onmouseleave="this.style.background='transparent'">
                            <div style="position:relative;flex-shrink:0;">
                                <img src="${m.avatar}" style="width:30px;height:30px;border-radius:50%;border:2px solid ${m.onDuty ? 'rgba(255,105,180,0.3)' : 'rgba(255,255,255,0.06)'};" onerror="this.style.display='none'">
                                <div style="position:absolute;bottom:-1px;right:-1px;width:10px;height:10px;border-radius:50%;background:${statusColor};border:2px solid rgba(8,12,24,0.95);"></div>
                            </div>
                            <span style="font-size:12px;font-weight:500;color:${nameColor};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${m.username}</span>
                            ${dutyBadge}
                            ${robloxBadge}
                        </div>`;
                    }).join('')
                    : '<div style="padding:8px;font-size:10px;color:rgba(255,255,255,0.2);font-style:italic;">Keine Mitglieder</div>';

                return `<div style="background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:10px;overflow:hidden;">
                    <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.04);">
                        <div style="width:8px;height:8px;border-radius:3px;background:${team.color};flex-shrink:0;"></div>
                        <span style="font-size:12px;font-weight:700;color:${team.color};letter-spacing:.02em;">${team.name}</span>
                        <span style="margin-left:auto;font-size:9px;color:rgba(255,255,255,0.25);font-family:monospace;">${team.members.length}</span>
                    </div>
                    <div style="padding:4px;">${members}</div>
                </div>`;
            }).join('');
        } catch(e) {
            container.innerHTML = `<div style="text-align:center;padding:20px;color:#ff6b6b;font-size:11px;">Fehler: ${e.message}</div>`;
            console.error('[GSG9] Load error:', e);
        }
    }

    // ─── GSG9 ROBLOX PROFILE DETAIL ─────────────────────────
    async function _showGSG9Profile(discordId, robloxId) {
        const container = document.getElementById('gsg9Content');
        if (!container) return;

        container.innerHTML = `<div style="animation:fadeInUp .3s ease;">
            <div onclick="Overlay.loadGSG9()" style="cursor:pointer;color:rgba(255,255,255,0.4);font-size:11px;margin-bottom:12px;display:flex;align-items:center;gap:4px;">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                Zurück
            </div>
            <div style="text-align:center;padding:20px;color:rgba(255,255,255,0.3);font-size:11px;">Lade Profil...</div>
        </div>`;

        try {
            const [pRes, aRes] = await Promise.all([
                fetch('https://users.roblox.com/v1/users/' + robloxId),
                fetch('https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=' + robloxId + '&size=420x420&format=Png&isCircular=false')
            ]);
            const pData = await pRes.json();
            const aData = await aRes.json();
            const avatar = aData.data?.[0]?.imageUrl || '';
            const created = pData.created ? new Date(pData.created).toLocaleDateString('de-DE', {day:'2-digit',month:'2-digit',year:'numeric'}) : '—';

            container.innerHTML = `<div style="animation:fadeInUp .3s ease;">
                <div onclick="Overlay.loadGSG9()" style="cursor:pointer;color:rgba(255,255,255,0.4);font-size:11px;margin-bottom:16px;display:flex;align-items:center;gap:4px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                    Zurück
                </div>
                <div style="text-align:center;margin-bottom:16px;">
                    ${avatar ? `<img src="${avatar}" style="width:80px;height:80px;border-radius:50%;border:3px solid rgba(59,130,246,0.3);margin-bottom:8px;">` : ''}
                    <div style="font-size:16px;font-weight:700;color:#fff;">${pData.displayName || pData.name}</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.4);">@${pData.name}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;">
                    <div style="display:flex;justify-content:space-between;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;">
                        <span style="font-size:11px;color:rgba(255,255,255,0.4);">User ID</span>
                        <span onclick="navigator.clipboard.writeText('${robloxId}');this.textContent='Kopiert!';setTimeout(()=>this.textContent='${robloxId}',800)" style="font-size:11px;color:#3b82f6;cursor:pointer;font-family:monospace;">${robloxId}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;">
                        <span style="font-size:11px;color:rgba(255,255,255,0.4);">Username</span>
                        <span onclick="navigator.clipboard.writeText('${pData.name}');this.textContent='Kopiert!';setTimeout(()=>this.textContent='@${pData.name}',800)" style="font-size:11px;color:#3b82f6;cursor:pointer;">@${pData.name}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;">
                        <span style="font-size:11px;color:rgba(255,255,255,0.4);">Display Name</span>
                        <span style="font-size:11px;color:rgba(255,255,255,0.7);">${pData.displayName || '—'}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;">
                        <span style="font-size:11px;color:rgba(255,255,255,0.4);">Erstellt</span>
                        <span style="font-size:11px;color:rgba(255,255,255,0.7);">${created}</span>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding:8px 10px;background:rgba(255,255,255,0.03);border-radius:8px;">
                        <span style="font-size:11px;color:rgba(255,255,255,0.4);">Discord ID</span>
                        <span onclick="navigator.clipboard.writeText('${discordId}');this.textContent='Kopiert!';setTimeout(()=>this.textContent='${discordId}',800)" style="font-size:11px;color:#3b82f6;cursor:pointer;font-family:monospace;">${discordId}</span>
                    </div>
                    <a href="https://www.roblox.com/users/${robloxId}/profile" target="_blank" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:8px;padding:10px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);border-radius:8px;color:#3b82f6;font-size:11px;font-weight:600;text-decoration:none;transition:background .2s;" onmouseenter="this.style.background='rgba(59,130,246,0.2)'" onmouseleave="this.style.background='rgba(59,130,246,0.1)'">
                        Roblox Profil öffnen →
                    </a>
                </div>
                ${pData.description ? `<div style="margin-top:12px;padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid rgba(255,255,255,0.04);">
                    <div style="font-size:9px;color:rgba(255,255,255,0.3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Bio</div>
                    <div style="font-size:11px;color:rgba(255,255,255,0.5);line-height:1.5;">${pData.description.substring(0, 200)}</div>
                </div>` : ''}
            </div>`;
        } catch(e) {
            container.innerHTML = `<div style="animation:fadeInUp .3s ease;">
                <div onclick="Overlay.loadGSG9()" style="cursor:pointer;color:rgba(255,255,255,0.4);font-size:11px;margin-bottom:12px;">← Zurück</div>
                <div style="text-align:center;padding:20px;color:#ff6b6b;font-size:11px;">Fehler: ${e.message}</div>
            </div>`;
        }
    }

    // Expose loadGSG9 for back-button
    function _loadGSG9Public() { requestFocus(true); loadGSG9(); }

    return { init, toggleCmd, toggleModSlide, toggleModPanel, toggleModPin, searchModUser, selectModUser, clearModUser, pickModAction, sendModAction, _handleModImage, _clearModImage, togglePanelPin, toggleOverlayVisibility, openHistoryDetail, closeHistoryDetail, toggleSettings, applySetting, pickColor, resetSettings, toggleGSG9, loadGSG9: _loadGSG9Public, _showGSG9Profile, getRobloxUsername: () => robloxUsername, getDiscordId: () => discordId, getUsername: () => voiceUsername };
})();

// ══════════════════════════════════════════════
// PANIC BUTTON SYSTEM
// ══════════════════════════════════════════════
const PanicSystem = {
    _targetUsername: null,
    _targetDiscordId: null,
    _lastTrigger: 0,
    _autoCloseTimer: null,
    _focusInterval: null,

    trigger() {
        // Debounce: max 1x pro 5 Sekunden
        const now = Date.now();
        if (now - this._lastTrigger < 5000) {
            console.log('[PANIC] Debounce — ignoriert (zu schnell)');
            return;
        }
        this._lastTrigger = now;

        // Overlay-Variablen nutzen (localStorage ist leer — separates Fenster!)
        const myDiscordId = Overlay.getDiscordId();
        const myUsername = Overlay.getUsername();
        if (!myDiscordId) { console.log('[PANIC] Kein discordId'); return; }

        const robloxUsername = Overlay.getRobloxUsername() || myUsername || '?';
        console.log(`[PANIC] Roblox Username: ${robloxUsername}`);

        const socket = window._overlaySocket;
        console.log(`[PANIC] Button gedrückt! Socket connected: ${!!socket?.connected}, User: ${myUsername}, Roblox: ${robloxUsername}`);

        if (socket?.connected) {
            socket.emit('panic_button', {
                discordId: myDiscordId,
                username: myUsername || 'Unbekannt',
                robloxUsername: robloxUsername,
                avatar: '',
            });
            console.log('[PANIC] Socket emit gesendet');
        } else {
            console.log('[PANIC] Socket NICHT verbunden!');
        }
    },

    showAlert(data) {
        this._targetUsername = data.robloxUsername || data.username || '?';
        this._targetDiscordId = data.discordId || null;
        const el = document.getElementById('panicAlert');
        const userEl = document.getElementById('panicAlertUser');
        console.log('[PANIC] showAlert called — el:', !!el, 'userEl:', !!userEl, 'target:', this._targetUsername);
        if (!el) {
            console.error('[PANIC] panicAlert Element NICHT gefunden!');
            return;
        }

        if (userEl) userEl.textContent = this._targetUsername;
        el.style.display = 'flex';
        el.classList.add('active');
        console.log('[PANIC] Alert angezeigt!');

        // Sound
        try {
            if (window.electronAPI?.playNotificationSound) {
                window.electronAPI.playNotificationSound();
            }
        } catch(e) {}

        // Focus anfordern + wiederholt halten damit Buttons klickbar bleiben
        const reqFocus = window.electronAPI?.requestOverlayFocus || window.electronAPI?.overlayRequestFocus;
        if (reqFocus) {
            reqFocus(true);
            // Focus alle 500ms erneut anfordern (Electron gibt ihn sonst ab)
            if (this._focusInterval) clearInterval(this._focusInterval);
            this._focusInterval = setInterval(() => {
                const still = document.getElementById('panicAlert');
                if (still?.classList.contains('active')) {
                    reqFocus(true);
                } else {
                    clearInterval(this._focusInterval);
                    this._focusInterval = null;
                }
            }, 500);
        }

        // Timer-Anzeige starten (60 Sekunden)
        const timerEl = document.getElementById('panicTimer');
        let remaining = 60;
        if (timerEl) timerEl.textContent = `${remaining}s`;

        if (this._autoCloseTimer) clearInterval(this._autoCloseTimer);
        this._autoCloseTimer = setInterval(() => {
            remaining--;
            if (timerEl) timerEl.textContent = `${remaining}s`;
            if (remaining <= 0) {
                this.dismiss();
            }
        }, 1000);
    },

    accept() {
        // Overlay-Variablen nutzen (localStorage ist leer — separates Fenster!)
        const myDiscordId = Overlay.getDiscordId();
        const myUsername = Overlay.getUsername();
        const myRobloxUsername = Overlay.getRobloxUsername() || myUsername || '?';

        if (!myDiscordId) { console.log('[PANIC] Accept: Kein discordId'); return; }

        const socket = window._overlaySocket;
        console.log(`[PANIC] Accept von ${myUsername} (Roblox: ${myRobloxUsername}) fuer target: ${this._targetDiscordId}`);

        if (socket?.connected) {
            socket.emit('panic_accept', {
                discordId: myDiscordId,
                username: myUsername || 'Unbekannt',
                robloxUsername: myRobloxUsername,
                avatar: '',
                targetDiscordId: this._targetDiscordId,
                targetUsername: this._targetUsername || 'Unbekannt',
            });
            console.log('[PANIC] panic_accept emitted');
        } else {
            console.error('[PANIC] Socket nicht verbunden!');
        }

        this.dismiss();
    },

    dismiss() {
        // Timer + Focus-Interval stoppen
        if (this._autoCloseTimer) { clearInterval(this._autoCloseTimer); this._autoCloseTimer = null; }
        if (this._focusInterval) { clearInterval(this._focusInterval); this._focusInterval = null; }

        const el = document.getElementById('panicAlert');
        if (el) {
            el.classList.remove('active');
            el.style.display = 'none';
        }
        this._targetUsername = null;
        this._targetDiscordId = null;

        // Focus zurückgeben
        const reqFocus = window.electronAPI?.requestOverlayFocus || window.electronAPI?.overlayRequestFocus;
        if (reqFocus) reqFocus(false);
    },
};

window.PanicSystem = PanicSystem;

// ══════════════════════════════════════════════
// OVERLAY MOD NOTIFICATION (top, glass, fade, sound)
// ══════════════════════════════════════════════
let _ovModNotifTimer = null;
function showOverlayModNotif(entry) {
    const el = document.getElementById('ovModNotif');
    const icon = document.getElementById('ovModNotifIcon');
    const action = document.getElementById('ovModNotifAction');
    const text = document.getElementById('ovModNotifText');
    const badge = document.getElementById('ovModNotifBadge');
    const bar = document.getElementById('ovModNotifBar');
    const sound = document.getElementById('ovModNotifSound');
    if (!el) return;

    clearTimeout(_ovModNotifTimer);
    el.classList.remove('show', 'hide');

    const type = (entry.action || 'Warn').toLowerCase();
    const iconSvg = type === 'ban'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:60%;height:60%"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>'
        : type === 'kick'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:60%;height:60%"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:60%;height:60%"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    const userName = entry.displayName || entry.username || '?';
    const modName = entry.moderator || '?';

    icon.className = 'ov-mod-notif-icon ' + type;
    icon.innerHTML = iconSvg;
    action.textContent = entry.action || 'Warn';
    text.textContent = `${userName} wurde von @${modName} eingetragen`;
    badge.className = 'ov-mod-notif-badge ' + type;
    badge.textContent = entry.action || 'Warn';

    bar.classList.remove('animate');
    void bar.offsetWidth;
    bar.classList.add('animate');

    el.classList.add('show');

    // Sound via IPC (Main Window hat Audio-Focus)
    if (window.electronAPI?.playNotificationSound) {
        window.electronAPI.playNotificationSound();
    } else if (sound) {
        sound.currentTime = 0;
        sound.volume = 0.5;
        sound.play().catch(() => {});
    }

    _ovModNotifTimer = setTimeout(() => {
        el.classList.remove('show');
        el.classList.add('hide');
        setTimeout(() => el.classList.remove('hide'), 600);
    }, 6000);
}

// ══════════════════════════════════════════════
// OVERLAY SHIFT CONTROL
// ══════════════════════════════════════════════
const OverlayShift = {
    _shift: null,       // Server-Snapshot: {state, savedMs, breakMs, startedAt, breakStartedAt, ...}
    _tickInterval: null,

    async _apiCall(endpoint) {
        const session = JSON.parse(localStorage.getItem('en_session') || 'null');
        const discordId = session?.user?.discordId;
        if (!discordId) return null;
        try {
            const res = await fetch(`${OVL_CONFIG.API_URL}/api/shift/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ discordId }),
            });
            const data = await res.json();
            if (data?.success && data.shift) {
                this._shift = data.shift;
                this._resyncTick();
                this._updateUI();
            }
            return data;
        } catch(e) { return null; }
    },

    start() { return this._apiCall('start'); },
    pause() { return this._apiCall('pause'); },
    end()   { return this._apiCall('end');   },

    _syncFromServer(data) {
        // Nur eigene Snapshots akzeptieren (socket filtert discordId schon upstream)
        if (!data || typeof data !== 'object') return;
        this._shift = data;
        this._resyncTick();
        this._updateUI();
    },

    _resyncTick() {
        const state = this._shift?.state || 'off';
        if (state === 'off') { this._stopTick(); }
        else { this._startTick(); }
    },

    _startTick() {
        this._stopTick();
        this._tickInterval = setInterval(() => this._updateUI(), 1000);
    },
    _stopTick() { if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; } },

    _liveTotals() {
        const s = this._shift;
        if (!s) return { activeMs: 0, breakMs: 0 };
        const now = Date.now();
        let activeMs = s.savedMs || 0;
        if (s.state === 'active' && s.startedAt) activeMs += Math.max(0, now - s.startedAt);
        let breakMs = s.breakMs || 0;
        if (s.state === 'break' && s.breakStartedAt) breakMs += Math.max(0, now - s.breakStartedAt);
        return { activeMs, breakMs };
    },

    _updateUI() {
        const state = this._shift?.state || 'off';
        const { activeMs, breakMs } = this._liveTotals();

        const h = Math.floor(activeMs / 3600000);
        const m = Math.floor((activeMs % 3600000) / 60000);
        const s = Math.floor((activeMs % 60000) / 1000);
        const timeStr = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

        const timer = document.getElementById('ovShiftTimer');
        const label = document.getElementById('ovShiftState');
        const btnStart = document.getElementById('ovBtnStart');
        const btnPause = document.getElementById('ovBtnPause');
        const btnEnd = document.getElementById('ovBtnEnd');

        if (timer) timer.textContent = timeStr;
        if (label) label.textContent = state === 'active' ? 'On Duty' : state === 'break' ? 'Pause' : 'Off Duty';
        if (btnStart) btnStart.disabled = state === 'active';
        if (btnPause) btnPause.disabled = state !== 'active';
        if (btnEnd) btnEnd.disabled = state === 'off';

        this._renderPauseSubTimer(state, breakMs);
    },

    _renderPauseSubTimer(state, breakMs) {
        const timer = document.getElementById('ovShiftTimer');
        if (!timer) return;
        // Anker: panel-info-card (die Card die State + Timer enthaelt) — dadurch landet der Sub-Timer UNTER der Card, nicht daneben
        const anchor = timer.closest('.panel-info-card') || timer;
        // pauseCount vom Server zaehlt beendete Pausen — die laufende Pause ist #(count+1)
        const pauseNumber = (this._shift?.pauseCount || 0) + (state === 'break' ? 1 : 0);
        let sub = document.getElementById('ovShiftPauseSub');
        if (state !== 'break') {
            if (sub) { sub.classList.remove('visible'); setTimeout(() => sub?.remove(), 400); }
            return;
        }
        if (!sub) {
            sub = document.createElement('div');
            sub.id = 'ovShiftPauseSub';
            sub.style.cssText = 'display:flex;align-items:center;gap:7px;margin-top:0;padding:5px 10px;width:fit-content;font-size:10px;font-weight:500;color:rgba(255,255,255,0.88);background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:9px;letter-spacing:0.02em;opacity:0;max-height:0;overflow:hidden;transform:translateY(-4px);transition:opacity 0.35s ease, max-height 0.35s ease, transform 0.35s ease, margin-top 0.35s ease;';
            sub.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color:rgba(255,255,255,0.75);flex-shrink:0;animation:ov-pause-pulse 2.4s ease-in-out infinite;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span style="color:rgba(255,255,255,0.55);font-weight:600;letter-spacing:0.04em;text-transform:uppercase;font-size:9px;">Pause</span><span class="ov-pause-time" style="color:#fff;font-family:ui-monospace,monospace;font-weight:600;">0 s</span><span class="ov-pause-count-sep" style="color:rgba(255,255,255,0.2);">·</span><span class="ov-pause-count" style="color:rgba(255,255,255,0.65);font-weight:500;">#0</span>';
            anchor.insertAdjacentElement('afterend', sub);
            if (!document.getElementById('ov-pause-keyframes')) {
                const st = document.createElement('style');
                st.id = 'ov-pause-keyframes';
                st.textContent = '@keyframes ov-pause-pulse{0%,100%{opacity:0.55}50%{opacity:1}} #ovShiftPauseSub.visible{opacity:1;max-height:40px;transform:translateY(0);margin-top:6px;}';
                document.head.appendChild(st);
            }
            requestAnimationFrame(() => sub.classList.add('visible'));
        }
        const mins = Math.floor(breakMs / 60000);
        const secs = Math.floor((breakMs % 60000) / 1000);
        const timeStr = mins >= 1 ? `${mins} Min ${String(secs).padStart(2,'0')} s` : `${secs} s`;
        const t = sub.querySelector('.ov-pause-time');
        if (t) t.textContent = timeStr;
        const c = sub.querySelector('.ov-pause-count');
        if (c) c.textContent = `#${pauseNumber}`;
    },

    async loadFromServer() {
        const session = JSON.parse(localStorage.getItem('en_session') || 'null');
        const discordId = session?.user?.discordId;
        if (!discordId) return;
        try {
            const res = await fetch(`${OVL_CONFIG.API_URL}/api/shifts?discordId=${encodeURIComponent(discordId)}`, {
                headers: { 'x-api-key': 'emden-super-secret-key-2026' },
            });
            const data = await res.json();
            if (data.success && data.shifts[discordId]) {
                this._shift = data.shifts[discordId];
                this._resyncTick();
                this._updateUI();
            }
        } catch(e) {}
    },
};

window.OverlayShift = OverlayShift;

// ════════════════════════════════════════════════════════════════
// TIKTOK LIVE — Chat/Gifts/Likes/Follows im Overlay
// ════════════════════════════════════════════════════════════════
const TikTokCtrl = (() => {
    const STORAGE_KEY = 'tiktok-last-username';
    const SETTINGS_KEY = 'tiktok-settings-v1';
    let open = false;
    let settingsOpen = false;
    let connected = false;
    let username = '';
    let viewerCount = 0;
    let maxMessages = 150;
    let settings = {
        showChat: true,
        showGift: true,
        showLike: true,
        showFollow: true,
        showMember: false,
        smallFont: false,
        soundGift: false,
        alpha: 42,
        max: 150,
    };

    function $(id) { return document.getElementById(id); }

    function escapeHtml(s) {
        if (typeof s !== 'string') return '';
        return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function setStatus(text, cls) {
        const el = $('tt-status');
        if (!el) return;
        if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
        el.style.display = 'block';
        el.textContent = text;
        el.className = 'tt-status' + (cls ? ' ' + cls : '');
    }

    function setViewer(count) {
        viewerCount = count;
        const el = $('tt-viewer-count');
        if (el) el.textContent = count ? `· ${count} viewer` : '';
    }

    function toggle() {
        const panel = $('tiktok-slide');
        if (!panel) return;
        open = !open;
        panel.classList.toggle('open', open);
        if (open) {
            // Letzten Username laden
            try {
                const last = localStorage.getItem(STORAGE_KEY);
                const input = $('tt-username-input');
                if (last && input && !input.value) input.value = last;
                if (input) setTimeout(() => input.focus(), 200);
            } catch(_) {}
        }
    }

    async function connect() {
        const input = $('tt-username-input');
        const btn = $('tt-connect-btn');
        const uname = (input?.value || '').trim().replace(/^@/, '');
        if (!uname) { setStatus('Username eingeben.', 'err'); return; }
        if (!window.electronAPI?.tiktokConnect) { setStatus('electronAPI fehlt.', 'err'); return; }

        if (connected) {
            // Bereits verbunden → disconnect
            window.electronAPI.tiktokDisconnect?.();
            connected = false;
            setStatus('Getrennt.', '');
            if (btn) { btn.textContent = 'Verbinden'; btn.classList.remove('disconnect'); }
            setViewer(0);
            const trigger = $('tiktok-trigger');
            if (trigger) trigger.classList.remove('live');
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Verbinde...'; }
        setStatus('Suche Live-Stream von @' + uname + '...', '');

        try {
            const r = await window.electronAPI.tiktokConnect(uname);
            if (!r || !r.ok) {
                setStatus('Fehler: ' + (r?.error || 'Unbekannt'), 'err');
                if (btn) { btn.disabled = false; btn.textContent = 'Verbinden'; }
                return;
            }
            connected = true;
            username = r.username;
            setViewer(r.viewerCount || 0);
            setStatus('LIVE · @' + r.username + (r.viewerCount ? ' · ' + r.viewerCount + ' Viewer' : ''), 'live');
            if (btn) { btn.disabled = false; btn.textContent = 'Trennen'; btn.classList.add('disconnect'); }
            try { localStorage.setItem(STORAGE_KEY, uname); } catch(_) {}
            // Feed leeren (bis auf Welcome)
            const feed = $('tt-feed');
            if (feed) {
                feed.innerHTML = '';
                addSystemMsg('Verbunden mit @' + r.username);
            }
            const trigger = $('tiktok-trigger');
            if (trigger) trigger.classList.add('live');
        } catch(e) {
            setStatus('Fehler: ' + (e.message || e), 'err');
            if (btn) { btn.disabled = false; btn.textContent = 'Verbinden'; }
        }
    }

    function addSystemMsg(text) {
        const feed = $('tt-feed');
        if (!feed) return;
        const div = document.createElement('div');
        div.className = 'tt-msg member';
        div.innerHTML = `<div class="tt-ava">·</div><div class="tt-msg-body"><div class="tt-msg-text" style="font-size:10px;opacity:.7;">${escapeHtml(text)}</div></div>`;
        feed.appendChild(div);
        trimFeed();
        feed.scrollTop = feed.scrollHeight;
    }

    function avatarHtml(url, name) {
        if (url) return `<img src="${escapeHtml(url)}" alt="" onerror="this.remove()">`;
        const init = (name || '?').trim().charAt(0).toUpperCase();
        return `<div class="tt-ava">${escapeHtml(init)}</div>`;
    }

    function addEvent(payload) {
        const feed = $('tt-feed');
        if (!feed) return;
        const { type, data } = payload;
        const name = data?.nickname || data?.uniqueId || 'User';
        let html = '';
        switch (type) {
            case 'chat':
                html = `<div class="tt-msg">
                    ${avatarHtml(data.profilePictureUrl, name)}
                    <div class="tt-msg-body">
                        <div class="tt-msg-name">${escapeHtml(name)}</div>
                        <div class="tt-msg-text">${escapeHtml(data.comment || '')}</div>
                    </div>
                </div>`;
                break;
            case 'gift':
                html = `<div class="tt-msg gift">
                    ${avatarHtml(data.profilePictureUrl, name)}
                    <div class="tt-msg-body">
                        <div class="tt-msg-name">🎁 ${escapeHtml(name)}</div>
                        <div class="tt-msg-text">${escapeHtml(data.giftName || 'Gift')} ×${data.repeatCount || 1}${data.diamondCount ? ` <span class="tt-msg-meta">${data.diamondCount * (data.repeatCount||1)} 💎</span>` : ''}</div>
                    </div>
                </div>`;
                break;
            case 'like':
                html = `<div class="tt-msg like">
                    ${avatarHtml(data.profilePictureUrl, name)}
                    <div class="tt-msg-body">
                        <div class="tt-msg-name">❤️ ${escapeHtml(name)}</div>
                        <div class="tt-msg-text">hat ${data.likeCount || 1} Like${(data.likeCount||1) > 1 ? 's' : ''} gegeben${data.totalLikeCount ? ` <span class="tt-msg-meta">(total: ${data.totalLikeCount})</span>` : ''}</div>
                    </div>
                </div>`;
                break;
            case 'follow':
                html = `<div class="tt-msg follow">
                    ${avatarHtml(data.profilePictureUrl, name)}
                    <div class="tt-msg-body">
                        <div class="tt-msg-name">+ ${escapeHtml(name)}</div>
                        <div class="tt-msg-text">folgt jetzt!</div>
                    </div>
                </div>`;
                break;
            case 'member':
                html = `<div class="tt-msg member">
                    ${avatarHtml(data.profilePictureUrl, name)}
                    <div class="tt-msg-body">
                        <div class="tt-msg-name">${escapeHtml(name)}</div>
                        <div class="tt-msg-text" style="font-size:10px;opacity:.7;">ist dem Live beigetreten</div>
                    </div>
                </div>`;
                break;
            case 'viewer':
                setViewer(data.viewerCount || 0);
                return;
            case 'end':
                connected = false;
                setStatus('Stream beendet.', 'err');
                addSystemMsg('Live-Stream wurde beendet.');
                const trigger = $('tiktok-trigger');
                if (trigger) trigger.classList.remove('live');
                const btn = $('tt-connect-btn');
                if (btn) { btn.textContent = 'Verbinden'; btn.classList.remove('disconnect'); }
                return;
            case 'disconnected':
                connected = false;
                setStatus('Verbindung getrennt.', 'err');
                return;
        }
        if (html) {
            const wrap = document.createElement('div');
            wrap.innerHTML = html;
            const el = wrap.firstElementChild;
            feed.appendChild(el);
            trimFeed();
            // Auto-scroll nur wenn schon unten
            const nearBottom = (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 80;
            if (nearBottom) feed.scrollTop = feed.scrollHeight;
        }
    }

    function trimFeed() {
        const feed = $('tt-feed');
        if (!feed) return;
        while (feed.children.length > maxMessages) {
            feed.removeChild(feed.firstElementChild);
        }
    }

    // Settings ──────────────────────────────────────────────────
    function loadSettings() {
        try {
            const raw = localStorage.getItem(SETTINGS_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                Object.assign(settings, saved);
            }
        } catch(_) {}
    }

    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch(_) {}
    }

    function writeSettingsUI() {
        const map = {
            'tt-show-chat':   settings.showChat,
            'tt-show-gift':   settings.showGift,
            'tt-show-like':   settings.showLike,
            'tt-show-follow': settings.showFollow,
            'tt-show-member': settings.showMember,
            'tt-small-font':  settings.smallFont,
            'tt-sound-gift':  settings.soundGift,
        };
        for (const [id, val] of Object.entries(map)) {
            const el = $(id);
            if (el) el.checked = !!val;
        }
        const alpha = $('tt-alpha'); if (alpha) alpha.value = settings.alpha;
        const max = $('tt-max'); if (max) max.value = settings.max;
        applyToDom();
    }

    function readSettingsUI() {
        const get = (id, def) => { const el = $(id); return el ? el.checked : def; };
        settings.showChat   = get('tt-show-chat',   settings.showChat);
        settings.showGift   = get('tt-show-gift',   settings.showGift);
        settings.showLike   = get('tt-show-like',   settings.showLike);
        settings.showFollow = get('tt-show-follow', settings.showFollow);
        settings.showMember = get('tt-show-member', settings.showMember);
        settings.smallFont  = get('tt-small-font',  settings.smallFont);
        settings.soundGift  = get('tt-sound-gift',  settings.soundGift);
        const alpha = $('tt-alpha'); if (alpha) settings.alpha = +alpha.value;
        const max = $('tt-max'); if (max) settings.max = +max.value;
        maxMessages = settings.max;
    }

    function applyToDom() {
        document.body.classList.toggle('tt-hide-chat',   !settings.showChat);
        document.body.classList.toggle('tt-hide-gift',   !settings.showGift);
        document.body.classList.toggle('tt-hide-like',   !settings.showLike);
        document.body.classList.toggle('tt-hide-follow', !settings.showFollow);
        document.body.classList.toggle('tt-hide-member', !settings.showMember);
        document.body.classList.toggle('tt-small-font',  settings.smallFont);
        // Transparenz live auf CSS-Variable
        const panel = $('tiktok-slide');
        if (panel) panel.style.setProperty('--tt-panel-alpha', (settings.alpha / 100).toFixed(2));
        const alphaVal = $('tt-alpha-val'); if (alphaVal) alphaVal.textContent = settings.alpha + '%';
        const maxVal = $('tt-max-val'); if (maxVal) maxVal.textContent = settings.max;
        // Feed trimmen falls neuer Max-Wert niedriger
        trimFeed();
    }

    function applySetting() {
        readSettingsUI();
        applyToDom();
        saveSettings();
    }

    function toggleSettings() {
        const sec = $('tt-settings');
        if (!sec) return;
        settingsOpen = !settingsOpen;
        sec.classList.toggle('open', settingsOpen);
    }

    function playGiftSound() {
        if (!settings.soundGift) return;
        try {
            const snd = document.getElementById('ovStartSound') || new Audio('chirsp.wav');
            snd.volume = 0.3;
            snd.currentTime = 0;
            snd.play().catch(() => {});
        } catch(_) {}
    }

    function setupDragHandle() {
        const handle = $('tt-drag-handle');
        const panel = $('tiktok-slide');
        if (!handle || !panel) return;

        // Gespeicherte Position anwenden
        try {
            const savedTop = parseInt(localStorage.getItem('tiktok-panel-top'), 10);
            if (!isNaN(savedTop) && savedTop >= 50) panel.style.top = savedTop + 'px';
        } catch(_) {}

        let dragging = false;
        let startY = 0;
        let startTop = 140;

        handle.addEventListener('mousedown', (e) => {
            dragging = true;
            startY = e.clientY;
            const cs = getComputedStyle(panel);
            startTop = parseInt(cs.top, 10) || 140;
            // Transition waehrend Drag deaktivieren fuer flues­siges Ziehen
            panel.style.transition = 'none';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            window.electronAPI?.requestOverlayFocus?.(true);
        });

        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const delta = e.clientY - startY;
            let newTop = Math.max(50, Math.min(window.innerHeight - 150, startTop + delta));
            panel.style.top = newTop + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            panel.style.transition = '';
            document.body.style.userSelect = '';
            // Aktuelle Top-Position speichern
            try {
                const cs = getComputedStyle(panel);
                const top = parseInt(cs.top, 10);
                if (!isNaN(top)) localStorage.setItem('tiktok-panel-top', String(top));
            } catch(_) {}
        });
    }

    function init() {
        loadSettings();
        maxMessages = settings.max;
        writeSettingsUI();
        setupDragHandle();
        window.electronAPI?.onTiktokEvent?.((payload) => {
            if (payload?.type === 'gift') playGiftSound();
            addEvent(payload);
        });
        // Enter im Input = Connect
        const input = $('tt-username-input');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); connect(); }
            });
        }
    }

    window.addEventListener('DOMContentLoaded', init);

    return { toggle, connect, toggleSettings, applySetting };
})();

// Expose als Overlay.toggleTiktok / tiktokConnect / etc.
Object.assign(Overlay, {
    toggleTiktok: () => TikTokCtrl.toggle(),
    tiktokConnect: () => TikTokCtrl.connect(),
    tiktokToggleSettings: () => TikTokCtrl.toggleSettings(),
    tiktokApplySetting: () => TikTokCtrl.applySetting(),
});

// ════════════════════════════════════════════════════════════════
// SUPPORT-CASES OVERLAY TOAST — Staff-only, erscheint top-center
// Bei Klick auf "Uebernehmen" ruft /api/support-case/take, Bot moved
// User zu Staff's Voice-Channel (muss in Voice sein).
// ════════════════════════════════════════════════════════════════
const SupportOverlay = (() => {
    const cases = new Map();
    const dismissedIds = new Set(); // Client-seitig per X weggeklickt
    let _forceFocus = false;        // Overlay voll klickbar solange Toast sichtbar

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
        const stack = document.getElementById('supOverlayStack');
        if (!stack) return;
        const visible = Array.from(cases.values()).filter(c => !dismissedIds.has(c.caseId));
        if (visible.length === 0) {
            stack.innerHTML = '';
            if (_forceFocus) {
                window.electronAPI?.requestOverlayFocus?.(false);
                _forceFocus = false;
            }
            return;
        }
        // Focus wird NUR granted wenn Maus tatsaechlich ueber dem Toast ist
        // (via startCursorTracker) — blockt sonst Roblox-Input nicht
        const list = visible.sort((a,b) => a.createdAt - b.createdAt);
        stack.innerHTML = list.map(c => {
            const taken = c.status === 'taken';
            const av = c.avatarUrl
                ? `<img class="sup-ov-avatar" src="${escapeHtml(c.avatarUrl)}" alt="">`
                : `<div class="sup-ov-avatar fallback">${escapeHtml((c.username||'?').charAt(0).toUpperCase())}</div>`;
            return `
                <div class="sup-ov-toast show" data-case-id="${escapeHtml(c.caseId)}">
                    ${av}
                    <div class="sup-ov-body">
                        <div class="sup-ov-title">Support #S-${escapeHtml(c.caseId)}</div>
                        <div class="sup-ov-name">${escapeHtml(c.username)}</div>
                        <div class="sup-ov-meta sup-ov-wait" data-ts="${c.createdAt}">wartet ${secondsAgo(c.createdAt)}${taken ? ' · übernommen' : ''}</div>
                    </div>
                    <button class="sup-ov-btn" ${taken ? 'disabled' : ''} data-case-id="${escapeHtml(c.caseId)}">
                        ${taken ? '✓' : '→ Übernehmen'}
                    </button>
                    <button class="sup-ov-close" data-case-id="${escapeHtml(c.caseId)}" title="Schließen">×</button>
                </div>
            `;
        }).join('');

        // Focus-Grant auf ganzes Toast (groessere Hit-Area, verhindert Click-Loss)
        stack.querySelectorAll('.sup-ov-toast').forEach(toast => {
            toast.addEventListener('mouseenter', () => window.electronAPI?.requestOverlayFocus?.(true));
            toast.addEventListener('mouseleave', () => window.electronAPI?.requestOverlayFocus?.(false));
        });
        // Uebernehmen-Button
        stack.querySelectorAll('.sup-ov-btn').forEach(btn => {
            btn.addEventListener('mousedown', () => window.electronAPI?.requestOverlayFocus?.(true));
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                take(btn.dataset.caseId, btn);
            });
        });
        // X Close-Button
        stack.querySelectorAll('.sup-ov-close').forEach(btn => {
            btn.addEventListener('mousedown', () => window.electronAPI?.requestOverlayFocus?.(true));
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                dismissedIds.add(btn.dataset.caseId);
                render();
            });
        });
    }

    function tickTimes() {
        document.querySelectorAll('.sup-ov-wait').forEach(el => {
            const ts = parseInt(el.dataset.ts, 10);
            if (!isNaN(ts)) {
                const sCase = cases.get(el.closest('.sup-ov-toast')?.dataset.caseId);
                const taken = sCase && sCase.status === 'taken';
                el.textContent = 'wartet ' + secondsAgo(ts) + (taken ? ' · übernommen' : '');
            }
        });
    }

    function showInlineError(caseId, msg) {
        const toast = document.querySelector(`.sup-ov-toast[data-case-id="${caseId}"]`);
        if (!toast) return;
        let errEl = toast.querySelector('.sup-ov-err');
        if (!errEl) {
            errEl = document.createElement('div');
            errEl.className = 'sup-ov-err';
            errEl.style.cssText = 'position:absolute;bottom:-24px;left:0;right:0;background:rgba(220,40,40,.85);color:#fff;padding:4px 10px;border-radius:8px;font-size:10px;font-weight:600;text-align:center;backdrop-filter:blur(8px);';
            toast.appendChild(errEl);
        }
        errEl.textContent = msg;
        clearTimeout(toast._errTimer);
        toast._errTimer = setTimeout(() => { errEl?.remove(); }, 5000);
    }

    function playTookAnimation(caseId, byText) {
        const toast = document.querySelector(`.sup-ov-toast[data-case-id="${caseId}"]`);
        if (!toast) return;
        toast.classList.add('took');
        // Overlay-Badge (Checkmark + Text)
        const badge = document.createElement('div');
        badge.className = 'sup-ov-took-badge';
        badge.innerHTML = `
            <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>${byText || 'Übernommen!'}</span>
        `;
        toast.appendChild(badge);
        // Fade-out nach 2s
        setTimeout(() => {
            toast.classList.add('fading-out');
            setTimeout(() => {
                dismissedIds.add(caseId);
                render();
            }, 600);
        }, 2000);
    }

    function getMyDiscordId() {
        // 1) Primary: aus URL-Param (Overlay.getDiscordId)
        let id = window.Overlay && Overlay.getDiscordId ? Overlay.getDiscordId() : null;
        if (id) return id;
        // 2) Fallback: aus localStorage (gesetzt beim Dashboard-Login)
        try {
            const session = JSON.parse(localStorage.getItem('en_session') || 'null');
            if (session?.user?.discordId) return session.user.discordId;
        } catch(_) {}
        return null;
    }

    async function take(caseId, btn) {
        console.log('[SupportOverlay] take() called for', caseId);
        const myId = getMyDiscordId();
        console.log('[SupportOverlay] discordId:', myId);
        if (!myId) { showInlineError(caseId, 'Keine Discord-ID gefunden — bitte Dashboard-Login prüfen.'); return; }
        if (btn) { btn.disabled = true; btn.textContent = '...'; }
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/support-case/take`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ caseId, discordId: myId }),
            });
            const d = await r.json().catch(()=>({}));
            console.log('[SupportOverlay] take response:', r.status, d);
            if (!r.ok || !d.ok) {
                if (btn) { btn.disabled = false; btn.textContent = '→ Übernehmen'; }
                showInlineError(caseId, d.error || ('HTTP ' + r.status));
                return;
            }
            // Success → animate + dismiss
            playTookAnimation(caseId, `✓ ${d.userName || 'User'} → ${d.movedToChannelName || 'Support'}`);
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = '→ Übernehmen'; }
            console.error('[SupportOverlay] take error:', e);
            showInlineError(caseId, 'Netzwerk-Fehler: ' + (e.message || e));
        }
    }

    function add(c) {
        if (!c || !c.caseId) return;
        cases.set(c.caseId, c);
        render();
    }
    function update(c) {
        if (!c || !c.caseId) return;
        const prev = cases.get(c.caseId);
        cases.set(c.caseId, { ...(prev || {}), ...c });
        render();
        // Wenn STATUS gerade auf 'taken' gewechselt hat und Toast noch sichtbar ist
        // → Animation abspielen (z.B. ein anderer Staff hat uebernommen)
        if (c.status === 'taken' && !dismissedIds.has(c.caseId)) {
            // Warten bis DOM gerendert ist, dann Animation
            setTimeout(() => {
                playTookAnimation(c.caseId, `✓ Übernommen von ${c.takenByName || 'Staff'}`);
            }, 50);
        }
    }
    function remove(caseId) {
        if (!caseId) return;
        cases.delete(caseId);
        dismissedIds.delete(caseId);
        render();
    }

    async function loadInitial() {
        const myId = getMyDiscordId();
        console.log('[SupportOverlay] loadInitial — isStaff:', window._isStaff, '· discordId:', myId);
        if (!myId) return;
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/support-cases/open?discordId=${encodeURIComponent(myId)}`, {
                headers: { 'x-api-key': 'emden-super-secret-key-2026' },
            });
            console.log('[SupportOverlay] loadInitial response:', r.status);
            if (!r.ok) return;
            const d = await r.json();
            console.log('[SupportOverlay] loadInitial cases:', d.cases?.length || 0);
            if (Array.isArray(d.cases)) {
                d.cases.forEach(c => cases.set(c.caseId, c));
                render();
            }
        } catch (e) {
            console.warn('[SupportOverlay] loadInitial error:', e.message);
        }
    }

    // Debug-Funktion: Test-Case erzeugen ohne Bot (nur um UI zu verifizieren)
    function _testFake() {
        add({
            caseId: 'TEST' + Math.floor(Math.random() * 1000),
            userId: '000',
            username: 'TEST User',
            avatarUrl: null,
            createdAt: Date.now(),
            status: 'open',
        });
        console.log('[SupportOverlay] Test-Case gespawnt. Sollte oben-zentral sichtbar sein.');
    }

    // Cursor-Tracker: gibt Focus nur frei wenn Maus im Toast-Bereich ist (+ 40px Buffer).
    // So bleibt Roblox-Input normal nutzbar wenn User nicht interagieren will.
    function startCursorTracker() {
        const BUFFER = 40; // Pixels rund um den Toast — Focus schon granted kurz vor Kontakt
        document.addEventListener('mousemove', (e) => {
            const stack = document.getElementById('supOverlayStack');
            if (!stack) return;
            const toasts = stack.querySelectorAll('.sup-ov-toast');
            if (toasts.length === 0) {
                if (_forceFocus) {
                    window.electronAPI?.requestOverlayFocus?.(false);
                    _forceFocus = false;
                }
                return;
            }
            let over = false;
            for (const t of toasts) {
                const r = t.getBoundingClientRect();
                if (e.clientX >= r.left - BUFFER && e.clientX <= r.right + BUFFER &&
                    e.clientY >= r.top - BUFFER  && e.clientY <= r.bottom + BUFFER) {
                    over = true; break;
                }
            }
            if (over && !_forceFocus) {
                window.electronAPI?.requestOverlayFocus?.(true);
                _forceFocus = true;
            } else if (!over && _forceFocus) {
                window.electronAPI?.requestOverlayFocus?.(false);
                _forceFocus = false;
            }
        });
    }

    function init() {
        setInterval(tickTimes, 1000);
        setTimeout(loadInitial, 3500);
        startCursorTracker();
    }

    return { init, add, update, remove, render, loadInitial, _testFake };
})();
window.SupportOverlay = SupportOverlay;
// Debug: window._testSupport() → fake Case spawnen
window._testSupport = () => SupportOverlay._testFake();

// ════════════════════════════════════════════════════════════════
// TICKET SYSTEM v2 — Single Overlay, View-State-Machine
// Views: list / detail / settings  +  confirm-close modal layer
// ════════════════════════════════════════════════════════════════
const TicketCtrl = (() => {
    const SETTINGS_KEY = 'ticket-overlay-settings-v1';
    const DEFAULTS = { side: 'right', top: 0, bottom: 0, width: 440, alpha: 92 };

    let allTickets = [];           // [{channelId, channelName, category, creator..., claim, ...}]
    let myDiscordId = null;
    let view = 'list';             // 'list' | 'detail' | 'settings'
    let currentChannelId = null;   // bei 'detail' aktiv
    let chatMessages = [];
    let chatClaim = null;
    let pendingConfirm = null;     // { kind: 'close', channelId } für Confirm-Layer
    let settings = { ...DEFAULTS };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        if (typeof s !== 'string') return '';
        return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function getMyDiscordId() {
        if (myDiscordId) return myDiscordId;
        let id = window.Overlay && Overlay.getDiscordId ? Overlay.getDiscordId() : null;
        if (!id) {
            try { const s = JSON.parse(localStorage.getItem('en_session') || 'null'); if (s?.user?.discordId) id = s.user.discordId; } catch(_) {}
        }
        myDiscordId = id;
        return id;
    }
    function isStaff() { return !!window._isStaff; }
    function timeAgo(ts) {
        if (!ts) return '';
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60) return 'gerade';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        if (s < 86400) return Math.floor(s / 3600) + 'h';
        return Math.floor(s / 86400) + 'd';
    }

    // ─── SETTINGS ─────────────────────────────────────────
    function loadSettings() {
        try {
            const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
            if (raw) settings = { ...DEFAULTS, ...raw };
        } catch(_) {}
        applySettingsToDOM();
    }
    function saveSettings() {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch(_) {}
    }
    function applySettingsToDOM() {
        const root = document.documentElement.style;
        root.setProperty('--tk-panel-alpha', String(Math.max(0, Math.min(100, settings.alpha)) / 100));
        root.setProperty('--tk-panel-top', settings.top + 'px');
        root.setProperty('--tk-panel-bottom', settings.bottom + 'px');
        root.setProperty('--tk-panel-width', settings.width + 'px');
        const ov = $('ticket-overlay');
        if (ov) ov.classList.toggle('side-left', settings.side === 'left');
        // Sync UI
        const top = $('tk-set-top'), bot = $('tk-set-bot'), w = $('tk-set-w'), a = $('tk-set-alpha');
        if (top) { top.value = settings.top; const v = $('tk-set-top-val'); if (v) v.textContent = settings.top; }
        if (bot) { bot.value = settings.bottom; const v = $('tk-set-bot-val'); if (v) v.textContent = settings.bottom; }
        if (w)   { w.value = settings.width; const v = $('tk-set-w-val'); if (v) v.textContent = settings.width; }
        if (a)   { a.value = settings.alpha; const v = $('tk-set-alpha-val'); if (v) v.textContent = settings.alpha + '%'; }
        document.querySelectorAll('.tk-set-tog').forEach(b => b.classList.toggle('active', b.dataset.side === settings.side));
    }
    function setSide(side) { settings.side = side; saveSettings(); applySettingsToDOM(); }
    function setTop(v) { settings.top = parseInt(v) || 0; saveSettings(); applySettingsToDOM(); }
    function setBottom(v) { settings.bottom = parseInt(v) || 0; saveSettings(); applySettingsToDOM(); }
    function setWidth(v) { settings.width = parseInt(v) || 440; saveSettings(); applySettingsToDOM(); }
    function setAlpha(v) { settings.alpha = parseInt(v) || 92; saveSettings(); applySettingsToDOM(); }
    function resetSettings() { settings = { ...DEFAULTS }; saveSettings(); applySettingsToDOM(); }

    // ─── OVERLAY OPEN/CLOSE/VIEW ──────────────────────────
    function setView(v) {
        view = v;
        const ov = $('ticket-overlay');
        if (!ov) return;
        ov.dataset.view = v;
        // Back-Button anzeigen wenn nicht 'list'
        const back = $('tk-back');
        if (back) back.style.display = (v === 'list') ? 'none' : 'flex';
        // Title anpassen
        const title = $('tk-title');
        if (title) {
            if (v === 'list') title.textContent = 'Tickets';
            else if (v === 'settings') title.textContent = 'Einstellungen';
            else if (v === 'detail') {
                const t = allTickets.find(x => x.channelId === currentChannelId);
                title.textContent = t ? '#' + t.channelName : 'Ticket';
            }
        }
        // View-Toggle (CSS macht das, aber wir setzen .active für Animation)
        document.querySelectorAll('#ticket-overlay .tk-view').forEach(el => el.classList.remove('active'));
        const target = $('tk-view-' + v);
        if (target) target.classList.add('active');
    }
    function open() {
        const ov = $('ticket-overlay');
        if (!ov) return;
        // Andere Panels schliessen damit nichts uebereinander stapelt
        try {
            const mod = document.getElementById('mod-slide');
            if (mod && mod.classList.contains('open') && window.Overlay?.toggleModSlide) Overlay.toggleModSlide();
            const gsg9 = document.getElementById('gsg9-slide');
            if (gsg9 && gsg9.classList.contains('open') && window.Overlay?.toggleGSG9) Overlay.toggleGSG9();
            const tt = document.getElementById('tiktok-slide');
            if (tt && tt.classList.contains('open') && window.Overlay?.toggleTiktok) Overlay.toggleTiktok();
        } catch(_) {}
        ov.classList.add('open');
        setView('list');
        loadAll();
    }
    function close() {
        const ov = $('ticket-overlay');
        if (!ov) return;
        ov.classList.remove('open');
        ov.classList.remove('confirm-active');
        // Mouse-Leak-Schutz: kurz Focus halten damit click nicht zu Roblox durchschlaegt
        setTimeout(() => {
            if (window.electronAPI?.requestOverlayFocus && _focusGranted) {
                window.electronAPI.requestOverlayFocus(false);
                _focusGranted = false;
            }
        }, 80);
        // Zurück zu list als Default
        setTimeout(() => { setView('list'); }, 400);
    }
    function toggle() {
        const ov = $('ticket-overlay');
        if (!ov) return;
        if (ov.classList.contains('open')) close();
        else open();
    }
    function back() {
        if (view === 'detail' || view === 'settings') {
            currentChannelId = null;
            chatMessages = [];
            chatClaim = null;
            setView('list');
            loadAll();
        } else {
            close();
        }
    }
    function openSettings() { setView('settings'); }

    // ─── DATA: ALL TICKETS ────────────────────────────────
    async function loadAll() {
        const myId = getMyDiscordId();
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/tickets/all?discordId=${encodeURIComponent(myId || '')}`, {
                headers: { 'x-api-key': 'emden-super-secret-key-2026' },
            });
            if (!r.ok) {
                $('tk-list-scroll').innerHTML = `<div class="tk-list-empty">Fehler: HTTP ${r.status}</div>`;
                return;
            }
            const d = await r.json();
            allTickets = d.items || [];
            updateBadge();
            if (view === 'list') renderList();
        } catch(e) {
            const s = $('tk-list-scroll');
            if (s) s.innerHTML = `<div class="tk-list-empty">Fehler: ${esc(e.message || String(e))}</div>`;
        }
    }
    function updateBadge() {
        const trig = $('tickets-trigger');
        const badge = $('tickets-badge');
        const count = $('tickets-count');
        const myId = getMyDiscordId();
        const total = allTickets.length;
        const mine = allTickets.filter(t => t.claim?.claimerDiscordId === myId).length;
        if (trig) trig.classList.toggle('has-claims', total > 0);
        if (badge) { badge.textContent = String(mine); badge.style.display = mine > 0 ? 'flex' : 'none'; }
        if (count) count.textContent = String(total);
    }

    // ─── LIST RENDER ──────────────────────────────────────
    function renderList() {
        const root = $('tk-list-scroll');
        if (!root) return;
        if (!allTickets || allTickets.length === 0) {
            root.innerHTML = '<div class="tk-list-empty">Keine offenen Tickets</div>';
            return;
        }
        const myId = getMyDiscordId();
        const mine = allTickets.filter(t => t.claim?.claimerDiscordId === myId);
        const others = allTickets.filter(t => t.claim?.claimerDiscordId !== myId);
        // Gruppiere others nach Kategorie
        const byCat = new Map();
        for (const t of others) {
            const cat = t.category || 'Allgemein';
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(t);
        }
        const cats = Array.from(byCat.keys()).sort();
        let html = '';
        if (mine.length > 0) {
            html += `<div class="tk-cat">
                <div class="tk-cat-title">📌 Meine Tickets <span class="tk-cat-count">${mine.length}</span></div>
                <div class="tk-cat-list">${mine.map(t => itemHtml(t, true, myId)).join('')}</div>
            </div>`;
        }
        for (const cat of cats) {
            const items = byCat.get(cat);
            html += `<div class="tk-cat">
                <div class="tk-cat-title">${esc(cat)} <span class="tk-cat-count">${items.length}</span></div>
                <div class="tk-cat-list">${items.map(t => itemHtml(t, false, myId)).join('')}</div>
            </div>`;
        }
        root.innerHTML = html;
    }
    function itemHtml(t, isMine, myId) {
        const claim = t.claim;
        let status = 'open', statusText = 'OFFEN';
        if (claim) {
            if (claim.claimerDiscordId === myId) { status = 'mine'; statusText = '✓ MEINS'; }
            else { status = 'claimed'; statusText = claim.claimerName ? esc(claim.claimerName) : 'CLAIMED'; }
        }
        const ava = t.creatorAvatar
            ? `<img class="tk-item-ava" src="${esc(t.creatorAvatar)}" onerror="this.outerHTML='<div class=\\'tk-item-ava\\'>?</div>'">`
            : `<div class="tk-item-ava">${esc((t.creatorName || '?').charAt(0).toUpperCase())}</div>`;
        const meta = (t.creatorName ? esc(t.creatorName) + ' · ' : '') + timeAgo(t.lastMessageAt || t.createdAt);
        return `
            <div class="tk-item ${isMine ? 'mine' : ''}" data-channel-id="${esc(t.channelId)}" onclick="event.stopPropagation();Overlay.tkOpenDetail('${esc(t.channelId)}')">
                ${ava}
                <div class="tk-item-body">
                    <div class="tk-item-name">#${esc(t.channelName)}</div>
                    <div class="tk-item-meta">${meta}</div>
                </div>
                <div class="tk-item-status ${status}">${statusText}</div>
            </div>`;
    }

    // ─── DETAIL VIEW (Chat) ───────────────────────────────
    async function openDetail(channelId) {
        currentChannelId = channelId;
        chatMessages = [];
        const t = allTickets.find(x => x.channelId === channelId);
        chatClaim = t?.claim || null;
        setView('detail');
        // Banner + Actions sofort rendern (mit aktuellem Stand)
        renderBanner();
        renderActions();
        // History laden
        const feed = $('tk-feed');
        if (feed) feed.innerHTML = '<div class="tk-list-empty">Lade Verlauf...</div>';
        const myId = getMyDiscordId();
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/ticket/history?channelId=${encodeURIComponent(channelId)}&discordId=${encodeURIComponent(myId)}`, {
                headers: { 'x-api-key': 'emden-super-secret-key-2026' },
            });
            if (!r.ok) {
                if (feed) feed.innerHTML = `<div class="tk-list-empty">Fehler: HTTP ${r.status}</div>`;
                return;
            }
            const d = await r.json();
            chatClaim = d.claim || chatClaim;
            chatMessages = d.messages || [];
            if (feed) feed.innerHTML = '';
            for (const m of chatMessages) appendMsg(m, false);
            renderBanner();
            scrollFeed();
        } catch(e) {
            if (feed) feed.innerHTML = `<div class="tk-list-empty">Fehler: ${esc(e.message || String(e))}</div>`;
        }
    }
    function renderBanner() {
        const banner = $('tk-claim-banner');
        if (!banner) return;
        const myId = getMyDiscordId();
        if (!chatClaim) {
            banner.style.display = 'block';
            banner.className = 'tk-claim-banner unclaimed';
            banner.textContent = '⚠ Noch nicht geclaimt — du kannst es übernehmen';
        } else if (chatClaim.claimerDiscordId === myId) {
            banner.style.display = 'block';
            banner.className = 'tk-claim-banner claimed-self';
            banner.textContent = '✓ Du bearbeitest dieses Ticket';
        } else {
            banner.style.display = 'block';
            banner.className = 'tk-claim-banner claimed-other';
            banner.textContent = `Geclaimt von ${chatClaim.claimerName || '?'} — du kannst lesen/schreiben`;
        }
    }
    function renderActions() {
        const row = $('tk-actions-row');
        if (!row) return;
        const myId = getMyDiscordId();
        const isMine = chatClaim && chatClaim.claimerDiscordId === myId;
        const isClaimed = !!chatClaim;
        let html = '';
        if (!isClaimed) {
            html += `<button class="tk-act-btn primary" onclick="Overlay.tkClaim()">✅ Claimen</button>`;
        }
        if (isMine) {
            html += `<button class="tk-act-btn warn" onclick="Overlay.tkTransfer()">↪️ Übergeben</button>`;
            html += `<button class="tk-act-btn danger" onclick="Overlay.tkAskClose()">🔒 Schließen</button>`;
        }
        row.innerHTML = html;
    }
    function appendMsg(m, animate) {
        const feed = $('tk-feed');
        if (!feed) return;
        const myId = getMyDiscordId();
        const isSelf = m.authorId === myId;
        const isBot = !!m.authorIsBot;
        const ava = m.authorAvatar
            ? `<img src="${esc(m.authorAvatar)}" onerror="this.outerHTML='<div class=\\'tk-ava\\'>?</div>'">`
            : `<div class="tk-ava">${esc((m.authorName || '?').charAt(0).toUpperCase())}</div>`;
        const time = m.ts ? new Date(m.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
        const atts = (m.attachments || []).map(a => `<a class="tk-msg-att" target="_blank" href="${esc(a.url)}">📎 ${esc(a.name || 'Anhang')}</a>`).join(' ');
        const div = document.createElement('div');
        div.className = 'tk-msg' + (isSelf ? ' is-self' : '') + (isBot ? ' is-bot' : '');
        div.dataset.messageId = m.messageId || '';
        div.innerHTML = `
            ${ava}
            <div class="tk-msg-body">
                <div class="tk-msg-name">${esc(m.authorName || 'User')}${isBot ? ' <span style="color:rgba(255,255,255,.3);font-weight:400;">(Bot)</span>' : ''}</div>
                <div class="tk-msg-text">${esc(m.content || '')}</div>
                ${atts ? `<div>${atts}</div>` : ''}
                ${time ? `<div class="tk-msg-time">${time}</div>` : ''}
            </div>`;
        feed.appendChild(div);
    }
    function scrollFeed() {
        const feed = $('tk-feed');
        if (feed) feed.scrollTop = feed.scrollHeight;
    }

    // ─── ACTIONS ──────────────────────────────────────────
    async function send() {
        const input = $('tk-input');
        const btn = $('tk-send');
        if (!input || !currentChannelId) return;
        const text = input.value.trim();
        if (!text) return;
        const myId = getMyDiscordId();
        if (!myId) return showMini('Keine Discord-ID', 'danger');
        if (btn) btn.disabled = true;
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/ticket/reply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ channelId: currentChannelId, discordId: myId, text }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) { showMini('Fehler: ' + (d.error || ('HTTP ' + r.status)), 'danger'); return; }
            input.value = '';
            input.style.height = 'auto';
        } catch(e) {
            showMini('Netzwerk: ' + (e.message || e), 'danger');
        } finally {
            if (btn) btn.disabled = false;
            input.focus();
        }
    }
    async function claim() {
        if (!currentChannelId) return;
        const myId = getMyDiscordId();
        if (!myId) return showMini('Keine Discord-ID', 'danger');
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/ticket/claim`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ channelId: currentChannelId, discordId: myId }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) { showMini('Fehler: ' + (d.error || ('HTTP ' + r.status)), 'danger'); return; }
            chatClaim = d.claim || chatClaim;
            renderBanner();
            renderActions();
            showMini('Ticket geclaimt ✓', 'success');
        } catch(e) {
            showMini('Netzwerk: ' + (e.message || e), 'danger');
        }
    }
    async function transfer() {
        if (!currentChannelId) return;
        const myId = getMyDiscordId();
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/ticket/transfer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ channelId: currentChannelId, discordId: myId }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) { showMini('Fehler: ' + (d.error || ('HTTP ' + r.status)), 'danger'); return; }
            chatClaim = null;
            renderBanner();
            renderActions();
            showMini('Übernahme freigegeben', 'success');
            back();
        } catch(e) {
            showMini('Netzwerk: ' + (e.message || e), 'danger');
        }
    }
    function askClose() {
        if (!currentChannelId) return;
        pendingConfirm = { kind: 'close', channelId: currentChannelId };
        const ov = $('ticket-overlay');
        if (ov) ov.classList.add('confirm-active');
    }
    function confirmCancel() {
        pendingConfirm = null;
        const ov = $('ticket-overlay');
        if (ov) ov.classList.remove('confirm-active');
    }
    async function confirmOk() {
        if (!pendingConfirm || pendingConfirm.kind !== 'close') return confirmCancel();
        const channelId = pendingConfirm.channelId;
        confirmCancel();
        const myId = getMyDiscordId();
        try {
            const r = await fetch(`${OVL_CONFIG.API_URL}/api/ticket/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ channelId, discordId: myId }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok || !d.ok) { showMini('Fehler: ' + (d.error || ('HTTP ' + r.status)), 'danger'); return; }
            showMini('Ticket schließt in 30s', 'success');
            back();
        } catch(e) {
            showMini('Netzwerk: ' + (e.message || e), 'danger');
        }
    }

    // ─── MINI-NOTIF ───────────────────────────────────────
    function showMini(text, kind) {
        const root = $('ticket-mini-notif');
        if (!root) return;
        const el = document.createElement('div');
        el.className = 'tk-mini ' + (kind || '');
        el.setAttribute('onmouseenter', 'if(window.electronAPI?.overlayRequestFocus)electronAPI.overlayRequestFocus(true)');
        el.setAttribute('onmouseleave', 'if(window.electronAPI?.overlayRequestFocus)electronAPI.overlayRequestFocus(false)');
        const icon = kind === 'danger' ? '⚠' : kind === 'success' ? '✓' : 'ℹ';
        el.innerHTML = `<span class="tk-mini-ico">${icon}</span><span>${esc(text)}</span>`;
        root.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 400);
        }, 3500);
    }

    // ─── ANNOUNCER (top-toast für neue/freie Tickets) ────
    const ANNOUNCE_DURATION_MS = 30 * 1000;
    function showAnnounce(t, withSound) {
        const stack = $('ticket-toast-stack');
        if (!stack || !isStaff()) return;
        // Nicht doppelt anzeigen
        if (stack.querySelector(`[data-ann-channel="${t.channelId}"]`)) return;
        const el = document.createElement('div');
        el.className = 'ticket-toast show';
        el.dataset.annChannel = t.channelId;
        // Inline Focus-Handler — sonst geht der Click ins Leere bei Roblox-Overlay
        el.setAttribute('onmouseenter', 'if(window.electronAPI?.overlayRequestFocus)electronAPI.overlayRequestFocus(true)');
        el.setAttribute('onmouseleave', 'if(window.electronAPI?.overlayRequestFocus)electronAPI.overlayRequestFocus(false)');
        el.innerHTML = `
            <div class="ticket-toast-icon">🎫</div>
            <div class="ticket-toast-body">
                <div class="ticket-toast-title">Neues Ticket</div>
                <div class="ticket-toast-name">#${esc(t.channelName)}</div>
                <div class="ticket-toast-meta">${esc(t.reason || 'Klicke um zu öffnen')}</div>
            </div>
            <div class="ticket-toast-timer">
                <span class="ticket-toast-timer-num">30</span><span style="opacity:.5;">s</span>
                <div class="ticket-toast-timer-bar"><div class="ticket-toast-timer-fill"></div></div>
            </div>
            <button class="ticket-toast-btn" onmousedown="event.stopPropagation();" onclick="event.stopPropagation();Overlay.tkOpenAnn('${esc(t.channelId)}')">→ Öffnen</button>
            <button class="ticket-toast-close" onmousedown="event.stopPropagation();" onclick="event.stopPropagation();this.parentElement.remove();">×</button>`;
        stack.appendChild(el);
        // Countdown-Animation
        const fill = el.querySelector('.ticket-toast-timer-fill');
        const num = el.querySelector('.ticket-toast-timer-num');
        if (fill) {
            // Force reflow then start animation
            requestAnimationFrame(() => {
                fill.style.transition = `width ${ANNOUNCE_DURATION_MS}ms linear`;
                fill.style.width = '0%';
            });
        }
        const startedAt = Date.now();
        const tickInterval = setInterval(() => {
            const remaining = Math.max(0, ANNOUNCE_DURATION_MS - (Date.now() - startedAt));
            if (num) num.textContent = String(Math.ceil(remaining / 1000));
            if (remaining <= 0) clearInterval(tickInterval);
        }, 250);
        if (withSound) {
            try { const a = new Audio('ticketsound.mp3'); a.volume = 0.4; a.play().catch(()=>{}); } catch(_) {}
        }
        setTimeout(() => { clearInterval(tickInterval); el.remove(); }, ANNOUNCE_DURATION_MS);
    }
    function removeAnnounce(channelId) {
        const stack = $('ticket-toast-stack');
        if (!stack) return;
        const el = stack.querySelector(`[data-ann-channel="${channelId}"]`);
        if (el) el.remove();
    }

    // ─── SOCKET HANDLERS ──────────────────────────────────
    function onNewTicket(data) {
        if (!data?.channelId) return;
        showAnnounce({
            channelId: data.channelId,
            channelName: data.channelName || data.ticketId || data.channelId,
            reason: data.reason || ''
        }, true);
        loadAll();
    }
    function onClaimed(data) {
        if (!data?.channelId) return;
        const myId = getMyDiscordId();
        // Update local state
        const t = allTickets.find(x => x.channelId === data.channelId);
        if (t) {
            if (data.claimerDiscordId) {
                t.claim = {
                    claimerDiscordId: data.claimerDiscordId,
                    claimerName: data.claimerName,
                    claimerAvatar: data.claimerAvatar,
                    claimedAt: data.claimedAt,
                };
            } else {
                t.claim = null;
            }
        }
        if (currentChannelId === data.channelId) {
            chatClaim = t?.claim || null;
            renderBanner();
            renderActions();
        }
        if (view === 'list') renderList();
        updateBadge();
        // Announcement-Logik:
        if (data.claimerDiscordId) {
            removeAnnounce(data.channelId);
            if (data.claimerDiscordId === myId) {
                showMini('Du hast das Ticket übernommen', 'success');
            }
        } else {
            // Transfer/Freigabe → wieder als Toast (mit Sound)
            const tk = allTickets.find(x => x.channelId === data.channelId) || { channelId: data.channelId, channelName: data.channelName };
            showAnnounce({
                channelId: tk.channelId,
                channelName: tk.channelName,
                reason: 'Übernahme angefragt'
            }, true);
        }
    }
    function onMessage(payload) {
        if (!payload?.channelId) return;
        // Detail-View aktualisieren
        if (currentChannelId === payload.channelId && view === 'detail') {
            chatMessages.push(payload);
            if (chatMessages.length > 200) chatMessages = chatMessages.slice(-200);
            const feed = $('tk-feed');
            const nearBottom = feed ? (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < 100 : false;
            appendMsg(payload, true);
            if (nearBottom) scrollFeed();
        }
        // Update lastMessageAt für Sortierung
        const t = allTickets.find(x => x.channelId === payload.channelId);
        if (t) t.lastMessageAt = payload.ts || Date.now();
    }
    function onClosed(data) {
        if (!data?.channelId) return;
        allTickets = allTickets.filter(x => x.channelId !== data.channelId);
        removeAnnounce(data.channelId);
        if (currentChannelId === data.channelId) back();
        if (view === 'list') renderList();
        updateBadge();
        // Mini-Notif rechts unten für ALLE
        showMini('Ticket #' + (data.channelName || data.channelId) + ' wurde geschlossen', '');
    }

    // ─── CURSOR-FOCUS-TRACKER ─────────────────────────────
    let _focusGranted = false;
    function trackCursor() {
        document.addEventListener('mousemove', (e) => {
            const ov = $('ticket-overlay');
            const stack = $('ticket-toast-stack');
            const trigger = $('tickets-trigger');
            const mini = $('ticket-mini-notif');
            let over = false;
            const BUFFER = 30;
            const checkRect = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) return false;
                return e.clientX >= r.left - BUFFER && e.clientX <= r.right + BUFFER &&
                       e.clientY >= r.top - BUFFER && e.clientY <= r.bottom + BUFFER;
            };
            if (ov?.classList.contains('open')) { if (checkRect(ov)) over = true; }
            stack?.querySelectorAll('.ticket-toast').forEach(t => { if (checkRect(t)) over = true; });
            if (trigger && checkRect(trigger)) over = true;
            mini?.querySelectorAll('.tk-mini').forEach(t => { if (checkRect(t)) over = true; });
            if (over && !_focusGranted) { window.electronAPI?.requestOverlayFocus?.(true); _focusGranted = true; }
            else if (!over && _focusGranted) { window.electronAPI?.requestOverlayFocus?.(false); _focusGranted = false; }
        });
    }

    // ─── INIT ─────────────────────────────────────────────
    function init() {
        loadSettings();
        const input = $('tk-input');
        if (input) {
            input.addEventListener('input', () => {
                input.style.height = 'auto';
                input.style.height = Math.min(input.scrollHeight, 80) + 'px';
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            });
        }
        // Cursor-Tracker absichtlich entfernt — die inline onmouseenter/leave auf
        // dem Overlay-Element (#ticket-overlay) und dem Trigger reichen.
        // Mehrere Tracker konkurrieren um den Focus-State und revoken sich gegenseitig
        // → Click leakt zur Roblox-Map. Stattdessen verlassen wir uns auf inline-Handler.
        // Beim Start einmal laden — server-side Staff-Check entscheidet was zurueckkommt
        setTimeout(() => loadAll(), 2500);
        setInterval(() => loadAll(), 60000);
    }
    window.addEventListener('DOMContentLoaded', init);

    return {
        // Public API
        open, close, toggle, back, openSettings,
        loadAll,
        openDetail, send, claim, transfer,
        askClose, confirmCancel, confirmOk,
        setSide, setTop, setBottom, setWidth, setAlpha, resetSettings,
        // Socket-Events
        onNewTicket, onClaimed, onMessage, onClosed,
    };
})();
window.TicketCtrl = TicketCtrl;

Object.assign(Overlay, {
    toggleTickets:  () => TicketCtrl.toggle(),
    tkClose:        () => TicketCtrl.close(),
    tkBack:         () => TicketCtrl.back(),
    tkOpenSettings: () => TicketCtrl.openSettings(),
    tkOpenDetail:   (id) => TicketCtrl.openDetail(id),
    tkOpenAnn:      (id) => { TicketCtrl.open(); setTimeout(() => TicketCtrl.openDetail(id), 50); },
    tkSend:         () => TicketCtrl.send(),
    tkClaim:        () => TicketCtrl.claim(),
    tkTransfer:     () => TicketCtrl.transfer(),
    tkAskClose:     () => TicketCtrl.askClose(),
    tkConfirmCancel:() => TicketCtrl.confirmCancel(),
    tkConfirmOk:    () => TicketCtrl.confirmOk(),
    tkSetSide:      (s) => TicketCtrl.setSide(s),
    tkSetTop:       (v) => TicketCtrl.setTop(v),
    tkSetBottom:    (v) => TicketCtrl.setBottom(v),
    tkSetWidth:     (v) => TicketCtrl.setWidth(v),
    tkSetAlpha:     (v) => TicketCtrl.setAlpha(v),
    tkResetSettings:() => TicketCtrl.resetSettings(),
});

// ════════════════════════════════════════════════════════════════
// LEGACY TICKET STUBS (für bestehende onclick-Handler — leer/no-op)
// ════════════════════════════════════════════════════════════════
const _LegacyTicket = {
    onNewTicket: (d) => TicketCtrl.onNewTicket(d),
    onClaimed:   (d) => TicketCtrl.onClaimed(d),
    onMessage:   (d) => TicketCtrl.onMessage(d),
    onClosed:    (d) => TicketCtrl.onClosed(d),
};
window._LegacyTicket = _LegacyTicket;

window.addEventListener('DOMContentLoaded', () => {
    Overlay.init();
    // Load shift state after a short delay (socket needs to connect first)
    setTimeout(() => OverlayShift.loadFromServer(), 2000);
    SupportOverlay.init();
});
