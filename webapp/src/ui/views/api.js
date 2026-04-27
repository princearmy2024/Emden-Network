// Shared helper für alle Views — API + UI Utilities
const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const API_KEY = import.meta.env.VITE_API_KEY || '';

/**
 * Discord-Activity-CSP blockt img-src von externen Hosts (rbxcdn.com etc.).
 * Wir routen alle externen Image-URLs durch /api/img?url=... — der Vercel-
 * Proxy laedt das Bild und reicht die Bytes als 'self' zurueck.
 *
 * Discord-eigene CDN (cdn.discordapp.com) hat Discord schon erlaubt, daher
 * lassen wir die unveraendert.
 */
const PROXY_HOSTS = /(^|\.)(rbxcdn\.com|roblox\.com)$/i;
export function imgUrl(src) {
  if (!src) return '';
  if (typeof src !== 'string') return '';
  if (src.startsWith('/') || src.startsWith('data:') || src.startsWith('blob:')) return src;
  try {
    const u = new URL(src);
    if (PROXY_HOSTS.test(u.hostname)) {
      return `${API_BASE}/img?url=${encodeURIComponent(src)}`;
    }
    return src;
  } catch(_) { return src; }
}

export async function api(path, opts = {}) {
  const headers = { 'x-api-key': API_KEY, ...(opts.headers || {}) };
  if (opts.body && typeof opts.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const url = `${API_BASE}${path}`;
  const r = await fetch(url, { ...opts, headers });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
    const e = new Error(err.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

export function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'gerade';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return Math.floor((ms % 60000) / 1000) + 's';
}

// Lucide-Icons nach Render-Update neu erzeugen
export function refreshIcons(root) {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ icons: undefined, attrs: {}, nameAttr: 'data-lucide' });
  }
}

// Toast (kurze Bestätigung)
let _toastTimeout = null;
export function toast(text, kind = '') {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast ' + kind;
  const iconName = kind === 'success' ? 'check-circle' : kind === 'danger' ? 'alert-circle' : 'info';
  el.innerHTML = `<i data-lucide="${iconName}"></i><span>${escapeHtml(text)}</span>`;
  refreshIcons();
  requestAnimationFrame(() => el.classList.add('show'));
  if (_toastTimeout) clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => {
    el.classList.remove('show');
  }, 3000);
}

// Confirm Modal — Promise<boolean>
export function confirmModal({ title, text, confirmLabel = 'Bestätigen', cancelLabel = 'Abbrechen', kind = 'danger', icon = 'alert-triangle' }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-icon" style="${kind === 'danger' ? '' : 'background:rgba(91,154,255,.15);color:var(--accent);'}"><i data-lucide="${icon}"></i></div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text || '')}</p>
        <div class="action-row">
          <button class="btn full" data-act="cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${kind === 'danger' ? 'danger' : 'primary'} full" data-act="ok">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    refreshIcons();
    overlay.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (b) {
        document.body.removeChild(overlay);
        resolve(b.dataset.act === 'ok');
      } else if (e.target === overlay) {
        document.body.removeChild(overlay);
        resolve(false);
      }
    });
  });
}

// Loading-Helper
export function setLoading(root, text = 'Lade...') {
  if (!root) return;
  root.innerHTML = `<div class="loading"><div class="spinner"></div><span>${escapeHtml(text)}</span></div>`;
}
export function setEmpty(root, icon, text) {
  if (!root) return;
  root.innerHTML = `<div class="empty"><i data-lucide="${icon}"></i><span>${escapeHtml(text)}</span></div>`;
  refreshIcons();
}
export function setError(root, message) {
  if (!root) return;
  root.innerHTML = `<div class="empty"><i data-lucide="alert-circle" style="color:var(--danger);"></i><span>${escapeHtml(message)}</span></div>`;
  refreshIcons();
}
