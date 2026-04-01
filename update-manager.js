/**
 * EMDEN NETWORK UPDATE MANAGER
 * Live-Update-System via GitHub API
 * Optimiert für User-Experience & Design
 */

const UpdateManager = (() => {
    // --- KONFIGURATION ---
    let currentAppVersion = '2.4.0'; // Fallback
    const CHECK_INTERVAL = 1000 * 60 * 60; // Alle 1 Stunde prüfen

    let isChecking = false;
    let updateToastActive = false;

    // ─── HELPER: VERSION VERGLEICH ──────────────────────────────
    function isNewerVersion(remote, local) {
        const p = v => v.split('.').map(Number);
        const [r1, r2, r3] = p(remote), [l1, l2, l3] = p(local);
        if (r1 !== l1) return r1 > l1;
        if (r2 !== l2) return r2 > l2;
        return r3 > l3;
    }

    // ─── INITIALISIERUNG ─────────────────────────────────────────
    async function init() {
        // Hol die echte Version vom Hauptprozess
        if (window.electronAPI && window.electronAPI.getAppVersion) {
            try {
                currentAppVersion = await window.electronAPI.getAppVersion();
                console.log(`[Update] System bereit. Aktuelle Version: ${currentAppVersion}`);
            } catch (e) {
                console.warn('[Update] Konnte App-Version nicht abrufen, nutze Fallback.');
            }
        }
        
        // Lade gespeicherte Version (falls Update erfolgt war)
        const storedVer = localStorage.getItem('current_version');
        if (storedVer && isNewerVersion(storedVer, currentAppVersion)) {
            currentAppVersion = storedVer;
            console.log(`[Update] Gespeicherte Version geladen: ${currentAppVersion}`);
        }
        
        // Beim Start prüfen (kurze Verzögerung für smoothes Laden)
        setTimeout(() => checkForUpdates(), 3000);

        // Periodische Prüfung
        setInterval(() => checkForUpdates(), CHECK_INTERVAL);
    }

    // ─── UPDATE-CHECK (GITHUB) ──────────────────────────────────
    async function checkForUpdates() {
        if (isChecking || !window.electronAPI || updateToastActive) return;
        isChecking = true;

        try {
            console.log('[Update] Prüfe GitHub auf neue Version...');
            const data = await window.electronAPI.checkGithubUpdate();
            
            if (data && data.tag_name) {
                const remoteVer = data.tag_name.replace('v', '');
                
                // Falls Version gleich oder älter -> notifier verstecken
                if (remoteVer === currentAppVersion || !isNewerVersion(remoteVer, currentAppVersion)) {
                    console.log(`[Update] App ist auf dem neuesten Stand (${currentAppVersion}).`);
                    const notifier = document.getElementById('updateNotifier');
                    if (notifier) notifier.classList.remove('visible');
                    const sidebarBtn = document.getElementById('sidebarUpdateBtn');
                    if (sidebarBtn) sidebarBtn.style.display = 'none';
                    return;
                }

                // Prüfen ob der Nutzer diese Version bereits übersprungen hat
                const skippedVer = localStorage.getItem('skipped_version');
                if (skippedVer === remoteVer) {
                    console.log(`[Update] Version ${remoteVer} wurde vom Nutzer übersprungen.`);
                    return;
                }

                console.log(`[Update] Neue Version gefunden: ${remoteVer} (aktuell: ${currentAppVersion})`);
                
                // Wir speichern die Info global für den Dialog
                window._lastUpdateInfo = {
                    version: remoteVer,
                    notes: data.body,
                    url: data.assets && data.assets.find(a => a.name.endsWith('.exe')) ? data.assets.find(a => a.name.endsWith('.exe')).browser_download_url : `https://github.com/princearmy2024/Emden-Network/releases/download/${data.tag_name}/EmdenNetworkSetup.exe`
                };

                // Update-Buttons einblenden (Topbar + Sidebar)
                const notifier = document.getElementById('updateNotifier');
                if (notifier) notifier.classList.add('visible');
                const sidebarBtn = document.getElementById('sidebarUpdateBtn');
                if (sidebarBtn) sidebarBtn.style.display = 'flex';
            }
        } catch (e) {
            console.error('[Update] Fehler beim GitHub Update-Check:', e.message);
        } finally {
            isChecking = false;
        }
    }

    // --- MANUELLER DIALOG (Beim Klick auf das Icon) ---
    function showUpdateDialog() {
        if (!window._lastUpdateInfo || updateToastActive) return;
        showUpdateToast(window._lastUpdateInfo);
    }

    // ─── CHANGELOG FETCH (GITHUB) ───────────────────────────────
    async function fetchChangelog() {
        if (!window.electronAPI) return;
        const container = document.getElementById('changelogList');
        if (!container) return;

        try {
            const releases = await window.electronAPI.getGithubChangelog();
            if (!Array.isArray(releases) || releases.length === 0) {
                container.innerHTML = '<div class="cl-empty">Keine Updates gefunden.</div>';
                return;
            }

            container.innerHTML = releases.map(rel => `
                <div class="cl-item">
                    <div class="cl-header">
                        <span class="cl-ver">${rel.tag_name}</span>
                        <span class="cl-date">${new Date(rel.published_at).toLocaleDateString('de-DE')}</span>
                    </div>
                    <div class="cl-body">${rel.body ? (typeof escHtml === 'function' ? escHtml(rel.body) : rel.body.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))).replace(/\n/g, '<br>') : 'Keine Beschreibung.'}</div>
                </div>
            `).join('');
        } catch (e) {
            container.innerHTML = '<div class="cl-error">Fehler beim Laden des Changelogs.</div>';
        }
    }

    // ─── UI / TOAST ─────────────────────────────────────────────
    function showUpdateToast(updateInfo) {
        let container = document.getElementById('update-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'update-toast-container';
            document.body.appendChild(container);
        }

        updateToastActive = true;
        const notes = updateInfo.notes || 'Fehlerbehebungen und System-Optimierungen.';
        
        container.innerHTML = `
            <div class="update-toast">
                <div class="ut-header">
                    <div class="ut-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
                    </div>
                    <div class="ut-title-group">
                        <div class="ut-title">Update verfügbar!</div>
                        <div class="ut-version-tag">Version ${updateInfo.version}</div>
                    </div>
                </div>
                <div class="ut-text">${notes}</div>
                
                <!-- Download Progress (Initially Hidden) -->
                <div class="download-bar-container hidden" id="updateProgressContainer">
                    <div class="download-bar-fill" id="updateProgressBar"></div>
                    <div class="download-text" id="updateProgressText">Bereite Download vor...</div>
                </div>

                <div class="ut-footer" id="updateFooter">
                    <button class="btn-update-now" id="btnUpdateNow">Jetzt installieren</button>
                    <button class="btn-update-later" id="btnUpdateLater">Später</button>
                </div>
            </div>
        `;

        // Animation anzeigen
        setTimeout(() => container.classList.add('active'), 100);

        // Buttons
        document.getElementById('btnUpdateNow').onclick = () => performUpdate(updateInfo.url);
        
        document.getElementById('btnUpdateLater').onclick = () => {
            // Version überspringen (Wird erst bei nächster Version wieder gezeigt)
            localStorage.setItem('skipped_version', updateInfo.version);
            closeToast();
        };

        // Helper zum Schließen
        function closeToast() {
            container.classList.remove('active');
            setTimeout(() => {
                updateToastActive = false;
                container.innerHTML = '';
                // Wir lassen das Icon da, falls er es sich nochmal überlegt, 
                // außer er hat "Später" geklickt (skipped_version)
            }, 800);
        }

        // Listener für Fortschritt vom Hauptprozess (alte zuerst entfernen)
        if (window.electronAPI && window.electronAPI.onUpdateProgress) {
            if (window.electronAPI.removeUpdateListeners) {
                window.electronAPI.removeUpdateListeners();
            }
            window.electronAPI.onUpdateProgress((pct) => {
                const bar = document.getElementById('updateProgressBar');
                const txt = document.getElementById('updateProgressText');
                if (pct < 0) {
                    // Unbekannte Dateigröße (kein content-length Header)
                    if (txt) txt.textContent = 'Lade herunter...';
                } else {
                    if (bar) bar.style.width = pct + '%';
                    if (txt) txt.textContent = `Fortschritt: ${pct}%`;
                    if (pct >= 100 && txt) {
                        txt.textContent = 'Starte Installation...';
                        txt.style.color = '#4DA6FF';
                    }
                }
            });
            
            window.electronAPI.onUpdateError((err) => {
                const txt = document.getElementById('updateProgressText');
                if (txt) {
                    txt.textContent = 'Download-Fehler!';
                    txt.style.color = '#ff4b4b';
                }
                const footer = document.getElementById('updateFooter');
                if (footer) footer.classList.remove('hidden');
                
                // Nach 5 Sekunden Toast schließen bei Fehler
                setTimeout(closeToast, 5000);
            });
        }
    }

    // ─── DURCHFÜHRUNG ──────────────────────────────────────────
    function performUpdate(url) {
        const progContainer = document.getElementById('updateProgressContainer');
        const footer = document.getElementById('updateFooter');
        
        if (progContainer) progContainer.classList.remove('hidden');
        if (footer) footer.classList.add('hidden');

        if (window.electronAPI && window.electronAPI.startAppUpdate) {
            window.electronAPI.startAppUpdate(url);
            // Speichere die erwartete Version für den nächsten Start
            if (window._lastUpdateInfo) {
                localStorage.setItem('current_version', window._lastUpdateInfo.version);
                console.log(`[Update] Erwartete Version gespeichert: ${window._lastUpdateInfo.version}`);
            }
        } else {
            console.warn('[Update] startAppUpdate nicht verfügbar, öffne Browser...');
            window.open(url, '_blank');
        }
    }

    // Public API erweitert
    return { init, checkForUpdates, fetchChangelog, showUpdateDialog };
})();

// Explizit global verfügbar machen (für renderer.js und inline events)
window.UpdateManager = UpdateManager;

// Startet beim Laden
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    UpdateManager.init();
} else {
    document.addEventListener('DOMContentLoaded', () => UpdateManager.init());
}
