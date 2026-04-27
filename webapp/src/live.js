/**
 * Live-Updates via Polling (Discord Activity Proxy unterstuetzt kein WebSocket
 * direkt, daher Polling als zuverlaessiger Fallback).
 *
 * Module:
 *  - LiveTickets: pollt /api/tickets/all alle 8s, broadcastet "ticket:update"
 *  - LiveCases:   pollt /api/support-cases/open alle 8s, broadcastet "case:update"
 *  - Beim Tab-Wechsel pausiert das Polling (visibilitychange).
 *
 * Andere Views koennen via on(eventName, handler) mithoeren.
 */
import { api } from './ui/views/api.js';

const listeners = new Map(); // eventName -> Set<handler>
let started = false;
let session = null;
let lastTicketsHash = '';
let lastCasesHash = '';
let lastTicketIds = new Set();
let lastCaseIds = new Set();
let pollingActive = true;

const INTERVAL_MS = 8000;

function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const h of set) {
    try { h(payload); } catch(e) { console.error('[live]', event, e); }
  }
}

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

async function pollTickets() {
  if (!pollingActive || !session) return;
  try {
    const d = await api(`/tickets/all?discordId=${encodeURIComponent(session.discordId)}`);
    const items = d.items || [];
    const hash = items.map(t => `${t.channelId}:${t.lastMessageAt}:${t.claim?.claimerDiscordId || ''}`).join('|');
    if (hash !== lastTicketsHash) {
      // Neue Tickets erkennen
      const newIds = new Set(items.map(t => t.channelId));
      const fresh = items.filter(t => !lastTicketIds.has(t.channelId));
      if (lastTicketIds.size > 0 && fresh.length > 0) {
        for (const t of fresh) emit('ticket:new', t);
      }
      lastTicketIds = newIds;
      lastTicketsHash = hash;
      emit('ticket:list', items);
    }
  } catch(_) {}
}

async function pollCases() {
  if (!pollingActive || !session) return;
  try {
    const d = await api(`/support-cases/open?discordId=${encodeURIComponent(session.discordId)}`);
    const cases = d.cases || [];
    const hash = cases.map(c => `${c.caseId}:${c.status}`).join('|');
    if (hash !== lastCasesHash) {
      const newIds = new Set(cases.map(c => c.caseId));
      const fresh = cases.filter(c => !lastCaseIds.has(c.caseId));
      if (lastCaseIds.size > 0 && fresh.length > 0) {
        for (const c of fresh) emit('case:new', c);
      }
      lastCaseIds = newIds;
      lastCasesHash = hash;
      emit('case:list', cases);
    }
  } catch(_) {}
}

export function start(initialSession) {
  if (started) return;
  started = true;
  session = initialSession;

  // Initialer Snapshot (damit "neue" Tickets nicht bei der allerersten Anzeige feuern)
  pollTickets();
  pollCases();

  setInterval(pollTickets, INTERVAL_MS);
  setInterval(pollCases, INTERVAL_MS);

  // Bei Tab-Wechsel/Sichtbarkeitswechsel Polling pausieren
  document.addEventListener('visibilitychange', () => {
    pollingActive = !document.hidden;
    if (pollingActive) { pollTickets(); pollCases(); }
  });
}
