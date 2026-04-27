/**
 * Vercel Serverless Proxy → Bot auf Cybrancee
 *
 * Discord-Activity kann nicht direkt zu HTTP-Backends. Edge-Runtime erlaubt
 * keine direkten IPs (siehe DOMAIN_RESTRICTION error). Daher Node-Runtime.
 */
export const config = {
  api: { bodyParser: false }, // wir streamen den Body durch
};

const BOT_HOST = '91.98.124.212';
const BOT_PORT = 5009;

import http from 'node:http';

export default async function handler(req, res) {
  const path = req.url; // bereits inkl. /api/...
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];
  delete headers['x-vercel-deployment-url'];
  delete headers['x-vercel-id'];
  delete headers['x-vercel-forwarded-for'];

  const upstream = http.request(
    {
      host: BOT_HOST,
      port: BOT_PORT,
      method: req.method,
      path,
      headers,
      timeout: 15000,
    },
    (botRes) => {
      // Status + Headers durchreichen
      const respHeaders = { ...botRes.headers };
      delete respHeaders['transfer-encoding'];
      delete respHeaders['content-encoding']; // Vercel re-encoded selber
      res.writeHead(botRes.statusCode || 502, respHeaders);
      botRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    console.error('[Proxy] Bot unreachable:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bot proxy failed: ' + err.message }));
    }
  });

  upstream.on('timeout', () => {
    upstream.destroy();
    if (!res.headersSent) {
      res.writeHead(504, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bot proxy timeout' }));
    }
  });

  // Request-Body streamen
  req.pipe(upstream);
}
