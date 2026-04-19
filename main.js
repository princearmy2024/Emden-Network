/**
 * NEXUS DASHBOARD - main.js
 * Electron Hauptprozess
 * 
 * Später erweiterbar für:
 * - IPC-Kommunikation mit Server
 * - Tray-Icon
 * - Auto-Updater
 * - Native Notifications
 */

const { app, BrowserWindow, ipcMain, Notification, globalShortcut, screen, shell, clipboard, nativeImage, desktopCapturer } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;
let overlayWindow;
let robloxOverlayWin = null;
let shaderStreamWin = null; // Separates "Emden Network Shader" Fenster fuer Discord/OBS
let globalPTTActive  = false; // Verhindert doppeltes Feuern

function createOverlayWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    
    const w = 420;
    const h = 500; // Platz für mehrere gestapelte Toasts

    overlayWindow = new BrowserWindow({
        width: w,
        height: h,
        x: width - w - 16,       // Rechts unten, 16px Abstand vom Rand
        y: height - h - 16,
        show: true,
        frame: false,             // Kein Fensterrahmen
        transparent: true,        // Echter transparenter Hintergrund
        backgroundColor: '#00000000',
        alwaysOnTop: true,        // Immer über Spielen sichtbar
        skipTaskbar: true,        // Nicht in der Taskleiste
        focusable: false,         // Klicks gehen durch
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        }
    });

    // ZWINGT DAS FENSTER ÜBER ALLE ANDEREN APPS (AUCH SPIELE!)
    overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    
    // Erlaube Klicks durch das transparente Fenster
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    
    overlayWindow.loadFile('notification-overlay.html');
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 600,
        frame: false,           // Custom Titlebar
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        trafficLightPosition: { x: 12, y: 12 },  // macOS: Ampel-Buttons positionieren
        transparent: false,
        backgroundColor: '#13151e',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,   // Sicherheit: immer aktiv lassen
            nodeIntegration: false,   // Sicherheit: immer deaktiviert lassen
            sandbox: false,           // Nötig für preload
        },
        icon: path.join(__dirname, 'icon.ico'), // DIESES ICON WIRD IN DER TASKLEISTE GEZEIGT
        show: false, // Erst nach 'ready-to-show' anzeigen
    });

    mainWindow.loadFile('index.html');

    // DevTools deaktivieren (Sicherheit: Source-Code nicht sichtbar)
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' || (input.control && input.shift && (input.key === 'I' || input.key === 'i' || input.key === 'J' || input.key === 'j'))) {
            event.preventDefault();
        }
    });

    // Fenster erst anzeigen wenn vollständig geladen (verhindert weißes Blitzen)
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // macOS: Fenster verstecken statt beenden (Dock-Klick öffnet wieder)
    mainWindow.on('close', (e) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
            return;
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });


    // DevTools nur im Dev-Modus
    // mainWindow.webContents.openDevTools();
}

// === IPC HANDLER (Hauptprozess-Seite) ===

// Teleport wurde entfernt (v4.50.0) — ersetzt durch Panic Accept System

// Sound abspielen (delegiert an Main Window weil Overlay keinen Audio-Focus hat)
ipcMain.on('play-notification-sound', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(`
            (function() {
                try {
                    const s = document.getElementById('modNotifSound') || new Audio('notif.mp3');
                    s.currentTime = 0; s.volume = 0.5; s.play().catch(() => {});
                } catch(e) {}
            })();
        `).catch(() => {});
    }
});

// Fensterkontrolle (Custom Titlebar)
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});
ipcMain.on('window-close', () => mainWindow?.close());

// Native Notification (optional, später nutzbar)
ipcMain.on('show-native-notification', (event, { title, body }) => {
    if (Notification.isSupported()) {
        new Notification({ title, body }).show();
    }
});

// Autostart
ipcMain.on('set-autostart', (event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    console.log('[Autostart]', enabled ? 'Aktiviert' : 'Deaktiviert');
});

// Custom Desktop Overlay Notification
ipcMain.on('send-overlay-notification', (event, data) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('show-overlay-notification', data);
    }
});

// Öffnet externe URLs im System-Browser (auch localhost + https)
ipcMain.on('open-external', (event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://localhost'))) {
        shell.openExternal(url);
    }
});

// === GITHUB UPDATE SYSTEM URLS ===
const GITHUB_OWNER = 'princearmy2024';
const GITHUB_REPO = 'Emden-Network';

// Prüft GitHub API nach Updates
ipcMain.handle('check-github-update', async () => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
            headers: { 'User-Agent': 'EmdenNetwork-Dashboard' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                } catch (e) { resolve(null); }
            });
        }).on('error', () => resolve(null));
    });
});

