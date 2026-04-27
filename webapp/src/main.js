/**
 * Emden Network — Discord Activity Entry Point
 *
 * Flow:
 *   1. Discord SDK initialisieren + ready warten
 *   2. authorize() → Discord-User-Daten kriegen (identify scope)
 *   3. POST /api/check-staff?discordId=xxx → isStaff/isAdmin Status
 *   4. Wenn berechtigt → App-Shell rendern, sonst → Access-Denied
 */
import { initAuth, getSession } from './auth.js';
import { renderShell } from './ui/shell.js';
import { renderAccessDenied } from './ui/access-denied.js';
import { applyMode, watchResize } from './device.js';
import { unlockOnFirstGesture } from './sounds.js';

const $ = (id) => document.getElementById(id);

function setBootStatus(text, isError = false) {
  const status = $('boot-status');
  const boot = $('boot-screen');
  if (status) status.textContent = text;
  if (boot) boot.classList.toggle('error', isError);
}

// Wait for Lucide CDN to be ready before any rendering
function waitForLucide() {
  return new Promise(resolve => {
    if (window.lucide?.createIcons) return resolve();
    const t = setInterval(() => {
      if (window.lucide?.createIcons) { clearInterval(t); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(t); resolve(); }, 3000);
  });
}

async function main() {
  try {
    applyMode();
    watchResize();
    unlockOnFirstGesture();
    await waitForLucide();
    setBootStatus('Verbinde mit Discord...');
    const session = await initAuth();

    if (!session?.discordId) {
      setBootStatus('Discord-Auth fehlgeschlagen', true);
      return;
    }

    setBootStatus('Pruefe Berechtigung...');
    const access = await checkAccess(session.discordId);

    if (!access.isStaff && !access.isAdmin) {
      // Kein Staff → Access denied
      $('app').innerHTML = '';
      renderAccessDenied($('app'), session);
      return;
    }

    setBootStatus('Lade Dashboard...');
    $('app').innerHTML = '';
    renderShell($('app'), { ...session, ...access });
  } catch (err) {
    console.error('[Boot] Fatal:', err);
    setBootStatus(`Fehler: ${err.message || err}`, true);
  }
}

async function checkAccess(discordId) {
  const apiBase = import.meta.env.VITE_API_BASE || '/api';
  const apiKey = import.meta.env.VITE_API_KEY || '';
  try {
    const r = await fetch(`${apiBase}/check-staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ discordId }),
    });
    if (!r.ok) return { isStaff: false, isAdmin: false };
    const d = await r.json();
    return { isStaff: !!d.isStaff, isAdmin: !!d.isAdmin };
  } catch (e) {
    console.warn('[checkAccess] failed:', e);
    return { isStaff: false, isAdmin: false };
  }
}

// Globalen Session-Helper anbieten (fuer Views)
window.EN = { getSession };

main();
