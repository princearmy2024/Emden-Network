const { app, BrowserWindow, ipcMain, Notification, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');

let mainWindow;
let overlayWindow;
let robloxOverlayWin = null;

function createOverlayWindow() {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    const w = 420;
    const h = 500;

    overlayWindow = new BrowserWindow({
        width: w,
        height: h,
        x: width - w - 16,
        y: height - h - 16,
        show: true,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
        }
    });

    overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.loadFile('notification-overlay.html');
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 960,
        minHeight: 600,
        frame: false,
        transparent: false,
        backgroundColor: '#0a0a0f',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
        icon: path.join(__dirname, 'assets', 'icon.ico'), // FIX: assets/ Ordner
        show: false,
    });

    mainWindow.loadFile('index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// === IPC: FENSTERKONTROLLE ===
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});
ipcMain.on('window-close', () => mainWindow?.close());

// === IPC: NOTIFICATIONS ===
ipcMain.on('show-native-notification', (event, { title, body }) => {
    if (Notification.isSupported()) {
        new Notification({ title, body }).show();
    }
});

ipcMain.on('send-overlay-notification', (event, data) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('show-overlay-notification', data);
    }
});

// === IPC: EXTERNE URLS ===
ipcMain.on('open-external', (event, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://localhost') || url.startsWith('http://'))) {
        shell.openExternal(url);
    }
});

// === GITHUB UPDATE SYSTEM ===
const GITHUB_OWNER = 'princearmy2024';
const GITHUB_REPO = 'Emden-Network';

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
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(null);
                }
            });
        }).on('error', () => resolve(null));
    });
});

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
                } catch (e) {
                    resolve([]);
                }
            });
        }).on('error', () => resolve([]));
    });
});

ipcMain.handle('get-app-version', () => app.getVersion());

