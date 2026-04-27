/**
 * Device-Mode: Handy / PC / Auto
 *
 * "auto" entscheidet basierend auf Viewport-Breite (>= 980px = pc).
 * Override speichern wir in localStorage('en.mode' = 'phone'|'pc'|'auto').
 *
 * Wir setzen auf <body> Klassen `mode-phone` / `mode-pc` damit CSS reagieren kann.
 */
const KEY = 'en.mode';

export function getMode() {
  return localStorage.getItem(KEY) || 'auto';
}

export function setMode(mode) {
  if (mode === 'auto') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  applyMode();
}

export function resolvedMode() {
  const m = getMode();
  if (m === 'phone') return 'phone';
  if (m === 'pc') return 'pc';
  return window.matchMedia('(min-width: 980px)').matches ? 'pc' : 'phone';
}

export function applyMode() {
  const r = resolvedMode();
  document.body.classList.toggle('mode-pc', r === 'pc');
  document.body.classList.toggle('mode-phone', r === 'phone');
  document.body.classList.toggle('mode-forced', getMode() !== 'auto');
}

/**
 * Bei Auto-Mode auf Resize reagieren.
 */
export function watchResize() {
  let prev = resolvedMode();
  window.addEventListener('resize', () => {
    if (getMode() !== 'auto') return;
    const next = resolvedMode();
    if (next !== prev) {
      prev = next;
      applyMode();
      window.dispatchEvent(new CustomEvent('en:modechange', { detail: next }));
    }
  });
}
