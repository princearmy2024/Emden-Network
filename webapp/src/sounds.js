/**
 * Sound-Notifications fuer Live-Events.
 *
 * Browser-Autoplay-Policies: das erste play() braucht eine User-Geste.
 * Wir initialisieren bei jedem Klick auf das Document das Audio einmal.
 *
 * Mute-State liegt in localStorage('en.soundMute' = '1'/'0').
 */
const SRC = '/notify.mp3';
const MUTE_KEY = 'en.soundMute';
const VOL_KEY = 'en.soundVol';

let audio = null;
let unlocked = false;

function get() {
  if (!audio) {
    audio = new Audio(SRC);
    audio.preload = 'auto';
  }
  return audio;
}

export function isMuted() {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function setMuted(v) {
  localStorage.setItem(MUTE_KEY, v ? '1' : '0');
}

export function getVolume() {
  const n = parseFloat(localStorage.getItem(VOL_KEY));
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6;
}

export function setVolume(v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  localStorage.setItem(VOL_KEY, String(n));
  if (audio) audio.volume = n;
}

export function play() {
  if (isMuted()) return;
  const a = get();
  a.volume = getVolume();
  try {
    a.currentTime = 0;
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  } catch(_) {}
}

/**
 * Bindet einen einmaligen User-Klick um Audio fuer Browser-Autoplay-Policy
 * freizuschalten. Sollte beim Shell-Init aufgerufen werden.
 */
export function unlockOnFirstGesture() {
  if (unlocked) return;
  const handler = () => {
    unlocked = true;
    const a = get();
    a.volume = 0;
    a.play().then(() => { a.pause(); a.currentTime = 0; a.volume = getVolume(); }).catch(() => {});
    document.removeEventListener('click', handler);
    document.removeEventListener('touchstart', handler);
    document.removeEventListener('keydown', handler);
  };
  document.addEventListener('click', handler, { once: false });
  document.addEventListener('touchstart', handler, { once: false });
  document.addEventListener('keydown', handler, { once: false });
}