// Holt die letzten 10 Releases für den Changelog
ipcMain.handle('get-github-changelog', async () => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`,
            headers: { 'User-Agent': 'EmdenNetwork-Dashboard' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (Array.isArray(json) && json.length > 0) {
                        resolve(json);
                    } else {
                        // Rate-Limit oder Fehler → lokalen Fallback nutzen
                        resolve(getLocalChangelog());
                    }
                } catch (e) { resolve(getLocalChangelog()); }
            });
        }).on('error', () => resolve(getLocalChangelog()));
    });
});

// Lokaler Fallback-Changelog aus version.json
function getLocalChangelog() {
    try {
        const vj = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'version.json'), 'utf8'));
        return [{
            tag_name: 'v' + vj.version,
            published_at: vj.releaseDate || new Date().toISOString(),
            body: vj.notes || 'Aktuelles Release'
        }];
    } catch (e) { return []; }
}

ipcMain.handle('get-app-version', () => app.getVersion());

// Verified User: Speichert verifizierte User-Daten persistent (ueberlebt Updates + localStorage-Clear)
const VERIFIED_USER_FILE = path.join(app.getPath('userData'), 'verified-user.json');

ipcMain.handle('save-verified-user', async (event, userData) => {
    try {
        fs.writeFileSync(VERIFIED_USER_FILE, JSON.stringify(userData));
        return { success: true };
    } catch(e) { return { success: false }; }
});

ipcMain.handle('load-verified-user', async () => {
    try {
        if (fs.existsSync(VERIFIED_USER_FILE)) {
            return JSON.parse(fs.readFileSync(VERIFIED_USER_FILE, 'utf8'));
        }
    } catch(e) {}
    return null;
});

ipcMain.handle('clear-verified-user', async () => {
    try { if (fs.existsSync(VERIFIED_USER_FILE)) fs.unlinkSync(VERIFIED_USER_FILE); } catch(e) {}
    return { success: true };
});

// Chat-Backup: Speichert/Lädt Chat-History in userData (überlebt Updates)
const CHAT_BACKUP_FILE = path.join(app.getPath('userData'), 'chat-backup.json');

ipcMain.handle('save-chat-backup', async (event, data) => {
    try {
        fs.writeFileSync(CHAT_BACKUP_FILE, JSON.stringify(data));
        return { success: true };
    } catch(e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('load-chat-backup', async () => {
    try {
        if (fs.existsSync(CHAT_BACKUP_FILE)) {
            return JSON.parse(fs.readFileSync(CHAT_BACKUP_FILE, 'utf-8'));
        }
        return null;
    } catch(e) {
        return null;
    }
});

// Tenor GIF Search (via Main-Prozess, umgeht CSP)
ipcMain.handle('search-tenor-gifs', async (event, query) => {
    return new Promise((resolve) => {
        const isTrending = !query || query === 'trending';
        const apiPath = isTrending
            ? '/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&limit=24&media_filter=tinygif,gif'
            : `/v2/search?q=${encodeURIComponent(query)}&key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&limit=24&media_filter=tinygif,gif`;

        https.get({ hostname: 'tenor.googleapis.com', path: apiPath, headers: { 'User-Agent': 'EmdenNetwork' } }, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch(e) { resolve({ results: [] }); }
            });
        }).on('error', () => resolve({ results: [] }));
    });
});

// Discord Webhook (Manuel/Automatisch)
ipcMain.on('send-to-discord', (event, { webhookUrl, version, notes }) => {
    console.log('[Discord] Sende Webhook für Version:', version);

    const now = new Date();
    const timestamp = now.toISOString();

    const data = JSON.stringify({
        username: 'Emden Network',
        avatar_url: `https://github.com/${GITHUB_OWNER}.png`,
        embeds: [{
            title: `📢  ${version}`,
            description: notes,
            color: 0x0088FF,
            footer: {
                text: 'Emden Network Control Center',
                icon_url: `https://github.com/${GITHUB_OWNER}.png`
            },
            timestamp
        }]
    });

    try {
        const url = new URL(webhookUrl);
        if (url.hostname !== 'discord.com' && !url.hostname.endsWith('.discord.com')) {
            console.error('[Discord] Ungültige Webhook-Domain:', url.hostname);
            return;
        }
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Content-Length': Buffer.byteLength(data) 
            }
        };

        const req = https.request(options, (res) => {
            console.log(`[Discord] Status: ${res.statusCode}`);
            res.on('data', (d) => process.stdout.write(d));
        });

        req.on('error', (e) => {
            console.error(`[Discord] Fehler: ${e.message}`);
        });

        req.write(data);
        req.end();
    } catch(err) {
        console.error('[Discord] URL Fehler:', err.message);
    }
});
ipcMain.on('start-app-update', (event, { url }) => {
    console.log('[Update] Starte Download von:', url);
    const tempPath = path.join(os.tmpdir(), 'EmdenNetworkSetup_Update.exe');
    
    function downloadFile(targetUrl) {
        https.get(targetUrl, (response) => {
            // BEHANDLE REDIRECTS (GitHub -> AWS)
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                console.log('[Update] Folge Weiterleitung zu:', response.headers.location);
                return downloadFile(response.headers.location);
            }

            if (response.statusCode !== 200) {
                console.error('[Update] Download fehlgeschlagen. Status:', response.statusCode);
                event.sender.send('update_error', 'Falscher Status: ' + response.statusCode);
                return;
            }

            const totalSize = parseInt(response.headers['content-length'], 10) || 0;
            let downloadedSize = 0;
            const file = fs.createWriteStream(tempPath);

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const progress = totalSize > 0
                    ? Math.round((downloadedSize / totalSize) * 100)
                    : -1; // -1 = unbekannte Dateigröße
                event.sender.send('update_progress', progress);
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close(() => {
                    console.log('[Update] Download abgeschlossen:', tempPath);
                    event.sender.send('update_downloaded');
                    
                    setTimeout(() => {
                        console.log('[Update] Raeume ALLE Hintergrund-Prozesse auf...');
                        // 1. Alle Shortcuts deregistrieren
                        globalShortcut.unregisterAll();
                        // 2. Callback-Server beenden
                        try { if (robloxCallbackServer?.listening) { robloxCallbackServer.close(); robloxCallbackServer = null; } } catch(_) {}
                        // 3. Alle BrowserWindows schliessen
                        try { if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) { robloxOverlayWin.destroy(); robloxOverlayWin = null; } } catch(_) {}
                        try { if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.destroy(); overlayWindow = null; } } catch(_) {}
                        try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.destroy(); mainWindow = null; } } catch(_) {}
                        // 4. Alle uebrigen Fenster schliessen (falls es noch welche gibt)
                        BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch(_) {} });
                        console.log('[Update] Alle Fenster geschlossen. Starte Installer...');
                        // 5. Installer starten + App sofort beenden
                        shell.openPath(tempPath).then(() => {
                            console.log('[Update] Installer gestartet, beende App...');
                            app.exit(0);
                        }).catch(err => {
                            console.error('[Update] Installer konnte nicht gestartet werden:', err);
                            // Trotzdem beenden damit keine Geisterprozesse bleiben
                            app.exit(1);
                        });
                        // 6. Sicherheitsnetz: Falls nach 3s immer noch am Leben → hart beenden
                        setTimeout(() => {
                            console.log('[Update] Sicherheitsnetz: process.exit()');
                            process.exit(0);
                        }, 3000);
                    }, 500);
                });
            });

            file.on('error', (err) => {
                fs.unlink(tempPath, () => {});
                console.error('[Update] Dateifehler:', err);
                event.sender.send('update_error', err.message);
            });
        }).on('error', (err) => {
            console.error('[Update] Netzfehler:', err);
            event.sender.send('update_error', err.message);
        });
    }

    downloadFile(url);
});

