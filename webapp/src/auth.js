/**
 * Discord Embedded App SDK — Auth Flow
 *
 * Lokales Dev-Setup (npm run dev) hat KEIN Discord-Context, dann fallen wir
 * auf einen Mock-Modus zurueck mit URL-Param ?dev=DISCORDID damit man
 * lokal testen kann ohne Discord.
 */
import { DiscordSDK } from '@discord/embedded-app-sdk';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;

let session = null;
let sdk = null;

export async function initAuth() {
  // Dev-Mode: lokales Testing ohne Discord-Embed
  // Aufruf: http://localhost:5173/?dev=YOUR_DISCORD_ID
  const url = new URL(window.location.href);
  const devId = url.searchParams.get('dev');
  const inDiscord = url.searchParams.has('frame_id') || url.searchParams.has('instance_id');

  if (!inDiscord && devId) {
    console.warn('[Auth] DEV-MODUS — kein Discord-Context, simuliere User', devId);
    session = {
      discordId: devId,
      username: 'Dev User',
      avatar: null,
      mode: 'dev',
    };
    return session;
  }

  if (!CLIENT_ID) {
    throw new Error('VITE_DISCORD_CLIENT_ID nicht gesetzt — pruefe .env / Vercel Env Vars');
  }

  // Discord SDK starten
  sdk = new DiscordSDK(CLIENT_ID);
  await sdk.ready();
  console.log('[Auth] Discord SDK ready');

  // Authorization Code holen
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify'],
  });

  // Code gegen Access Token tauschen — dafuer braucht der Bot einen Endpoint
  // (Client-Secret darf NIE im Frontend liegen, daher Server-Roundtrip)
  const apiBase = import.meta.env.VITE_API_BASE || '/api';
  const apiKey = import.meta.env.VITE_API_KEY || '';
  const tokenRes = await fetch(`${apiBase}/discord-token-exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ code }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => ({}));
    throw new Error('Token exchange fehlgeschlagen: ' + (err.error || tokenRes.status));
  }
  const { access_token } = await tokenRes.json();

  // SDK authentifizieren mit dem Token
  const auth = await sdk.commands.authenticate({ access_token });
  if (!auth) throw new Error('SDK Authenticate fehlgeschlagen');

  session = {
    discordId: auth.user.id,
    username: auth.user.global_name || auth.user.username,
    avatar: buildAvatarUrl(auth.user),
    accessToken: access_token,
    mode: 'discord',
  };
  return session;
}

function buildAvatarUrl(user) {
  if (!user) return null;
  if (user.avatar) {
    // Custom avatar (animated falls hash mit "a_" beginnt)
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
  }
  // Default avatar — Discord hat 6 Default-Variants
  try {
    const idx = Number((BigInt(user.id) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  } catch(_) {
    return `https://cdn.discordapp.com/embed/avatars/0.png`;
  }
}

export function getSession() { return session; }
export function getSdk() { return sdk; }
