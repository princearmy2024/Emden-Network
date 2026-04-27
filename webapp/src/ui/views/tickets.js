import { api, escapeHtml, timeAgo } from './api.js';

export async function renderTickets(root, session) {
  root.innerHTML = '<div class="loading">Lade Tickets...</div>';
  try {
    const d = await api(`/tickets/all?discordId=${encodeURIComponent(session.discordId)}`);
    const items = d.items || [];
    if (items.length === 0) {
      root.innerHTML = '<div class="empty">Keine offenen Tickets</div>';
      return;
    }
    const myId = session.discordId;
    const mine = items.filter(t => t.claim?.claimerDiscordId === myId);
    const others = items.filter(t => t.claim?.claimerDiscordId !== myId);

    let html = '';
    if (mine.length) {
      html += `<div class="card">
        <div class="card-title">📌 Meine Tickets · ${mine.length}</div>
        ${mine.map(itemHtml).join('')}
      </div>`;
    }
    // Gruppiere others nach Kategorie
    const byCat = new Map();
    for (const t of others) {
      const cat = t.category || 'Allgemein';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(t);
    }
    for (const [cat, list] of byCat) {
      html += `<div class="card">
        <div class="card-title">${escapeHtml(cat)} · ${list.length}</div>
        ${list.map(itemHtml).join('')}
      </div>`;
    }
    root.innerHTML = html;
  } catch (e) {
    root.innerHTML = `<div class="empty">Fehler: ${escapeHtml(e.message || String(e))}</div>`;
  }
}

function itemHtml(t) {
  const status = t.claim ? `<span class="list-item-tag">geclaimt</span>` : `<span class="list-item-tag" style="background:rgba(251,191,36,.15);color:#fbbf24;">offen</span>`;
  const ava = t.creatorAvatar
    ? `<img src="${escapeHtml(t.creatorAvatar)}" alt="">`
    : `<div class="avatar-fallback">?</div>`;
  return `<div class="list-item">
    ${ava}
    <div class="list-item-body">
      <div class="list-item-title">#${escapeHtml(t.channelName)}</div>
      <div class="list-item-meta">${escapeHtml(t.creatorName || 'Unbekannt')} · ${timeAgo(t.lastMessageAt || t.createdAt)}</div>
    </div>
    ${status}
  </div>`;
}