// Startet den temporären localhost OAuth-Callback-Server für Roblox
let robloxCallbackServer = null;
ipcMain.on('start-roblox-callback-server', (event, { botCallbackUrl }) => {
    // Alten Server aufräumen falls noch einer läuft
    if (robloxCallbackServer) {
        try { robloxCallbackServer.close(); }
        catch (e) { console.warn('[Roblox] Fehler beim Schließen des alten Servers:', e.message); }
        robloxCallbackServer = null;
    }

    robloxCallbackServer = http.createServer((req, res) => {
        const urlObj = new URL(req.url, 'http://localhost:7329');
        if (urlObj.pathname !== '/roblox-callback') { res.writeHead(404); return res.end('Not found'); }

        // Alle Query-Parameter an den Bot-Server weitergeben
        const forwardUrl = botCallbackUrl + '?' + urlObj.searchParams.toString();

        res.writeHead(302, { Location: forwardUrl });
        res.end();

        // Server nach kurzer Verzögerung schließen (nur einmal planen)
        if (!robloxCallbackServer._closeScheduled) {
            robloxCallbackServer._closeScheduled = true;
            setTimeout(() => {
                try {
                    if (robloxCallbackServer && robloxCallbackServer.listening) {
                        robloxCallbackServer.close();
                    }
                    robloxCallbackServer = null;
                } catch (e) {
                    console.warn('[Roblox] Fehler beim Schließen des Callback-Servers:', e.message);
                    robloxCallbackServer = null;
                }
            }, 3000);
        }
    });

    robloxCallbackServer.listen(7329, '127.0.0.1', () => {
        console.log('[Roblox] Callback-Server gestartet auf localhost:7329');
    });

    robloxCallbackServer.on('error', (e) => {
        console.error('[Roblox] Callback-Server Fehler:', e.message);
    });
});

// === ROBLOX GAME OVERLAY ===
const OVERLAY_DISPLAY_FILE = path.join(app.getPath('userData'), 'overlay-display.json');

