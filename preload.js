/**
 * EMDEN NETWORK - preload.js
 * Electron Preload Script
 * Sichere Brücke zwischen Renderer und Main Process
 */

const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow:    () => ipcRenderer.send('window-close'),
    showNativeNotification: (title, body) =>
        ipcRenderer.send('show-native-notification', { title, body }),
    
    sendOverlayNotification: (data) => ipcRenderer.send('send-overlay-notification', data),
    onShowOverlayNotification: (callback) => ipcRenderer.on('show-overlay-notification', (event, data) => callback(data)),

    // Auto-Updater
    onUpdateAvailable: (cb) => ipcRenderer.on('update_available', (event, ver) => cb(ver)),
    onUpdateProgress: (cb) => ipcRenderer.on('update_progress', (event, pct) => cb(pct)),
    onUpdateDownloaded: (cb) => ipcRenderer.on('update_downloaded', () => cb()),
    onUpdateError:      (cb) => ipcRenderer.on('update_error', (event, err) => cb(err)),
    removeUpdateListeners: () => {
        ipcRenderer.removeAllListeners('update_progress');
        ipcRenderer.removeAllListeners('update_error');
    },
    restartApp: () => ipcRenderer.send('restart_app'),
    startAppUpdate: (url) => ipcRenderer.send('start-app-update', { url }),

    // GitHub Updates
    checkGithubUpdate: () => ipcRenderer.invoke('check-github-update'),
    getGithubChangelog: () => ipcRenderer.invoke('get-github-changelog'),
    sendToDiscord: ({ webhookUrl, version, notes }) => ipcRenderer.send('send-to-discord', { webhookUrl, version, notes }),

    // Tenor GIF Search (via Main-Prozess, umgeht CSP)
    searchTenorGifs: (query) => ipcRenderer.invoke('search-tenor-gifs', query),

    // Chat-Backup (überlebt Updates)
    saveChatBackup: (data) => ipcRenderer.invoke('save-chat-backup', data),
    loadChatBackup: () => ipcRenderer.invoke('load-chat-backup'),

    // Overlay Focus (für Mod-Panel Klicks)
    requestOverlayFocus: (focus) => ipcRenderer.send('overlay-request-focus', focus),

    // Notification Sound (delegiert an Main Window)
    playNotificationSound: () => ipcRenderer.send('play-notification-sound'),

    // Teleport wurde entfernt (v4.50.0)

    // Mod-Button erstellen (für Admins)
    createModButton: () => ipcRenderer.send('create-mod-button'),
    toggleModPanel: () => ipcRenderer.send('toggle-mod-panel'),

    // Autostart
    setAutostart: (enabled) => ipcRenderer.send('set-autostart', enabled),

    // Öffnet URLs im System-Browser (für Roblox OAuth)
    openExternal: (url) => ipcRenderer.send('open-external', url),

    // Startet den lokalen OAuth-Callback-Server
    startRobloxCallbackServer: (botCallbackUrl) => ipcRenderer.send('start-roblox-callback-server', { botCallbackUrl }),

    showRobloxOverlay: (discordId, robloxId, isAdmin, isStaff) => ipcRenderer.send('show-roblox-overlay', { discordId, robloxId, isAdmin, isStaff }),
    hideRobloxOverlay: () => ipcRenderer.send('hide-roblox-overlay'),
    testRobloxOverlay: () => ipcRenderer.send('test-roblox-overlay'),

    getDisplays: () => ipcRenderer.invoke('get-displays'),
    setOverlayDisplay: (displayId) => ipcRenderer.send('set-overlay-display', displayId),
    saveVerifiedUser: (userData) => ipcRenderer.invoke('save-verified-user', userData),
    loadVerifiedUser: () => ipcRenderer.invoke('load-verified-user'),
    clearVerifiedUser: () => ipcRenderer.invoke('clear-verified-user'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    onToggleRobloxCmd: (callback) => ipcRenderer.on('toggle-roblox-cmd', callback),
    onToggleModPanel: (callback) => ipcRenderer.on('toggle-mod-panel', callback),
    overlayRequestFocus: (focus) => ipcRenderer.send('overlay-request-focus', focus),
    updateOverlayState: (state) => ipcRenderer.send('update-overlay-state', state),
    onUpdateOverlayState: (callback) => ipcRenderer.on('update-overlay-state', (event, state) => callback(state)),

    // Teleport Clipboard entfernt (v4.50.0)

    // ── GLOBALES PTT SYSTEM ───────────────────────────────────────
    // Main-Prozess sendet diese Events wenn die globale V-Taste gedrückt wird
    onOverlayPTTStart: (cb) => ipcRenderer.on('overlay-ptt-start', () => cb()),
    onOverlayPTTStop:  (cb) => ipcRenderer.on('overlay-ptt-stop',  () => cb()),
    // Overlay sendet Keepalive während V gedrückt (da globalShortcut kein keyup kennt)
    pttKeepalive: () => ipcRenderer.send('ptt-keepalive'),
    pttStop:      () => ipcRenderer.send('ptt-stop'),
    setPTTKey:    (key) => ipcRenderer.send('set-ptt-key', key),
    pttStart:     () => ipcRenderer.send('ptt-start'),
    pttDisable:   () => ipcRenderer.send('ptt-disable'),
    dashboardReady: () => ipcRenderer.send('dashboard-ready'),
    takeScreenshot: () => ipcRenderer.send('take-screenshot'),
    onScreenshotTaken: (cb) => ipcRenderer.on('screenshot-taken', (event, data) => cb(data)),
});