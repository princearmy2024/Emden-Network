/**
 * Vercel Serverless Proxy → Bot auf Cybrancee
 *
 * Discord-Activity ruft /api/<path> auf. Vercel-rewrites schicken alle
 * /api/* Requests hierher (mit Original-Pfad als ?_path=/api/foo Query).
 * Wir leiten dann an den Bot weiter (HTTP, IP-direkt — Node-Runtime erlaubt das).
 */
export const config = {
  api: { bodyParser: false }, // Body 1:1 durchreichen
};

import http from 'node:http';

const BOT_HOST = '91.98.124.212';
const BOT_PORT = 5009;

export default async function handler(req, res) {
  // Original-Pfad aus dem Rewrite-Query holen, sonst Default
  const url = new URL(req.url, 'http://localhost');
  const originalPath = url.searchParams.get('_path') || '/api/status';
  // _path raus, restliche Query erhalten
  url.searchParams.delete('_path');
  const restQuery = url.searchParams.toString();
  const targetPath = originalPath + (restQuery ? `?${restQuery}` : '');

  // Headers durchreichen
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];
  delete headers['x-vercel-deployment-url'];
  delete headers['x-vercel-id'];
  delete headers['x-vercel-forwarded-for'];
  delete headers['x-vercel-ip-country'];
  delete headers['x-vercel-ip-country-region'];
  delete headers['x-vercel-ip-city'];
  delete headers['x-vercel-ip-latitude'];
  delete headers['x-vercel-ip-longitude'];
  delete headers['x-vercel-ip-timezone'];

  const upstream = http.request(
    {
      host: BOT_HOST,
      port: BOT_PORT,
      method: req.method,
      path: targetPath,
      headers,
      timeout: 15000,
    },
    (botRes) => {
      const respHeaders = { ...botRes.headers };
      delete respHeaders['transfer-encoding'];
      delete respHeaders['content-encoding'];
      res.writeHead(botRes.statusCode || 502, respHeaders);
      botRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    console.error('[Proxy] Bot unreachable:', err.message, '| target:', targetPath);
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

  req.pipe(upstream);
}