function getSelectedDisplay() {
    try {
        const data = JSON.parse(fs.readFileSync(OVERLAY_DISPLAY_FILE, 'utf8'));
        const all = screen.getAllDisplays();
        const found = all.find(d => d.id === data.displayId);
        if (found) return found;
    } catch(_) {}
    return screen.getPrimaryDisplay();
}

function createRobloxOverlay(discordId, robloxId, isAdmin, isStaff) {
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        robloxOverlayWin.close();
    }
    const selectedDisplay = getSelectedDisplay();
    const { width, height } = selectedDisplay.size;
    const { x, y } = selectedDisplay.bounds;
    robloxOverlayWin = new BrowserWindow({
        width: width, height: height, x: x, y: y,
        transparent: true, frame: false,
        titleBarStyle: 'hidden', type: 'toolbar', // Extra Sicherheitsnetze für Frameless
        backgroundColor: '#00000000',
        alwaysOnTop: true, skipTaskbar: true,
        focusable: true, resizable: false, fullscreenable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            backgroundThrottling: false, // Erlaubt Audio ohne Focus
        },
    });
    robloxOverlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    robloxOverlayWin.setIgnoreMouseEvents(true, { forward: true });
    // Audio erlauben im Overlay
    robloxOverlayWin.webContents.setAudioMuted(false);
    robloxOverlayWin.webContents.on('did-finish-load', () => {
        robloxOverlayWin.webContents.setAudioMuted(false);
    });
    // Desktop-Capture Permission (fuer Shader-Stack getUserMedia)
    robloxOverlayWin.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
        if (wc === robloxOverlayWin?.webContents && (permission === 'media' || permission === 'display-capture')) {
            cb(true);
            return;
        }
        cb(false);
    });
    robloxOverlayWin.webContents.session.setPermissionCheckHandler((wc, permission) => {
        if (wc === robloxOverlayWin?.webContents && (permission === 'media' || permission === 'display-capture')) {
            return true;
        }
        return false;
    });
    const adminFlag = isAdmin ? '1' : '0';
    const staffFlag = isStaff ? '1' : '0';
    robloxOverlayWin.loadFile('roblox-overlay.html', {
        query: { discordId, robloxId, admin: adminFlag, staff: staffFlag }
    });
    
    robloxOverlayWin.once('ready-to-show', () => {
        // Exakt den vollen Bildschirm des gewaehlten Monitors abdecken
        const disp = getSelectedDisplay();
        const { x: dx, y: dy } = disp.bounds;
        const { width: sw, height: sh } = disp.size;
        robloxOverlayWin.setBounds({ x: dx, y: dy, width: sw, height: sh });
        robloxOverlayWin.show();
    });
}

