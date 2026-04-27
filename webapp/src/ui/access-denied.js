export function renderAccessDenied(root, session) {
  root.innerHTML = `
    <div class="access-denied">
      <div class="access-denied-icon">🔒</div>
      <div class="access-denied-title">Kein Zugriff</div>
      <div class="access-denied-text">
        Hi <strong>${escapeHtml(session?.username || 'Unbekannt')}</strong> —
        diese Activity ist nur fuer Emden Network Staff/Admins.
        Wenn du denkst das ist ein Fehler, kontaktiere die Leitung.
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
