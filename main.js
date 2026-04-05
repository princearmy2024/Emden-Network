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

const { app, BrowserWindow, ipcMain, Notification, globalShortcut, screen, shell } = require('electron');
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

    // Fenster erst anzeigen wenn vollständig geladen (verhindert weißes Blitzen)
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // DevTools nur im Dev-Modus
    // mainWindow.webContents.openDevTools();
}

// === IPC HANDLER (Hauptprozess-Seite) ===

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
                        console.log('[Update] Starte Installer und beende App...');
                        shell.openPath(tempPath).then(() => {
                            // Hartes Beenden, um Dateisperren sofort aufzuheben
                            app.exit(0);
                        }).catch(err => {
                            console.error('[Update] Installer konnte nicht gestartet werden:', err);
                        });
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
function createRobloxOverlay(discordId, robloxId, isAdmin) {
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        robloxOverlayWin.close();
    }
    const { width, height } = screen.getPrimaryDisplay().bounds;
    robloxOverlayWin = new BrowserWindow({
        width: width + 2, height: height + 2, x: -1, y: -1, // +2 Hack um Windows Maximize-Snap & Frame-Bug zu umgehen
        transparent: true, frame: false,
        titleBarStyle: 'hidden', type: 'toolbar', // Extra Sicherheitsnetze für Frameless
        backgroundColor: '#00000000',
        alwaysOnTop: true, skipTaskbar: true,
        focusable: true, resizable: false, fullscreenable: false,
        webPreferences: { 
            nodeIntegration: false, 
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js') 
        },
    });
    robloxOverlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    robloxOverlayWin.setIgnoreMouseEvents(true, { forward: true });
    const adminFlag = isAdmin ? '1' : '0';
    robloxOverlayWin.loadFile('roblox-overlay.html', {
        query: { discordId, robloxId, admin: adminFlag }
    });
    
    robloxOverlayWin.once('ready-to-show', () => {
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
    HIDE_DELAY: 800,   // 0.8s bevor Overlay verschwindet

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

            // Sicherer Check: tasklist + aktives Fenster Titel via wmic
            exec('wmic process where "name=\'RobloxPlayerBeta.exe\'" get ProcessId /format:list',
                { timeout: 1500, windowsHide: true }, (err, stdout) => {
                if (err || !robloxOverlayWin || robloxOverlayWin.isDestroyed()) return;

                const robloxRunning = (stdout || '').includes('ProcessId=');

                // Prüfe ob unser eigenes Hauptfenster fokussiert ist
                const ourAppFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

                // Roblox ist "aktiv" wenn es läuft UND unser Hauptfenster NICHT fokussiert ist
                const robloxShouldShow = robloxRunning && !ourAppFocused;

                this._handleStateChange(robloxShouldShow);
            });
        }, 2000);
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
ipcMain.on('show-roblox-overlay', (event, { discordId, robloxId, isAdmin }) => {
    createRobloxOverlay(discordId, robloxId, isAdmin);
    OverlayState.start();
});
ipcMain.on('hide-roblox-overlay', () => {
    OverlayState.stop();
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        robloxOverlayWin.close();
        robloxOverlayWin = null;
    }
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
    // GLOBALER PTT SHORTCUT (V-Taste über Roblox)
    // Funktioniert auch wenn das Dashboard im Hintergrund ist
    // ==========================================
    let currentPttKey = 'V';

    function registerPTT(key) {
        if (!key) return;
        try {
            globalShortcut.unregister(currentPttKey);
        } catch(e){}
        
        currentPttKey = key.toUpperCase();
        
        try {
            globalShortcut.register(currentPttKey, () => {
                if (globalPTTActive) return; // Kein Dauerfeuer
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

                // Sicherheits-Timeout: PTT automatisch nach 30s stoppen
                setTimeout(() => {
                    if (globalPTTActive) {
                        console.warn('[PTT] Sicherheits-Timeout: Erzwinge PTT-Stop nach 30s');
                        globalPTTActive = false;
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

    // Default registrieren
    registerPTT('V');

    // Dynamisch updaten, wenn Client es ändert
    ipcMain.on('set-ptt-key', (e, newKey) => {
        if (typeof newKey !== 'string' || newKey.trim().length === 0) {
            console.warn('[PTT] Ungültiger PTT-Key empfangen:', newKey);
            return;
        }
        registerPTT(newKey.trim());
    });

    // PTT LOSLASSEN — Leider kann globalShortcut kein keyup, deshalb nutzen wir
    // einen Fallback: Nach 3s automatisch stoppen wenn kein Re-Fire kommt
    // Der Overlay sendet 'ptt-keepalive' während gedrückt, Main resetzt den Timer
    let pttReleaseTimer = null;
    ipcMain.on('ptt-keepalive', () => {
        clearTimeout(pttReleaseTimer);
        pttReleaseTimer = setTimeout(() => {
            if (globalPTTActive) {
                globalPTTActive = false;
                if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
                    robloxOverlayWin.webContents.send('overlay-ptt-stop');
                }
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('overlay-ptt-stop');
                }
            }
        }, 200); // 200ms nach letztem keepalive → PTT stopp
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
            saveWinPos(modPanelWin, modPanelPosFile);
            modPanelWin.close();
            modPanelWin = null;
            return;
        }
        // Wenn Button offen → Button schließen
        if (modBtnWin && !modBtnWin.isDestroyed()) {
            saveWinPos(modBtnWin, modBtnPosFile);
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
        modBtnWin.on('moved', () => saveWinPos(modBtnWin, modBtnPosFile));
        modBtnWin.on('closed', () => { modBtnWin = null; });
    }

    function openModPanel() {
        if (modPanelWin && !modPanelWin.isDestroyed()) return;

        const pos = loadPos(modPanelPosFile, 200, 100);
        modPanelWin = new BrowserWindow({
            width: 400, height: 560, x: pos.x, y: pos.y,
            frame: false, transparent: true, backgroundColor: '#00000000',
            alwaysOnTop: true, skipTaskbar: false,
            resizable: true, minimizable: false, focusable: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
        });
        modPanelWin.setAlwaysOnTop(true, 'pop-up-menu', 1);
        modPanelWin.loadFile('mod-panel.html');
        modPanelWin.on('moved', () => saveWinPos(modPanelWin, modPanelPosFile));
        modPanelWin.on('closed', () => { modPanelWin = null; });
    }

    function loadPos(file, defX, defY) {
        try { const s = JSON.parse(fs.readFileSync(file, 'utf-8')); return { x: s.x, y: s.y }; }
        catch(e) { return { x: defX, y: defY }; }
    }
    function saveWinPos(win, file) {
        if (!win || win.isDestroyed()) return;
        const [x, y] = win.getPosition();
        try { fs.writeFileSync(file, JSON.stringify({ x, y })); } catch(e) {}
    }

    globalShortcut.register('F4', () => toggleModButton());

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // App ist bereit!
});

app.on('will-quit', () => {
    // Shortcuts beim Beenden freigeben
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});