// ================================================================
// OVERLAY VISIBILITY — Saubere Zustandsmaschine
// ================================================================
const OverlayState = {
    isOverlayVisible: false,
    isRobloxActive: false,
    robloxActiveStableSince: 0, // Timestamp wann Roblox stabil aktiv wurde
    checkInterval: null,
    showTimeout: null,
    hideTimeout: null,
    SHOW_DELAY: 4000,  // 4s stabil aktiv bevor Overlay erscheint
    HIDE_DELAY: 50,    // 50ms — sehr schnell wegen Shader-Canvas Alt-Tab Fix

    start() {
        if (this.checkInterval) return;
        const { exec } = require('child_process');

        this.checkInterval = setInterval(() => {
            if (!robloxOverlayWin || robloxOverlayWin.isDestroyed()) {
                this.stop();
                return;
            }

            // Prüft ob RobloxPlayerBeta das aktive Fenster ist (OHNE es zu fokussieren!)
            exec('powershell.exe -NoProfile -NoLogo -Command "(Get-Process | Where-Object {$_.MainWindowHandle -eq [System.Diagnostics.Process]::GetCurrentProcess().MainWindowHandle}).ProcessName"',
                { timeout: 2000, windowsHide: true }, (err, stdout) => {
                // Fallback: Einfach prüfen ob Roblox-Prozess existiert UND unser Overlay nicht fokussiert ist
            });

            // Schnell: tasklist statt wmic (kein PowerShell-Overhead, nativer Binary)
            exec('tasklist /FI "IMAGENAME eq RobloxPlayerBeta.exe" /NH /FO CSV',
                { timeout: 800, windowsHide: true }, (err, stdout) => {
                if (err || !robloxOverlayWin || robloxOverlayWin.isDestroyed()) return;

                const robloxRunning = (stdout || '').includes('RobloxPlayerBeta.exe');

                // Prüfe ob unser eigenes Hauptfenster fokussiert ist
                const ourAppFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

                // Roblox ist "aktiv" wenn es läuft UND unser Hauptfenster NICHT fokussiert ist
                const robloxShouldShow = robloxRunning && !ourAppFocused;

                this._handleStateChange(robloxShouldShow);
            });
        }, 250);
    },

    stop() {
        clearInterval(this.checkInterval);
        clearTimeout(this.showTimeout);
        clearTimeout(this.hideTimeout);
        this.checkInterval = null;
        this.showTimeout = null;
        this.hideTimeout = null;
    },

    _handleStateChange(robloxActive) {
        const now = Date.now();

        if (robloxActive && !this.isRobloxActive) {
            // Roblox wurde gerade aktiv → Timer starten (zeige erst nach SHOW_DELAY)
            this.isRobloxActive = true;
            this.robloxActiveStableSince = now;
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;

            // Zeige Overlay erst nach stabiler Wartezeit
            clearTimeout(this.showTimeout);
            this.showTimeout = setTimeout(() => {
                if (this.isRobloxActive && !this.isOverlayVisible) {
                    this._showOverlay();
                }
                this.showTimeout = null;
            }, this.SHOW_DELAY);

        } else if (!robloxActive && this.isRobloxActive) {
            // Roblox nicht mehr aktiv → Overlay nach kurzem Delay verstecken
            this.isRobloxActive = false;
            clearTimeout(this.showTimeout);
            this.showTimeout = null;

            if (this.isOverlayVisible && !this.hideTimeout) {
                this.hideTimeout = setTimeout(() => {
                    if (!this.isRobloxActive) {
                        this._hideOverlay();
                    }
                    this.hideTimeout = null;
                }, this.HIDE_DELAY);
            }
        }
    },

    _showOverlay() {
        if (this.isOverlayVisible) return;
        if (!robloxOverlayWin || robloxOverlayWin.isDestroyed()) return;
        this.isOverlayVisible = true;
        robloxOverlayWin.showInactive(); // showInactive = zeigt ohne Focus zu klauen
        console.log('[Overlay] Sichtbar (Roblox stabil aktiv)');
    },

    _hideOverlay() {
        if (!this.isOverlayVisible) return;
        if (!robloxOverlayWin || robloxOverlayWin.isDestroyed()) return;
        this.isOverlayVisible = false;
        robloxOverlayWin.hide();
        console.log('[Overlay] Versteckt (Roblox nicht aktiv)');
    }
};

// Show/hide Roblox overlay via IPC (called from renderer.js)
ipcMain.on('show-roblox-overlay', (event, { discordId, robloxId, isAdmin, isStaff }) => {
    createRobloxOverlay(discordId, robloxId, isAdmin, isStaff);
    OverlayState.start();
});
ipcMain.on('hide-roblox-overlay', () => {
    OverlayState.stop();
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        robloxOverlayWin.close();
        robloxOverlayWin = null;
    }
});

// Monitor-Auswahl fuer Overlay
ipcMain.handle('get-displays', () => {
    const all = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    let savedId = null;
    try { savedId = JSON.parse(fs.readFileSync(OVERLAY_DISPLAY_FILE, 'utf8')).displayId; } catch(_) {}
    return all.map((d, i) => ({
        id: d.id,
        label: `Monitor ${i + 1}` + (d.id === primary.id ? ' (Hauptbildschirm)' : '') + ` — ${d.size.width}x${d.size.height}`,
        width: d.size.width,
        height: d.size.height,
        primary: d.id === primary.id,
        selected: savedId ? d.id === savedId : d.id === primary.id,
    }));
});
ipcMain.on('set-overlay-display', (event, displayId) => {
    fs.writeFileSync(OVERLAY_DISPLAY_FILE, JSON.stringify({ displayId }), 'utf8');
    console.log(`[Overlay] Display gesetzt: ${displayId}`);
});

// Focus toggle for F3 command bar
ipcMain.on('overlay-request-focus', (event, focus) => {
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        if (focus) {
            robloxOverlayWin.setIgnoreMouseEvents(false);
        } else {
            robloxOverlayWin.setIgnoreMouseEvents(true, { forward: true });
        }
    }
});

ipcMain.on('test-roblox-overlay', () => {
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        robloxOverlayWin.webContents.send('overlay_game_start_test', { startTime: Date.now() });
    }
});

// === TODO: Server-Kommunikation ===
// Hier später: WebSocket-Verbindung zum externen Server aufbauen
// z.B.: connectToServer(config.serverUrl)

