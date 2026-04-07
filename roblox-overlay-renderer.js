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
                // Startsound nur beim ersten Mal (mit Intro zusammen)
                try {
                    const snd = document.getElementById('ovStartSound');
                    if (snd) { snd.currentTime = 0; snd.volume = 0.4; snd.play().catch(() => {}); }
                } catch(e) {}
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
        });

        socket.on('overlay_supporter_count', ({ count }) => setSupporter(count));

        socket.on(`overlay_game_start_${discordId}`, ({ startTime }) => setGameRunning(true, startTime));
        socket.on(`overlay_game_end_${discordId}`,   ()               => setGameRunning(false));

        // Shift sync: wenn jemand anderes (oder Dashboard) shift ändert
        socket.on('shift_update', (data) => {
            if (data.discordId === discordId) OverlayShift._syncFromServer(data.state);
        });

        // Mod-Eintrag: Custom Notification (top, glass, sound)
        socket.on('mod_new_entry', (entry) => {
            showOverlayModNotif(entry);
        });

        // Panic Alert empfangen
        socket.on('panic_alert', (data) => {
            console.log('[PANIC] Alert empfangen:', data.username, data.robloxUsername, '| panicAlert element:', !!document.getElementById('panicAlert'));
            PanicSystem.showAlert(data);
        });

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
    let modPinned = false;
    let modSelectedUser = null;
    let modSelectedAction = null;
    let modSearchTimer = null;
    let modHistoryData = [];

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

        if (modSlideOpen) {
            requestFocus(true);
            setTimeout(() => document.getElementById('modSearchInput')?.focus(), 350);
        } else {
            // IMMER Focus abgeben wenn Panel geschlossen wird
            requestFocus(false);
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

        // Mod-History laden
        const historyEl = document.getElementById('modHistory');
        const historyTitle = document.getElementById('modHistoryTitle');
        const historyList = document.getElementById('modHistoryList');
        historyEl.style.display = 'none';
        try {
            const histRes = await fetch(API_URL + '/api/mod-history?userId=' + id, {
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
            }
        } catch(e) {}

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

    // ─── INTRO SEQUENCE ──────────────────────────────────────
    function playIntro(onComplete) {
        const intro = document.getElementById('intro-overlay');
        if (!intro) { onComplete(); return; }

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

        // Update value displays
        document.getElementById('settFadeStrVal').textContent = fadeStr + '%';
        document.getElementById('settLogoVal').textContent = logoOp + '%';
        document.getElementById('settWmVal').textContent = wmOp + '%';

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

    return { init, toggleCmd, toggleModSlide, toggleModPanel, toggleModPin, searchModUser, selectModUser, clearModUser, pickModAction, sendModAction, togglePanelPin, toggleOverlayVisibility, openHistoryDetail, closeHistoryDetail, toggleSettings, applySetting, pickColor, resetSettings, getRobloxUsername: () => robloxUsername };
})();

// ══════════════════════════════════════════════
// PANIC BUTTON SYSTEM
// ══════════════════════════════════════════════
const PanicSystem = {
    _targetUsername: null,
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

        const session = JSON.parse(localStorage.getItem('en_session') || 'null');
        const user = session?.user;
        if (!user?.discordId) { console.log('[PANIC] Kein User eingeloggt'); return; }

        // Roblox Username aus Overlay holen (wurde beim Init von API geladen)
        let robloxUsername = Overlay.getRobloxUsername() || '';
        if (!robloxUsername) {
            // Fallback: aus localStorage versuchen
            try {
                const rblx = JSON.parse(localStorage.getItem('rblx_profile') || 'null');
                robloxUsername = rblx?.username || rblx?.displayName || '';
            } catch(e) {}
        }
        if (!robloxUsername) robloxUsername = user.username || '?';
        console.log(`[PANIC] Roblox Username resolved: ${robloxUsername}`);

        const socket = window._overlaySocket;
        console.log(`[PANIC] Button gedrückt! Socket connected: ${!!socket?.connected}, User: ${user.username}, Roblox: ${robloxUsername}`);

        if (socket?.connected) {
            socket.emit('panic_button', {
                discordId: user.discordId,
                username: user.username || 'Unbekannt',
                robloxUsername: robloxUsername,
                avatar: user.avatar || '',
            });
            console.log('[PANIC] Socket emit gesendet');
        } else {
            console.log('[PANIC] Socket NICHT verbunden!');
        }
    },

    showAlert(data) {
        this._targetUsername = data.robloxUsername || data.username || '?';
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

    teleport() {
        if (!this._targetUsername) return;
        if (this._teleporting) return; // Guard gegen Mehrfach-Klick
        this._teleporting = true;

        const target = this._targetUsername;
        console.log(`[PANIC] Teleportiere zu: ${target}`);
        console.log(`[PANIC] electronAPI vorhanden: ${!!window.electronAPI}, robloxTeleport: ${!!window.electronAPI?.robloxTeleport}`);

        // ERST Focus-Loop + Timer stoppen, damit Roblox Focus behalten kann
        if (this._focusInterval) { clearInterval(this._focusInterval); this._focusInterval = null; }
        if (this._autoCloseTimer) { clearInterval(this._autoCloseTimer); this._autoCloseTimer = null; }

        // Alert sofort schliessen + Focus abgeben
        const el = document.getElementById('panicAlert');
        if (el) { el.classList.remove('active'); el.style.display = 'none'; }
        this._targetUsername = null;
        const reqFocus = window.electronAPI?.requestOverlayFocus || window.electronAPI?.overlayRequestFocus;
        if (reqFocus) reqFocus(false);

        // Kurz warten damit Roblox Focus hat, dann Teleport IPC senden
        setTimeout(() => {
            try {
                if (window.electronAPI && window.electronAPI.robloxTeleport) {
                    window.electronAPI.robloxTeleport(target);
                    console.log(`[PANIC] IPC roblox-teleport gesendet fuer: ${target}`);
                } else {
                    console.error('[PANIC] electronAPI.robloxTeleport NICHT verfuegbar!');
                }
            } catch (e) {
                console.error('[PANIC] Teleport IPC Fehler:', e);
            }
            // Guard nach 3s resetten
            setTimeout(() => { this._teleporting = false; }, 3000);
        }, 300);
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
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>'
        : type === 'kick'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="22" height="22"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
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
    _state: 'off',
    _savedMs: 0,
    _startedAt: null,
    _tickInterval: null,

    async _apiCall(endpoint) {
        const session = JSON.parse(localStorage.getItem('en_session') || 'null');
        const discordId = session?.user?.discordId;
        if (!discordId) return;
        try {
            await fetch(`${OVL_CONFIG.API_URL}/api/shift/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-api-key': 'emden-super-secret-key-2026' },
                body: JSON.stringify({ discordId }),
            });
        } catch(e) {}
    },

    async start() {
        await this._apiCall('start');
        this._state = 'active';
        this._startedAt = Date.now();
        this._updateUI();
        this._startTick();
    },

    async pause() {
        await this._apiCall('pause');
        if (this._startedAt) this._savedMs += Date.now() - this._startedAt;
        this._state = 'break';
        this._startedAt = null;
        this._updateUI();
        this._stopTick();
    },

    async end() {
        await this._apiCall('end');
        if (this._state === 'active' && this._startedAt) this._savedMs += Date.now() - this._startedAt;
        this._state = 'off';
        this._startedAt = null;
        this._updateUI();
        this._stopTick();
    },

    _syncFromServer(state) {
        this._state = state;
        if (state === 'active') { this._startedAt = Date.now(); this._startTick(); }
        else { this._startedAt = null; this._stopTick(); }
        this._updateUI();
    },

    _startTick() {
        this._stopTick();
        this._tickInterval = setInterval(() => this._updateUI(), 1000);
    },
    _stopTick() { if (this._tickInterval) { clearInterval(this._tickInterval); this._tickInterval = null; } },

    _updateUI() {
        let total = this._savedMs;
        if (this._state === 'active' && this._startedAt) total += Date.now() - this._startedAt;

        const h = Math.floor(total / 3600000);
        const m = Math.floor((total % 3600000) / 60000);
        const s = Math.floor((total % 60000) / 1000);
        const timeStr = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;

        const timer = document.getElementById('ovShiftTimer');
        const label = document.getElementById('ovShiftState');
        const btnStart = document.getElementById('ovBtnStart');
        const btnPause = document.getElementById('ovBtnPause');
        const btnEnd = document.getElementById('ovBtnEnd');

        if (timer) timer.textContent = timeStr;
        if (label) label.textContent = this._state === 'active' ? 'On Duty' : this._state === 'break' ? 'Pause' : 'Off Duty';
        if (btnStart) btnStart.disabled = this._state === 'active';
        if (btnPause) btnPause.disabled = this._state !== 'active';
        if (btnEnd) btnEnd.disabled = this._state === 'off';
    },

    async loadFromServer() {
        const session = JSON.parse(localStorage.getItem('en_session') || 'null');
        const discordId = session?.user?.discordId;
        if (!discordId) return;
        try {
            const res = await fetch(`${OVL_CONFIG.API_URL}/api/shifts`, {
                headers: { 'x-api-key': 'emden-super-secret-key-2026' },
            });
            const data = await res.json();
            if (data.success && data.shifts[discordId]) {
                const s = data.shifts[discordId];
                this._state = s.state || 'off';
                this._savedMs = s.savedMs || 0;
                this._startedAt = s.state === 'active' && s.startedAt ? s.startedAt : null;
                if (this._state === 'active') this._startTick();
                this._updateUI();
            }
        } catch(e) {}
    },
};

window.OverlayShift = OverlayShift;

window.addEventListener('DOMContentLoaded', () => {
    Overlay.init();
    // Load shift state after a short delay (socket needs to connect first)
    setTimeout(() => OverlayShift.loadFromServer(), 2000);
});
