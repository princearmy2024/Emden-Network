/**
 * Vercel Serverless Proxy → Bot auf Cybrancee
 *
 * Discord-Activity kann nicht direkt zu HTTP-Backends, also routen wir alles
 * von /api/* durch eine Vercel-Funktion zum Bot weiter (Vercel kann HTTP).
 *
 * Edge runtime: schnell, billig, weltweit verteilt.
 */
export const config = {
  runtime: 'edge',
};

const BOT_URL = 'http://91.98.124.212:5009';

export default async function handler(req) {
  const incoming = new URL(req.url);
  const target = BOT_URL + incoming.pathname + incoming.search;

  // Headers durchreichen, problematische Hosts/Connection rauswerfen
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
    headers.set(k, v);
  }

  const init = {
    method: req.method,
    headers,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  try {
    const r = await fetch(target, init);
    // Response-Headers durchreichen (CORS etc kommt vom Bot)
    const respHeaders = new Headers();
    r.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (lk === 'content-encoding' || lk === 'transfer-encoding') return;
      respHeaders.set(k, v);
    });
    return new Response(r.body, { status: r.status, headers: respHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Bot proxy failed: ' + (err?.message || err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