// === IPC: DISCORD WEBHOOK ===
ipcMain.on('send-to-discord', (event, { webhookUrl, version, notes }) => {
    console.log('[Discord] Sende Webhook für Version:', version);

    const data = JSON.stringify({
        embeds: [{
            title: `Dashboard Update: ${version}`,
            description: `Eine neue Benachrichtigung aus dem **Emden Network Control Center**.`,
            color: 0x00D1A7,
            fields: [{
                name: "Änderungen",
                value: notes || "System-Optimierungen und Stabilitätsverbesserungen.",
                inline: false
            }],
            footer: { text: "Emden Network — Automated Update Service" },
            timestamp: new Date().toISOString()
        }],
        components: [{
            type: 1,
            components: [{
                type: 2,
                label: "Download (exe)",
                style: 5,
                url: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/EmdenNetworkSetup.exe`
            }]
        }]
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
        });

        req.on('error', (e) => console.error(`[Discord] Fehler: ${e.message}`));
        req.write(data);
        req.end();
    } catch (err) {
        console.error('[Discord] URL Fehler:', err.message);
    }
});

// === IPC: APP UPDATE DOWNLOAD ===
// IPC Alias: startUpgrade (Kompatibilität mit v1.5.0)
ipcMain.on('startUpgrade', (event, url) => {
    ipcMain.emit('start-app-update', event, { url });
});

ipcMain.on('start-app-update', (event, { url }) => {
    console.log('[Update] Starte Download von:', url);
    const tempPath = path.join(os.tmpdir(), 'EmdenNetworkSetup_Update.exe');

    function downloadFile(targetUrl) {
        https.get(targetUrl, (response) => {
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
                if (totalSize) {
                    const progress = Math.round((downloadedSize / totalSize) * 100);
                    event.sender.send('update_progress', progress);
                }
            });

            response.pipe(file);

            file.on('finish', () => {
                file.close(() => {
                    console.log('[Update] Download abgeschlossen:', tempPath);
                    event.sender.send('update_downloaded');
                });
            });

            file.on('error', (err) => {
                fs.unlink(tempPath, () => { });
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

// FIX: Doppelter Handler entfernt — nur noch einmal registriert
ipcMain.on('restart_app', () => {
    const tempPath = path.join(os.tmpdir(), 'EmdenNetworkSetup_Update.exe');
    if (fs.existsSync(tempPath)) {
        shell.openPath(tempPath).then(() => {
            app.exit(0);
        });
    } else {
        app.relaunch();
        app.exit(0);
    }
});

// === IPC: ROBLOX OAUTH CALLBACK SERVER ===
let robloxCallbackServer = null;
ipcMain.on('start-roblox-callback-server', (event, { botCallbackUrl }) => {
    if (robloxCallbackServer) {
        try { robloxCallbackServer.close(); } catch (_) { }
        robloxCallbackServer = null;
    }

    robloxCallbackServer = http.createServer((req, res) => {
        const urlObj = new URL(req.url, 'http://localhost:7329');
        if (urlObj.pathname !== '/roblox-callback') {
            res.writeHead(404);
            return res.end('Not found');
        }

        const forwardUrl = botCallbackUrl + '?' + urlObj.searchParams.toString();
        res.writeHead(302, { Location: forwardUrl });
        res.end();

        setTimeout(() => {
            try {
                if (robloxCallbackServer && robloxCallbackServer.listening) {
                    robloxCallbackServer.close();
                }
                robloxCallbackServer = null;
            } catch (_) { }
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
        width: width + 2,
        height: height + 2,
        x: -1,
        y: -1,
        transparent: true,
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: true,
        resizable: false,
        fullscreenable: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
    });

    robloxOverlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    robloxOverlayWin.setIgnoreMouseEvents(true, { forward: true });
    robloxOverlayWin.loadFile('roblox-overlay.html', {
        query: { discordId, robloxId, admin: isAdmin ? '1' : '0' }
    });

    robloxOverlayWin.once('ready-to-show', () => {
        robloxOverlayWin.show();
    });
}

ipcMain.on('show-roblox-overlay', (event, { discordId, robloxId, isAdmin }) => {
    createRobloxOverlay(discordId, robloxId, isAdmin);
});

ipcMain.on('hide-roblox-overlay', () => {
    if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
        robloxOverlayWin.close();
        robloxOverlayWin = null;
    }
});

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

// === APP READY ===
app.whenReady().then(() => {
    app.setAppUserModelId("com.emden.network.dashboard");

    createWindow();
    createOverlayWindow();

    // F2 — Dashboard fokussieren
    globalShortcut.register('F2', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        } catch (e) {
            console.error('F2 Shortcut Error:', e.message);
        }
    });

    // F3 — Roblox Overlay Command Bar
    globalShortcut.register('F3', () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('toggle-roblox-cmd');
        }
    });

    // F4 — Dev: Game Running simulieren
    globalShortcut.register('F4', () => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.executeJavaScript(`
                if (typeof setGameRunning !== "undefined") {
                    setGameRunning(!isGameRunning);
                } else if (typeof Overlay !== "undefined") {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F4' }));
                }
            `);
        }
    });

    // PTT (Push-to-Talk) — Toggle-Modus weil Electron kein KeyUp hat
    let currentPTTKey = 'V';
    let pttActive = false; // FIX: Toggle-State damit PTT nicht ewig aktiv bleibt

    function registerPTT(key) {
        try {
            globalShortcut.unregister(currentPTTKey);
            currentPTTKey = key.toUpperCase();
            globalShortcut.register(currentPTTKey, () => {
                pttActive = !pttActive; // FIX: Toggle statt Hold (Electron hat kein KeyUp)
                mainWindow?.webContents.send('global-ptt', pttActive);
                robloxOverlayWin?.webContents.send('global-ptt', pttActive);
            });
        } catch (e) {
            console.error('[PTT] Registrierung fehlgeschlagen:', e.message);
        }
    }
    registerPTT('V');

    ipcMain.on('update-ptt-key', (event, key) => registerPTT(key));

    ipcMain.on('update-overlay-state', (event, state) => {
        if (robloxOverlayWin && !robloxOverlayWin.isDestroyed()) {
            robloxOverlayWin.webContents.send('update-overlay-state', state);
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});