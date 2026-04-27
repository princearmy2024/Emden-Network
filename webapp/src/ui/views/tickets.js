/**
 * Tickets View — Liste + Detail-Ansicht mit Chat + Aktionen
 *
 * State: 'list' oder 'detail'. Wechselt im selben root, kein Page-Reload.
 */
import { api, escapeHtml, timeAgo, refreshIcons, setLoading, setEmpty, setError, toast, confirmModal } from './api.js';
import * as live from '../../live.js';

let liveUnsub = null;

let currentRoot = null;
let currentSession = null;
let view = 'list';                 // 'list' | 'detail'
let allTickets = [];               // alle vom Server
let activeChannelId = null;
let chatClaim = null;
let chatMessages = [];

export async function renderTickets(root, session) {
  currentRoot = root;
  currentSession = session;
  view = 'list';
  // Bei Live-Update der Liste neu rendern (nur wenn list-view aktiv)
  if (liveUnsub) liveUnsub();
  liveUnsub = live.on('ticket:list', (items) => {
    if (view === 'list' && currentRoot && currentRoot.isConnected) {
      allTickets = items;
      renderListContent();
    }
  });
  await renderListView();
}

function renderListContent() {
  if (allTickets.length === 0) {
    setEmpty(currentRoot, 'inbox', 'Keine offenen Tickets');
    return;
  }
  const myId = currentSession.discordId;
  const mine = allTickets.filter(t => t.claim?.claimerDiscordId === myId);
  const others = allTickets.filter(t => t.claim?.claimerDiscordId !== myId);
  const byCat = new Map();
  for (const t of others) {
    const cat = t.category || 'Allgemein';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(t);
  }
  let html = '';
  if (mine.length > 0) {
    html += `<div class="card">
      <div class="card-title"><i data-lucide="pin"></i><span>Meine Tickets · ${mine.length}</span></div>
      ${mine.map(t => itemHtml(t, true)).join('')}
    </div>`;
  }
  for (const [cat, list] of byCat) {
    html += `<div class="card">
      <div class="card-title"><i data-lucide="folder"></i><span>${escapeHtml(cat)} · ${list.length}</span></div>
      ${list.map(t => itemHtml(t, false)).join('')}
    </div>`;
  }
  currentRoot.innerHTML = html;
  refreshIcons();
  currentRoot.querySelectorAll('[data-channel-id]').forEach(el => {
    el.addEventListener('click', () => openDetail(el.dataset.channelId));
  });
}

async function renderListView() {
  view = 'list';
  setLoading(currentRoot, 'Lade Tickets...');
  try {
    const d = await api(`/tickets/all?discordId=${encodeURIComponent(currentSession.discordId)}`);
    allTickets = d.items || [];
  } catch (e) {
    setError(currentRoot, e.message || 'Fehler beim Laden');
    return;
  }
  renderListContent();
}

function itemHtml(t, isMine) {
  const status = t.claim
    ? (isMine ? '<span class="li-tag success">Meins</span>' : '<span class="li-tag">Geclaimt</span>')
    : '<span class="li-tag warn">Offen</span>';
  const ava = t.creatorAvatar
    ? `<img class="li-avatar" src="${escapeHtml(t.creatorAvatar)}" alt="">`
    : `<div class="li-avatar">?</div>`;
  return `<div class="list-item${isMine ? ' mine' : ''}" data-channel-id="${escapeHtml(t.channelId)}">
    ${ava}
    <div class="li-body">
      <div class="li-title">#${escapeHtml(t.channelName)}</div>
      <div class="li-meta">${escapeHtml(t.creatorName || 'Unbekannt')} · ${timeAgo(t.lastMessageAt || t.createdAt)}</div>
    </div>
    ${status}
    <i data-lucide="chevron-right" class="li-chevron"></i>
  </div>`;
}

// ─── DETAIL VIEW ─────────────────────────────────────────
async function openDetail(channelId) {
  view = 'detail';
  activeChannelId = channelId;
  const t = allTickets.find(x => x.channelId === channelId);
  chatClaim = t?.claim || null;
  chatMessages = [];
  renderDetailShell(t);
  await loadHistory();
}

