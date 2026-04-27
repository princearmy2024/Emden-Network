/**
 * Support-Cases View — offene Cases listen + übernehmen
 */
import { api, escapeHtml, timeAgo, refreshIcons, setLoading, setEmpty, setError, toast, confirmModal } from './api.js';

let currentRoot = null;
let currentSession = null;

export async function renderCases(root, session) {
  currentRoot = root;
  currentSession = session;
  await loadAndRender();
}

async function loadAndRender() {
  setLoading(currentRoot, 'Lade Cases...');
  let cases = [];
  try {
    const d = await api(`/support-cases/open?discordId=${encodeURIComponent(currentSession.discordId)}`);
    cases = d.cases || [];
  } catch (e) {
    setError(currentRoot, e.message);
    return;
  }
  if (cases.length === 0) {
    setEmpty(currentRoot, 'check-circle-2', 'Keine offenen Support-Cases');
    return;
  }
  currentRoot.innerHTML = `<div class="card">
    <div class="card-title"><i data-lucide="life-buoy"></i><span>Offene Cases · ${cases.length}</span></div>
    ${cases.map(itemHtml).join('')}
  </div>`;
  refreshIcons();
  currentRoot.querySelectorAll('[data-case-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      // Click auf Item ohne Action — nichts (oder Detail später)
    });
  });
  currentRoot.querySelectorAll('button[data-act="take"]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      doTakeOver(b.dataset.caseId);
    });
  });
}

function itemHtml(c) {
  const ava = c.avatarUrl
    ? `<img class="li-avatar" src="${escapeHtml(c.avatarUrl)}" alt="">`
    : `<div class="li-avatar">${escapeHtml((c.username || '?').charAt(0).toUpperCase())}</div>`;
  const statusClass = c.status === 'open' ? 'warn' : c.status === 'taken' ? 'success' : '';
  const statusLabel = c.status === 'open' ? 'Wartet' : c.status === 'taken' ? 'Übernommen' : c.status;
  const isOpen = c.status === 'open';
  return `<div class="list-item no-hover" data-case-id="${escapeHtml(c.caseId)}">
    ${ava}
    <div class="li-body">
      <div class="li-title">${escapeHtml(c.username || 'Unbekannt')}</div>
      <div class="li-meta">#S-${escapeHtml(c.caseId)} · ${timeAgo(c.createdAt)}${c.takenByName ? ' · von ' + escapeHtml(c.takenByName) : ''}</div>
    </div>
    ${isOpen
      ? `<button class="btn primary sm" data-act="take" data-case-id="${escapeHtml(c.caseId)}"><i data-lucide="hand"></i><span>Übernehmen</span></button>`
      : `<span class="li-tag ${statusClass}">${escapeHtml(statusLabel)}</span>`}
  </div>`;
}

async function doTakeOver(caseId) {
  const ok = await confirmModal({
    title: 'Case übernehmen?',
    text: 'Der User wird in deinen Support-Voice-Channel verschoben (Support 1-5 musst du dafür sein).',
    confirmLabel: 'Übernehmen',
    icon: 'hand',
    kind: 'primary',
  });
  if (!ok) return;
  try {
    const r = await api('/support-case/take', {
      method: 'POST',
      body: { caseId, discordId: currentSession.discordId },
    });
    toast(`${r.userName} → ${r.movedToChannelName}`, 'success');
    loadAndRender();
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}
