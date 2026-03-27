/**
 * EMDEN NETWORK UPDATE MANAGER
 * Live-Update-System via GitHub API
 */

const UpdateManager = (() => {
    // --- KONFIGURATION ---
    const CURRENT_VERSION = '1.0.0'; 
    const CHECK_INTERVAL = 1000 * 60 * 15; 

    let isChecking = false;

    // ─── INITIALISIERUNG ─────────────────────────────────────────
    function init() {
        console.log(`[Update] System via GitHub aktiviert. Aktuelle Version: ${CURRENT_VERSION}`);
        
        // Beim Start prüfen
        setTimeout(() => checkForUpdates(), 2000);

        // Periodische Prüfung
        setInterval(() => checkForUpdates(), CHECK_INTERVAL);
    }

    // ─── UPDATE-CHECK (GITHUB) ──────────────────────────────────
    async function checkForUpdates() {
        if (isChecking || !window.electronAPI) return;
        isChecking = true;

        try {
            console.log('[Update] Prüfe GitHub auf neue Version...');
            const data = await window.electronAPI.checkGithubUpdate();
            
            if (data && data.tag_name) {
                const remoteVer = data.tag_name.replace('v', '');
                if (remoteVer !== CURRENT_VERSION) {
                    console.log(`[Update] Neue Version gefunden: ${remoteVer}`);
                    
                    // Suche automatisch nach dem Asset, das auf .exe endet
                    const exeAsset = data.assets.find(a => a.name.endsWith('.exe'));
                    const downloadUrl = exeAsset ? exeAsset.browser_download_url : `https://github.com/princearmy2024/Emden-Network/releases/download/${data.tag_name}/EmdenNetworkSetup.exe`;
                    
                    showUpdateToast({
                        version: remoteVer,
                        notes: data.body,
                        url: downloadUrl
                    });
                } else {
                    console.log('[Update] App ist auf dem neuesten Stand (GitHub).');
                }
            }
        } catch (e) {
            console.error('[Update] Fehler beim GitHub Update-Check:', e.message);
        } finally {
            isChecking = false;
        }
    }

    // ─── CHANGELOG FETCH (GITHUB) ───────────────────────────────
    async function fetchChangelog() {
        if (!window.electronAPI) return;
        const container = document.getElementById('changelogList');
        if (!container) return;

        try {
            const releases = await window.electronAPI.getGithubChangelog();
            if (!releases || releases.length === 0) {
                container.innerHTML = '<div class="cl-empty">Keine Updates gefunden.</div>';
                return;
            }

            container.innerHTML = releases.map(rel => `
                <div class="cl-item">
                    <div class="cl-header">
                        <span class="cl-ver">${rel.tag_name}</span>
                        <span class="cl-date">${new Date(rel.published_at).toLocaleDateString('de-DE')}</span>
                    </div>
                    <div class="cl-body">${rel.body ? rel.body.replace(/\n/g, '<br>') : 'Keine Beschreibung.'}</div>
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

        const notes = updateInfo.notes || 'Fehlerbehebungen und Optimierungen.';
        
        container.innerHTML = `
            <div class="update-toast">
                <div class="ut-header">
                    <div class="ut-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
                    </div>
                    <div class="ut-title">Update verfügbar! (v${updateInfo.version})</div>
                </div>
                <div class="ut-text">${notes}</div>
                <div class="download-bar-container hidden" id="updateProgressContainer">
                    <div class="download-bar-fill" id="updateProgressBar"></div>
                    <div class="download-text" id="updateProgressText">Lade herunter: 0%</div>
                </div>
                <div class="ut-footer" id="updateFooter">
                    <button class="btn-update-now" id="btnUpdateNow">Update installieren</button>
                    <button class="btn-update-later" id="btnUpdateLater">Später</button>
                </div>
            </div>
        `;

        requestAnimationFrame(() => container.classList.add('active'));

        document.getElementById('btnUpdateNow').onclick = () => performUpdate(updateInfo.url);
        document.getElementById('btnUpdateLater').onclick = () => container.classList.remove('active');

        // Listener für Fortschritt
        if (window.electronAPI && window.electronAPI.onUpdateProgress) {
            window.electronAPI.onUpdateProgress((pct) => {
                const bar = document.getElementById('updateProgressBar');
                const txt = document.getElementById('updateProgressText');
                if (bar) bar.style.width = pct + '%';
                if (txt) txt.textContent = `Lade herunter: ${pct}%`;
                if (pct >= 100 && txt) txt.textContent = 'Bereite Installation vor...';
            });
            
            window.electronAPI.onUpdateError((err) => {
                const txt = document.getElementById('updateProgressText');
                if (txt) {
                   txt.textContent = 'Fehler beim Download!';
                   txt.style.color = '#ff4b4b';
                }
                document.getElementById('updateFooter').classList.remove('hidden');
            });
        }
    }

    // ─── DURCHFÜHRUNG ──────────────────────────────────────────
    function performUpdate(url) {
        if (window.electronAPI && window.electronAPI.startAppUpdate) {
            document.getElementById('updateProgressContainer').classList.remove('hidden');
            document.getElementById('updateFooter').classList.add('hidden');
            window.electronAPI.startAppUpdate(url);
        } else {
            window.open(url, '_blank');
        }
    }

    // Public API
    return { init, checkForUpdates, fetchChangelog };
})();

// Startet automagisch
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    UpdateManager.init();
} else {
    document.addEventListener('DOMContentLoaded', () => UpdateManager.init());
}