function renderDetailShell(t) {
  if (!t) {
    setError(currentRoot, 'Ticket nicht gefunden');
    return;
  }
  currentRoot.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="back-btn" id="tk-back"><i data-lucide="chevron-left"></i></button>
        <h2>#${escapeHtml(t.channelName)}</h2>
      </div>
      <div id="tk-banner"></div>
      <div id="tk-actions" class="action-row" style="margin-bottom:10px;"></div>
      <div class="chat-feed" id="tk-feed">
        <div class="loading"><div class="spinner"></div><span>Lade Verlauf...</span></div>
      </div>
      <div class="chat-input-row">
        <textarea id="tk-input" class="chat-input" rows="1" placeholder="Nachricht..."></textarea>
        <button class="btn primary" id="tk-send"><i data-lucide="send"></i></button>
      </div>
    </div>`;
  refreshIcons();
  document.getElementById('tk-back').addEventListener('click', () => renderListView());
  document.getElementById('tk-send').addEventListener('click', sendMessage);
  const input = document.getElementById('tk-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 100) + 'px';
  });
  renderBanner();
  renderActions();
}

function renderBanner() {
  const banner = document.getElementById('tk-banner');
  if (!banner) return;
  const myId = currentSession.discordId;
  if (!chatClaim) {
    banner.innerHTML = `<div class="banner warn"><i data-lucide="alert-triangle"></i><span>Noch nicht geclaimt</span></div>`;
  } else if (chatClaim.claimerDiscordId === myId) {
    banner.innerHTML = `<div class="banner success"><i data-lucide="check"></i><span>Du bearbeitest dieses Ticket</span></div>`;
  } else {
    banner.innerHTML = `<div class="banner danger"><i data-lucide="lock"></i><span>Geclaimt von ${escapeHtml(chatClaim.claimerName || '?')}</span></div>`;
  }
  refreshIcons();
}

function renderActions() {
  const row = document.getElementById('tk-actions');
  if (!row) return;
  const myId = currentSession.discordId;
  const isMine = chatClaim && chatClaim.claimerDiscordId === myId;
  const isClaimed = !!chatClaim;
  let html = '';
  if (!isClaimed) {
    html += `<button class="btn primary" data-act="claim"><i data-lucide="hand"></i><span>Claimen</span></button>`;
  }
  if (isMine) {
    html += `<button class="btn warn" data-act="transfer"><i data-lucide="refresh-cw"></i><span>Übergeben</span></button>`;
    html += `<button class="btn danger" data-act="close"><i data-lucide="lock"></i><span>Schließen</span></button>`;
  }
  row.innerHTML = html;
  refreshIcons();
  row.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'claim')    doClaim();
      else if (act === 'transfer') doTransfer();
      else if (act === 'close')    doClose();
    });
  });
}

async function loadHistory() {
  const feed = document.getElementById('tk-feed');
  if (!feed) return;
  try {
    const d = await api(`/ticket/history?channelId=${encodeURIComponent(activeChannelId)}&discordId=${encodeURIComponent(currentSession.discordId)}`);
    chatClaim = d.claim || chatClaim;
    chatMessages = d.messages || [];
    feed.innerHTML = '';
    for (const m of chatMessages) appendMsg(m);
    scrollFeed();
    renderBanner();
  } catch (e) {
    feed.innerHTML = `<div class="empty"><i data-lucide="alert-circle" style="color:var(--danger);"></i><span>${escapeHtml(e.message)}</span></div>`;
    refreshIcons();
  }
}

function appendMsg(m) {
  const feed = document.getElementById('tk-feed');
  if (!feed) return;
  const myId = currentSession.discordId;
  const isSelf = m.authorId === myId;
  const isBot = !!m.authorIsBot;
  const ava = m.authorAvatar
    ? `<img src="${escapeHtml(m.authorAvatar)}" alt="">`
    : `<div class="ava-fallback">${escapeHtml((m.authorName || '?').charAt(0).toUpperCase())}</div>`;
  const time = m.ts ? new Date(m.ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSelf ? ' is-self' : '') + (isBot ? ' is-bot' : '');
  div.innerHTML = `
    ${ava}
    <div class="chat-msg-body">
      <div class="chat-msg-name">${escapeHtml(m.authorName || 'User')}${isBot ? ' (Bot)' : ''}</div>
      <div class="chat-msg-text">${escapeHtml(m.content || '')}</div>
      ${time ? `<div class="chat-msg-time">${time}</div>` : ''}
    </div>`;
  feed.appendChild(div);
}

function scrollFeed() {
  const feed = document.getElementById('tk-feed');
  if (feed) feed.scrollTop = feed.scrollHeight;
}

async function sendMessage() {
  const input = document.getElementById('tk-input');
  const btn = document.getElementById('tk-send');
  if (!input || !activeChannelId) return;
  const text = input.value.trim();
  if (!text) return;
  if (btn) btn.disabled = true;
  try {
    await api('/ticket/reply', {
      method: 'POST',
      body: { channelId: activeChannelId, discordId: currentSession.discordId, text },
    });
    input.value = '';
    input.style.height = 'auto';
    // Optimistic: lade Verlauf neu (oder push manuell)
    appendMsg({
      authorId: currentSession.discordId,
      authorName: currentSession.username,
      authorAvatar: currentSession.avatar,
      content: text,
      ts: Date.now(),
    });
    scrollFeed();
  } catch (e) {
    toast('Senden fehlgeschlagen: ' + e.message, 'danger');
  } finally {
    if (btn) btn.disabled = false;
    input.focus();
  }
}

async function doClaim() {
  try {
    const d = await api('/ticket/claim', {
      method: 'POST',
      body: { channelId: activeChannelId, discordId: currentSession.discordId },
    });
    chatClaim = d.claim;
    renderBanner(); renderActions();
    toast('Ticket geclaimt', 'success');
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}

async function doTransfer() {
  const ok = await confirmModal({
    title: 'Übergeben?',
    text: 'Andere Staff sehen das Ticket dann wieder als verfügbar.',
    confirmLabel: 'Übergeben',
    icon: 'refresh-cw',
    kind: 'warn',
  });
  if (!ok) return;
  try {
    await api('/ticket/transfer', {
      method: 'POST',
      body: { channelId: activeChannelId, discordId: currentSession.discordId },
    });
    toast('Ticket freigegeben', 'success');
    renderListView();
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}

async function doClose() {
  const ok = await confirmModal({
    title: 'Ticket schließen?',
    text: 'Channel wird in 30s gelöscht. "cancel" im Discord-Chat bricht ab.',
    confirmLabel: 'Schließen',
    icon: 'lock',
    kind: 'danger',
  });
  if (!ok) return;
  try {
    await api('/ticket/close', {
      method: 'POST',
      body: { channelId: activeChannelId, discordId: currentSession.discordId },
    });
    toast('Ticket schließt in 30s', 'success');
    renderListView();
  } catch (e) {
    toast('Fehler: ' + e.message, 'danger');
  }
}
