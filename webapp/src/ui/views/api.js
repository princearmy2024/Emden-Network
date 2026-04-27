// Shared API helper — alle Views nutzen dies
const API_BASE = import.meta.env.VITE_API_BASE || '/api';
const API_KEY = import.meta.env.VITE_API_KEY || '';

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
    throw new Error(err.error || `HTTP ${r.status}`);
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
