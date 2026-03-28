/**
 * EMDEN NETWORK ROBLOX OVERLAY — roblox-overlay-renderer.js
 * Läuft im transparenten Electron-Overlay-Fenster
 */

'use strict';

// CONFIG (wird auch aus URL-Parametern gelesen)
const OVL_CONFIG = {
    API_URL: 'http://91.98.124.212:5009',
    EMDEN_PLACE_ID: 12716055617,
    // TODO: Hier deine Discord Rollen-IDs eintragen
    ON_DUTY_ROLE_ID: 'PLACEHOLDER_ON_DUTY_ROLE_ID',
};

const Overlay = (() => {
    let socket     = null;
    let discordId  = '';
    let robloxId   = '';
    let isAdmin    = false;
    let cmdVisible = false;
    let playtimeStart   = null;
    let playtimeTimer   = null;
    let bigAnnTimeout   = null;

    // ─── INIT ───────────────────────────────────────────────────
    function init() {
        const p = new URLSearchParams(window.location.search);
        discordId = p.get('discordId') || '';
        robloxId  = p.get('robloxId')  || '';
        isAdmin   = p.get('admin') === '1';

        document.body.style.opacity = '1'; // Body immer sichtbar, Inhalte werden ein/ausgeblendet
        document.body.style.transition = 'opacity 0.8s ease';

        startClock();
        connectSocket();
        setupKeys();
        startRandomTips();

        if (typeof lucide !== 'undefined') lucide.createIcons();

        if (window.electronAPI?.onToggleRobloxCmd) {
            window.electronAPI.onToggleRobloxCmd(() => toggleCmd());
        }

        // --- NEW: VOICE PTT OVERLAY SYNC ---
        if (window.electronAPI?.onUpdateOverlayState) {
            window.electronAPI.onUpdateOverlayState((state) => {
                if (state.type === 'voice_ptt') {
                    const area = document.getElementById('voice-status-area');
                    if (!area) return;
                    
                    if (state.active) {
                        document.getElementById('voice-username').textContent = state.user || 'Unbekannt';
                        document.getElementById('voice-channel-name').textContent = '#' + (state.channel || 'Funk');
                        area.classList.add('visible');
                    } else {
                        area.classList.remove('visible');
                    }
                }
            });
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
            const d   = new Date();
            const hh  = String(d.getHours()).padStart(2,'0');
            const mm  = String(d.getMinutes()).padStart(2,'0');
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
        document.getElementById('supporter-count').textContent =
            `Supporter: ${count}`;
    }

    // ─── SMALL NOTIFICATIONS ────────────────────────────────────
    const MAX_NOTIFS = 3;

    function notify({ title, text, type = 'announce', duration = 7000 }) {
        const area = document.getElementById('notif-area');
        const current = area.querySelectorAll('.notif-card:not(.out)');
        if (current.length >= MAX_NOTIFS) dismiss(current[current.length - 1]);

        const icons = { ticket: 'ticket', admin: 'shield', announce: 'megaphone' };
        const icoName = icons[type] || 'megaphone';
        const time  = new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});

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
        // Also show small notif
        notify({ title, text, type: 'announce', duration: 5000 });
    }

    // ─── RANDOM TIPS ──────────────────────────────────────────
    const TIPS = [
        { title: 'Discord Announcement', text: 'Neues Event startet heute Abend! Schau im Kanal vorbei.' },
        { title: 'Team-Suche', text: 'Bewirb dich jetzt im Discord für das Taxi-Team.' },
        { title: 'Social Media', text: 'Willst du coole Events und Streams sehen? Dann schau auf dem Discord vorbei.' },
        { title: 'Support', text: 'Probleme im Spiel? Eröffne ein Ticket auf unserem Discord Server.' }
    ];

    function startRandomTips() {
        setInterval(() => {
            if (!isGameRunning) return;
            const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
            notify(tip);
        }, 1000 * 60 * 8); // Alle 8 Minuten ein Tipp
    }

    // ─── F3 COMMAND BAR ─────────────────────────────────────────
    function toggleCmd() {
        if (!isAdmin) return;
        cmdVisible = !cmdVisible;
        document.getElementById('cmd-bar').classList.toggle('visible', cmdVisible);
        
        // Electron Fenster in den Fokus holen, damit Klicken/Tippen geht
        if (window.electronAPI?.overlayRequestFocus) {
            window.electronAPI.overlayRequestFocus(cmdVisible);
        }

        if (cmdVisible)
            setTimeout(() => document.getElementById('cmd-input').focus(), 360);
    }

    function setupKeys() {
        document.addEventListener('keydown', e => {
            // F3 wird nun systemweit via IPC (main.js) gefeuert 
            if (e.key === 'Escape' && cmdVisible) toggleCmd();
            if (e.key === 'Enter' && cmdVisible) execCmd();
            
            // DEV-DEBUG: F4 simuliert Spiel-Erkennung manuell!
            if (e.key === 'F4') {
                e.preventDefault();
                setGameRunning(!isGameRunning);
            }
        });
    }

    function execCmd() {
        const val = document.getElementById('cmd-input').value.trim();
        if (!val) return;
        // TODO: Anbindung an Admin-Command-System
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
        });

        // On-Duty Supporter Count
        socket.on('overlay_supporter_count', ({ count }) => setSupporter(count));

        // Spiel erkannt — API feuert dieses Event!
        socket.on(`overlay_game_start_${discordId}`, ({ startTime }) => setGameRunning(true, startTime));
        socket.on(`overlay_game_end_${discordId}`,   ()               => setGameRunning(false));

        // Test-Modus (via Main-Prozess Forwarding)
        if (window.electronAPI) {
            // Fake-Event vom Dashboard-Test-Button
            socket.on('overlay_game_start_test', (data) => setGameRunning(true, data.startTime));
        }

        // Initiale Meldung
        notify({ title: 'Emden Network', text: 'Overlay aktiv & bereit.', type: 'info' });

        // Kleine Notification (global oder user)
        socket.on('overlay_notification',                 handleNotif);
        socket.on(`overlay_notification_${discordId}`,   handleNotif);

        // Großes Announcement
        socket.on('overlay_big_announcement', bigAnnounce);

        // Neues Discord Ticket (nur Admins)
        socket.on('overlay_new_ticket', ({ ticketId, reason }) => {
            if (!isAdmin) return;
            notify({
                title: `Neues Ticket #${ticketId}`,
                text:  reason || 'Kein Grund angegeben',
                type:  'ticket',
                duration: 15000,
            });
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

    // Public API
    return { init, toggleCmd };
})();

window.addEventListener('DOMContentLoaded', () => Overlay.init());
