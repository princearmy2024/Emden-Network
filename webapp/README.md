# Emden Network — Discord Activity

Eingebettete Web-App für Discord (läuft als Activity in einem Voice-Channel).
Teilt sich das Bot-Backend mit dem Electron-Dashboard, hat aber eine eigene UI für iPhone/Android/Web-Discord.

## Stack
- **Vite** (Vanilla JS)
- **@discord/embedded-app-sdk**
- Bot-API über Discord-Proxy (`/.proxy/api/...`)

## Lokale Entwicklung

```bash
cd webapp
npm install
cp .env.example .env
# Trag VITE_DISCORD_CLIENT_ID ein
npm run dev
```

Lokal ohne Discord-Embed testen:
```
http://localhost:5173/?dev=DEINE_DISCORD_ID
```
(Mock-Modus simuliert Auth, du brauchst trotzdem den Bot online für /api/check-staff.)

## Deploy auf Vercel

1. Vercel-Account anlegen, Repo verbinden
2. **Root Directory:** `webapp` setzen
3. Environment Variables in Vercel:
   - `VITE_DISCORD_CLIENT_ID` = Discord App ID
   - `VITE_API_BASE` = `/api`
   - `VITE_API_KEY` = `emden-super-secret-key-2026`
4. Deploy

## Discord-Setup
Im Dev Portal:
- **Aktivitäten → URL-Zuordnungen:**
  - `/` → `<dein-vercel-host>` (z.B. `emden-activity.vercel.app`)
  - `/api/` → `91.98.124.212:5009`
- **OAuth2 → Redirects:** `https://<dein-vercel-host>/`

## Bot-Endpoints die genutzt werden
- `POST /api/discord-token-exchange` — Code → Access Token (NEW)
- `POST /api/check-staff` — Staff/Admin-Check
- `GET /api/tickets/all` — Ticket-Liste
- `GET /api/mod-log` — Mod-Log
- `GET /api/support-cases/open` — Support-Cases
- `GET /api/shifts` — Leaderboard
