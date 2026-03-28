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
        backgroundColor: '#0a0a0f',
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

// Custom Desktop Overlay Notification
ipcMain.on('send-overlay-notification', (event, data) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('show-overlay-notification', data);
    }
});

// Öffnet externe URLs im System-Browser (auch localhost + https)
ipcMain.on('open-external', (event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://localhost') || url.startsWith('http://'))) {
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

// Holt die letzten 3 Releases für den Changelog
ipcMain.handle('get-github-changelog', async () => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=3`,
            headers: { 'User-Agent': 'EmdenNetwork-Dashboard' }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(Array.isArray(json) ? json : []);
                } catch (e) { resolve([]); }
            });
        }).on('error', () => resolve([]));
    });
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Discord Webhook (Manuel/Automatisch)
ipcMain.on('send-to-discord', (event, { webhookUrl, version, notes }) => {
    console.log('[Discord] Sende Webhook für Version:', version);
    
    const data = JSON.stringify({
        content: `🚀 **Benachrichtigung aus dem Dashboard**\n\n**Titel:** ${version}\n\n**Nachricht:**\n${notes}\n\n[Download von GitHub](https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/EmdenNetworkSetup.exe)`
    });

    try {
        const url = new URL(webhookUrl);
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

            const totalSize = parseInt(response.headers['content-length'], 10);
            let downloadedSize = 0;
            const file = fs.createWriteStream(tempPath);

            response.on('data', (chunk) => {
                downloadedSize += chunk.length;
                const progress = Math.round((downloadedSize / totalSize) * 100);
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
    if (robloxCallbackServer) { try { robloxCallbackServer.close(); } catch (_) {} robloxCallbackServer = null; }

    robloxCallbackServer = http.createServer((req, res) => {
        const urlObj = new URL(req.url, 'http://localhost:7329');
        if (urlObj.pathname !== '/roblox-callback') { res.writeHead(404); return res.end('Not found'); }

        // Alle Query-Parameter an den Bot-Server weitergeben
        const forwardUrl = botCallbackUrl + '?' + urlObj.searchParams.toString();

        res.writeHead(302, { Location: forwardUrl });
        res.end();

        // Server nach kurzer Verzögerung schließen
        setTimeout(() => { 
            try { 
                if (robloxCallbackServer && robloxCallbackServer.listening) {
                    robloxCallbackServer.close(); 
                }
                robloxCallbackServer = null; 
            } catch (_) {} 
        }, 3000);
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

// Show/hide Roblox overlay via IPC (called from renderer.js)
ipcMain.on('show-roblox-overlay', (event, { discordId, robloxId, isAdmin }) => {
    createRobloxOverlay(discordId, robloxId, isAdmin);
});
ipcMain.on('hide-roblox-overlay', () => {
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
            robloxOverlayWin.focus(); 
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
    // F3 ROBLOX OVERLAY COMMAND BAR
    // ==========================================
    globalShortcut.register('F3', () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('toggle-roblox-cmd');
        }
    });

    // ==========================================
    // GLOBAL PTT (V) - Funk in Roblox
    // ==========================================
    let currentPTTKey = 'V';
    
    function registerPTT(key) {
        try {
            globalShortcut.unregister(currentPTTKey);
            currentPTTKey = key.toUpperCase();
            globalShortcut.register(currentPTTKey, () => {
                // Key Down
                mainWindow?.webContents.send('global-ptt', true);
                robloxOverlayWin?.webContents.send('global-ptt', true);
            });
            // HINWEIS: Electron globalShortcut hat leider kein KeyUp Event.
            // WORKAROUND: Wir nutzen ein Interval oder der User muss 2x drücken?
            // BESSERE LÖSUNG: Wir lassen es als Toggle oder für 3 Sek aktiv?
            // Für echte PTT brauchen wir einen Native Hook - im Moment simulieren wir es!
        } catch(e) {}
    }
    registerPTT('V');

    ipcMain.on('update-ptt-key', (event, key) => registerPTT(key));

    ipcMain.on('update-overlay-state', (event, state) => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('update-overlay-state', state);
        }
    });

    // DEV-DEBUG: F4 to simulate game start
    globalShortcut.register('F4', () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.executeJavaScript(`
                if (typeof setGameRunning !== "undefined") {
                    setGameRunning(!isGameRunning);
                } else if (typeof Overlay !== "undefined") {
                     // trigger F4 simulate
                     const event = new KeyboardEvent('keydown', { key: 'F4' });
                     document.dispatchEvent(event);
                }
            `);
        }
    });

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