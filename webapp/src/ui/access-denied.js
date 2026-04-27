import { refreshIcons } from './views/api.js';

export function renderAccessDenied(root, session) {
  root.innerHTML = `
    <div class="access-denied">
      <div class="ad-icon"><i data-lucide="lock"></i></div>
      <div class="access-denied-title">Kein Zugriff</div>
      <div class="access-denied-text">
        Hi <strong>${escapeHtml(session?.username || 'Unbekannt')}</strong> —
        diese Activity ist nur für Emden Network Staff/Admins.<br><br>
        Wenn du denkst das ist ein Fehler, kontaktiere die Leitung.
      </div>
    </div>`;
  refreshIcons();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