app.whenReady().then(() => {
    // BEHEBT DEN FEHLER, DASS NATIVE WINDOWS NOTIFICATIONS NICHT ANGEZEIGT WERDEN!
    app.setAppUserModelId("com.emden.network.dashboard");

    createWindow();
    createOverlayWindow();

    // ==========================================
    // F2 QUICK OVERLAY / APP FOKUS
    // ==========================================
    globalShortcut.register('F2', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        
        try {
            // Wenn minimiert -> wiederherstellen
            if (mainWindow.isMinimized()) mainWindow.restore();
            
            // Falls versteckt -> zeigen
            if (!mainWindow.isVisible()) mainWindow.show();
            
            // Fenster in den Vordergrund holen
            mainWindow.focus();
        } catch (e) {
            console.error('F2 Shortcut Error:', e.message);
        }
    });

    // ==========================================
    // SCREENSHOT SHORTCUT (PrintScreen / F5)
    // Eigener Screenshot weil Windows PrintScreen bei transparenten Overlays buggt
    // ==========================================
    globalShortcut.register('PrintScreen', takeScreenshot);
    globalShortcut.register('F5', takeScreenshot);

    async function takeScreenshot() {
        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: screen.getPrimaryDisplay().size
            });
            if (sources.length === 0) return;

            const img = sources[0].thumbnail;
            clipboard.writeImage(img);

            // Datei speichern
            const fs = require('fs');
            const screenshotDir = path.join(app.getPath('pictures'), 'Emden Network Screenshots');
            if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
            const filename = `Screenshot_${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
            const filePath = path.join(screenshotDir, filename);
            fs.writeFileSync(filePath, img.toPNG());

            console.log('[Screenshot] Gespeichert:', filePath);

            // Benachrichtigung an Dashboard + Overlay senden
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('screenshot-taken', { path: filePath, filename });
            }
            if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
                robloxOverlayWin.webContents.send('screenshot-taken', { path: filePath, filename });
            }
            // Native Windows Notification
            new Notification({ title: 'Screenshot gespeichert', body: filename }).show();
        } catch(e) {
            console.error('[Screenshot] Fehler:', e.message);
        }
    }

    // IPC: Screenshot von Renderer anfragen
    ipcMain.on('take-screenshot', () => takeScreenshot());

    // ==========================================
    // GLOBALER PTT SHORTCUT (V-Taste über Roblox)
    // Funktioniert auch wenn das Dashboard im Hintergrund ist
    // ==========================================
    let currentPttKey = 'V';
    let pttReleaseTimer = null;

    // Release-Timer: wenn 300ms kein Key-Repeat/Keepalive kommt → PTT stoppen
    function resetPTTReleaseTimer() {
        clearTimeout(pttReleaseTimer);
        pttReleaseTimer = setTimeout(() => {
            if (globalPTTActive) {
                globalPTTActive = false;
                console.log('[PTT] Release — kein Keepalive mehr');
                if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
                    robloxOverlayWin.webContents.send('overlay-ptt-stop');
                }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('overlay-ptt-stop');
                }
            }
        }, 300);
    }

    function registerPTT(key) {
        if (!key) return;
        try {
            globalShortcut.unregister(currentPttKey);
        } catch(e){}
        
        currentPttKey = key.toUpperCase();
        
        try {
            globalShortcut.register(currentPttKey, () => {
                // Key-Repeat während PTT aktiv → als Keepalive behandeln
                if (globalPTTActive) {
                    resetPTTReleaseTimer();
                    return;
                }
                globalPTTActive = true;
                console.log('[PTT] Start — Global Shortcut');

                if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
                    robloxOverlayWin.webContents.send('overlay-ptt-start');
                }
                // Nur an mainWindow senden wenn es NICHT fokussiert ist
                // (sonst handelt der DOM keydown-Handler in renderer.js)
                if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
                    mainWindow.webContents.send('overlay-ptt-start');
                }

                // Release-Timer starten (wird durch Key-Repeats resettet)
                resetPTTReleaseTimer();

                // Sicherheits-Timeout: PTT automatisch nach 30s stoppen
                setTimeout(() => {
                    if (globalPTTActive) {
                        console.warn('[PTT] Sicherheits-Timeout: Erzwinge PTT-Stop nach 30s');
                        globalPTTActive = false;
                        clearTimeout(pttReleaseTimer);
                        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
                            robloxOverlayWin.webContents.send('overlay-ptt-stop');
                        }
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('overlay-ptt-stop');
                        }
                    }
                }, 30000);
            });
            console.log('[PTT] Global Shortcut registriert auf:', currentPttKey);
        } catch(e) {
            console.error('[PTT] Fehler bei Shortcut-Registrierung:', e);
        }
    }

    // PTT wird NICHT sofort registriert — erst wenn das Dashboard geladen ist
    // (verhindert, dass V-Taste auf Splash/Login-Screen feuert)
    let dashboardReadyFlag = false;

    ipcMain.on('dashboard-ready', () => {
        if (dashboardReadyFlag) return;
        dashboardReadyFlag = true;
        console.log('[PTT] Dashboard ready — warte auf Hotkey-Config vom Client');
        // KEIN Default-Hotkey! User muss erst in den Einstellungen einen setzen.
    });

    // PTT komplett deaktivieren
    ipcMain.on('ptt-disable', () => {
        try { globalShortcut.unregister(currentPttKey); } catch(e) {}
        console.log('[PTT] Global Hotkey deaktiviert');
    });

    // Dynamisch updaten, wenn Client es ändert
    ipcMain.on('set-ptt-key', (e, newKey) => {
        if (typeof newKey !== 'string' || newKey.trim().length === 0) {
            console.warn('[PTT] Ungültiger PTT-Key empfangen:', newKey);
            return;
        }
        registerPTT(newKey.trim());
    });

    ipcMain.on('ptt-keepalive', () => {
        resetPTTReleaseTimer();
    });

    ipcMain.on('ptt-stop', () => {
        if (!globalPTTActive) return;
        globalPTTActive = false;
        clearTimeout(pttReleaseTimer);
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('overlay-ptt-stop');
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('overlay-ptt-stop');
        }
    });

    ipcMain.on('ptt-start', () => {
        if (globalPTTActive) return;
        globalPTTActive = true;
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('overlay-ptt-start');
        }
    });

    // ==========================================
    // F3 ROBLOX OVERLAY COMMAND BAR
    // ==========================================
    globalShortcut.register('F3', () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('toggle-roblox-cmd');
        }
    });

    ipcMain.on('update-overlay-state', (event, state) => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('update-overlay-state', state);
        }
    });

    // === F4: MOD-BUTTON → PANEL SYSTEM ===
    let modBtnWin = null;
    let modPanelWin = null;
    let f4Cooldown = false;
    const modBtnPosFile = path.join(app.getPath('userData'), 'mod-btn-pos.json');
    const modPanelPosFile = path.join(app.getPath('userData'), 'mod-panel-pos.json');

    ipcMain.on('toggle-mod-panel', () => openModPanel());

    function toggleModButton() {
        if (f4Cooldown) return;
        f4Cooldown = true;
        setTimeout(() => { f4Cooldown = false; }, 800);

        // Wenn Panel offen → Panel schließen
        if (modPanelWin && !modPanelWin.isDestroyed()) {
            saveWinState(modPanelWin, modPanelPosFile);
            modPanelWin.close();
            modPanelWin = null;
            return;
        }
        // Wenn Button offen → Button schließen
        if (modBtnWin && !modBtnWin.isDestroyed()) {
            saveWinState(modBtnWin, modBtnPosFile);
            modBtnWin.close();
            modBtnWin = null;
            return;
        }
        // Button anzeigen
        showModButton();
    }

    function showModButton() {
        if (modBtnWin && !modBtnWin.isDestroyed()) return;
        const pos = loadPos(modBtnPosFile, 60, 60);
        modBtnWin = new BrowserWindow({
            width: 48, height: 48, x: pos.x, y: pos.y,
            frame: false, transparent: true, backgroundColor: '#00000000',
            alwaysOnTop: true, skipTaskbar: true,
            resizable: false, minimizable: false, focusable: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
        });
        modBtnWin.setAlwaysOnTop(true, 'screen-saver', 2);
        modBtnWin.loadFile('mod-btn.html');
        modBtnWin.on('moved', () => saveWinState(modBtnWin, modBtnPosFile));
        modBtnWin.on('closed', () => { modBtnWin = null; });
    }

    function openModPanel() {
        if (modPanelWin && !modPanelWin.isDestroyed()) return;

        const saved = loadPos(modPanelPosFile, 200, 100);
        modPanelWin = new BrowserWindow({
            width: saved.w || 400, height: saved.h || 560, x: saved.x, y: saved.y,
            frame: false, transparent: true, backgroundColor: '#00000000',
            alwaysOnTop: true, skipTaskbar: false,
            resizable: true, minimizable: false, focusable: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
        });
        modPanelWin.setAlwaysOnTop(true, 'pop-up-menu', 1);
        modPanelWin.loadFile('mod-panel.html');
        modPanelWin.on('moved', () => saveWinState(modPanelWin, modPanelPosFile));
        modPanelWin.on('resize', () => saveWinState(modPanelWin, modPanelPosFile));
        modPanelWin.on('closed', () => { modPanelWin = null; });
    }

    function loadPos(file, defX, defY) {
        try { const s = JSON.parse(fs.readFileSync(file, 'utf-8')); return s; }
        catch(e) { return { x: defX, y: defY }; }
    }
    function saveWinState(win, file) {
        if (!win || win.isDestroyed()) return;
        const [x, y] = win.getPosition();
        const [w, h] = win.getSize();
        try { fs.writeFileSync(file, JSON.stringify({ x, y, w, h })); } catch(e) {}
    }

    // Mod-Panel: F4 (Windows) + Cmd+4 / Ctrl+4 (Mac)
    const modPanelHandler = () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('toggle-mod-panel');
        } else {
            toggleModButton();
        }
    };
    globalShortcut.register('F4', modPanelHandler);
    if (process.platform === 'darwin') {
        globalShortcut.register('Command+4', modPanelHandler);
        globalShortcut.register('Control+4', modPanelHandler);
    }

    // ==========================================
    // SHIFT+F6: Shader instant pause/resume (Alt-Tab Escape)
    // ==========================================
    globalShortcut.register('Shift+F6', () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('shader-toggle-pause');
        }
    });

    app.on('activate', () => {
        // macOS: Klick auf Dock-Icon stellt Fenster wieder her
        if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        } else {
            createWindow();
        }
    });

    // App ist bereit!
});

app.on('before-quit', () => {
    app.isQuitting = true;
    // Alle Hintergrund-Prozesse sauber beenden
    globalShortcut.unregisterAll();
    try { if (robloxCallbackServer?.listening) { robloxCallbackServer.close(); robloxCallbackServer = null; } } catch(_) {}
    try { if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) { robloxOverlayWin.destroy(); robloxOverlayWin = null; } } catch(_) {}
    try { if (overlayWindow && !overlayWindow.isDestroyed()) { overlayWindow.destroy(); overlayWindow = null; } } catch(_) {}
    try { if (shaderStreamWin && !shaderStreamWin.isDestroyed()) { shaderStreamWin.destroy(); shaderStreamWin = null; } } catch(_) {}
    // Alle uebrigen Fenster zerstoeren
    BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch(_) {} });
});

// ================================================================
// SHADER STACK
// - In-Overlay Rendering (Canvas im Roblox-Overlay selbst)
// - Optionales "Emden Network Shader" Fenster fuer Discord/OBS
// ================================================================
ipcMain.handle('shader-list-sources', async () => {
    try {
        const sources = await desktopCapturer.getSources({
            types: ['window', 'screen'],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: false,
        });
        const mapped = sources.map(s => ({
            id: s.id,
            name: s.name,
            displayId: s.display_id || '',
            thumbnailDataUrl: s.thumbnail?.toDataURL() || '',
        }));
        console.log(`[Shader] list-sources: ${mapped.length} sources gefunden`);
        return mapped;
    } catch (e) {
        console.error('[Shader] list-sources FAILED:', e.message, e.stack);
        // Return error info so renderer can display it
        return { __error: e.message || 'Unknown error' };
    }
});

function createShaderStreamWindow() {
    if (shaderStreamWin && !shaderStreamWin.isDestroyed()) return shaderStreamWin;
    shaderStreamWin = new BrowserWindow({
        width: 1280,
        height: 720,
        minWidth: 640,
        minHeight: 360,
        title: 'Emden Network Shader',
        backgroundColor: '#000000',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    shaderStreamWin.setMenu(null);
    shaderStreamWin.setTitle('Emden Network Shader');
    shaderStreamWin.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
        if (wc === shaderStreamWin?.webContents && (permission === 'media' || permission === 'display-capture')) {
            cb(true);
            return;
        }
        cb(false);
    });
    shaderStreamWin.loadFile(path.join('shader-stack', 'shader-window.html'));
    shaderStreamWin.once('ready-to-show', () => {
        shaderStreamWin.setTitle('Emden Network Shader');
        shaderStreamWin.show();
    });
    shaderStreamWin.on('closed', () => { shaderStreamWin = null; });
    return shaderStreamWin;
}

ipcMain.on('shader-stream-open', (event, payload = {}) => {
    const { sourceId, settings, renderMode, autoAtmosphere } = payload;
    const w = createShaderStreamWindow();
    const send = () => {
        if (!w || w.isDestroyed()) return;
        w.webContents.send('shader:stream-meta', { renderMode, autoAtmosphere });
        if (settings) w.webContents.send('shader:stream-settings', settings);
        if (sourceId) w.webContents.send('shader:stream-source', sourceId);
    };
    if (w.webContents.isLoading()) {
        w.webContents.once('did-finish-load', send);
    } else {
        send();
    }
});

ipcMain.on('shader-stream-close', () => {
    if (shaderStreamWin && !shaderStreamWin.isDestroyed()) {
        try { shaderStreamWin.webContents.send('shader:stream-stop'); } catch (_) {}
        shaderStreamWin.close();
    }
});

ipcMain.on('shader-stream-settings', (event, settings) => {
    if (shaderStreamWin && !shaderStreamWin.isDestroyed()) {
        shaderStreamWin.webContents.send('shader:stream-settings', settings || {});
    }
});

ipcMain.on('shader-stream-meta', (event, meta) => {
    if (shaderStreamWin && !shaderStreamWin.isDestroyed()) {
        shaderStreamWin.webContents.send('shader:stream-meta', meta || {});
    }
});

ipcMain.on('shader-stream-ready', () => {
    console.log('[Shader-Stream] Window ready');
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});