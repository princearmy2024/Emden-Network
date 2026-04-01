// index.js — Emden Network Bot (finale, einfache Version)
import {
    Client, GatewayIntentBits, REST, Routes,
    Collection, Partials, ActivityType
} from "discord.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { verificationCodes } from "./data/verificationStore.js";
import { Server as SocketIOServer } from "socket.io";
import crypto from "node:crypto";

dotenv.config();

const GUILD_ID = "1365082225296674970";
const API_PORT = process.env.SERVER_PORT || process.env.PORT || 5009;
const API_SECRET = process.env.API_SECRET || "emden-super-secret-key-2026";
const STATUS_UPDATE_INTERVAL = 60 * 1000;

// === Roblox OAuth2 Config ===
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || '';
const ROBLOX_REDIRECT_URI = process.env.ROBLOX_REDIRECT_URI || 'http://localhost:7329/roblox-callback';
const robloxStates = new Map(); // state → { discordId, expires }

// === Overlay & Roblox Link Tracking ===
const ON_DUTY_ROLE_ID = "1367160344992284803";
const LINKS_FILE = path.join(path.resolve(), "data", "robloxLinks.json");
const robloxLinks = new Map(); // discordId -> roblox userId

// Links beim Start laden
if (fs.existsSync(LINKS_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(LINKS_FILE, "utf-8"));
        for (const [dId, rId] of Object.entries(data)) {
            robloxLinks.set(dId, rId);
        }
        console.log(`✅ ${robloxLinks.size} Roblox-Links geladen.`);
    } catch (e) {
        console.error("❌ Fehler beim Laden der Roblox-Links:", e.message);
    }
}

function saveLinks() {
    try {
        const data = Object.fromEntries(robloxLinks);
        if (!fs.existsSync(path.dirname(LINKS_FILE))) fs.mkdirSync(path.dirname(LINKS_FILE), { recursive: true });
        fs.writeFileSync(LINKS_FILE, JSON.stringify(data, null, 2));
    } catch (e) { console.error("❌ Fehler beim Speichern der Roblox-Links:", e.message); }
}

const robloxPresenceState = new Map(); // discordId -> boolean (isPlaying)
const overlayClients = new Map(); // socket.id -> { discordId, isAdmin }

// === Bot ===
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

client.commands = new Collection();
const commandsForDiscord = [];

// === Commands laden ===
const commandsPath = path.join(path.resolve(), "commands");
if (fs.existsSync(commandsPath)) {
    for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"))) {
        const cmd = (await import(`file://${path.join(commandsPath, file)}`)).default;
        if (cmd && "data" in cmd && "execute" in cmd) {
            client.commands.set(cmd.data.name, cmd);
            commandsForDiscord.push(cmd.data.toJSON());
            console.log(`✅ Command geladen: /${cmd.data.name}`);
        }
    }
}

// === Events laden ===
const eventsPath = path.join(path.resolve(), "events");
if (fs.existsSync(eventsPath)) {
    for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith(".js"))) {
        const evt = (await import(`file://${path.join(eventsPath, file)}`)).default;
        if (!evt?.name || !evt?.execute) continue;
        evt.once
            ? client.once(evt.name, (...a) => evt.execute(...a))
            : client.on(evt.name, (...a) => evt.execute(...a));
        console.log(`✅ Event geladen: ${evt.name}`);
    }
}

// === Slash Commands registrieren (Guild = sofort!) ===
const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
(async () => {
    try {
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
            { body: commandsForDiscord }
        );
        console.log("✅ Slash Commands sofort registriert!");
    } catch (e) { console.error("❌ Commands:", e.message); }
})();

// === 🌐 API Server ===
// Wer gerade im Dashboard ist (Heartbeat-System)
const dashboardUsers = new Map(); // discordId → { username, avatar, lastSeen }

const apiServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

    const url = new URL(req.url, "http://localhost");

    // === Öffentliche Roblox OAuth Endpoints (kein API-Key nötig) ===
    // Diese werden direkt vom Browser aufgerufen (OAuth Callback)
    const publicPaths = ["/api/roblox/auth", "/api/roblox/callback", "/api/roblox/start-verify", "/api/roblox/confirm-verify"];
    const isPublic = publicPaths.some(p => url.pathname === p);

    if (!isPublic && req.headers["x-api-key"] !== API_SECRET) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    // POST /api/verify
    if (req.method === "POST" && url.pathname === "/api/verify") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { code } = JSON.parse(body || "{}");
                const upperCode = (code || "").trim().toUpperCase();

                console.log(`[API] Verify-Versuch: "${upperCode}" | Store hat ${verificationCodes.size} Codes`);

                if (!upperCode) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Kein Code." }));
                }

                const entry = verificationCodes.get(upperCode);
                if (!entry) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ success: false, error: "Ungültiger Code. Bitte /verify erneut nutzen." }));
                }

                if (Date.now() > entry.expiresAt) {
                    verificationCodes.delete(upperCode);
                    res.writeHead(410);
                    return res.end(JSON.stringify({ success: false, error: "Code abgelaufen. Bitte /verify erneut nutzen." }));
                }

                verificationCodes.delete(upperCode);

                let isAdmin = false;
                try {
                    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(entry.discordId).catch(() => null);
                    if (member) {
                        isAdmin = member.permissions.has("Administrator") ||
                            member.roles.cache.some(r => r.name.toLowerCase().includes("admin"));
                    }
                } catch (_) { }

                console.log(`[API] ✅ ${entry.username} eingeloggt — ${isAdmin ? "ADMIN" : "USER"}`);

                res.writeHead(200);
                return res.end(JSON.stringify({
                    success: true,
                    user: {
                        id: entry.discordId, username: entry.username,
                        tag: entry.tag, avatar: entry.avatar,
                        role: isAdmin ? "admin" : "user", discordId: entry.discordId,
                    }
                }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/heartbeat — App meldet sich alle 30s
    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
            try {
                const { discordId, username, avatar, role } = JSON.parse(body || "{}");
                if (discordId) {
                    dashboardUsers.set(discordId, { username, avatar, role, lastSeen: Date.now() });
                }
                // Alte User (> 90s keine Meldung) entfernen
                const cutoff = Date.now() - 90000;
                for (const [id, u] of dashboardUsers.entries()) {
                    if (u.lastSeen < cutoff) dashboardUsers.delete(id);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, dashboardOnline: dashboardUsers.size }));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false }));
            }
        });
        return;
    }

    // POST /api/link-roblox — Verbindet Roblox Account
    if (req.method === "POST" && url.pathname === "/api/link-roblox") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { discordId, robloxUsername } = JSON.parse(body || "{}");
                if (!discordId || !robloxUsername) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Fehlende Parameter" }));
                }

                // Roblox API abfragen
                const r = await fetch(`https://users.roblox.com/v1/usernames/users`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usernames: [robloxUsername] })
                });

                if (!r.ok) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ success: false, error: 'Roblox API Fehler' }));
                }

                const data = await r.json();

                if (!data.data || data.data.length === 0) {
                    res.writeHead(404);
                    return res.end(JSON.stringify({ success: false, error: 'Roblox User nicht gefunden' }));
                }

                const robloxId = data.data[0].id;
                const robloxName = data.data[0].name;

                // Hier könnte man den User in der jsondb oder mysql speichern
                // ... für jetzt geben wir nur den Avatar und Erfolg zurück
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, robloxId, robloxName }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/status
    if (req.method === "GET" && url.pathname === "/api/status") {
        try {
            const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            const members = guild?.memberCount || 0;
            const online = guild?.members.cache.filter(m =>
                ["online", "dnd", "idle"].includes(m.presence?.status)
            ).size || 0;

            // Alte Dashboard-User aufräumen
            const cutoff = Date.now() - 90000;
            for (const [id, u] of dashboardUsers.entries()) {
                if (u.lastSeen < cutoff) dashboardUsers.delete(id);
            }

            res.writeHead(200);
            return res.end(JSON.stringify({
                online: true, guildName: guild?.name || "Emden Network",
                members, onlineMembers: online,
                dashboardOnline: dashboardUsers.size,
                dashboardUsers: [...dashboardUsers.values()].map(u => ({
                    username: u.username, avatar: u.avatar, role: u.role
                })),
                botTag: client.user?.tag || "—",
                uptimeSec: Math.floor(process.uptime()),
            }));
        } catch (e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ online: false, error: e.message }));
        }
    }

    // ===================================================
    // GET /api/roblox/auth?discordId=xxx
    // Gibt eine OAuth URL zurück — kein API-Key nötig weil nur URL generiert wird
    // ===================================================
    if (req.method === "GET" && url.pathname === "/api/roblox/auth") {
        const discordId = url.searchParams.get("discordId");
        if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId required" })); }
        if (!ROBLOX_CLIENT_ID) { res.writeHead(503); return res.end(JSON.stringify({ error: "Roblox OAuth nicht konfiguriert" })); }

        // CSRF State generieren (10 Minuten gültig)
        const state = crypto.randomBytes(16).toString("hex");
        robloxStates.set(state, { discordId, expires: Date.now() + 10 * 60 * 1000 });

        const params = new URLSearchParams({
            client_id: ROBLOX_CLIENT_ID,
            redirect_uri: ROBLOX_REDIRECT_URI,
            response_type: "code",
            scope: "openid profile",
            state,
        });

        res.writeHead(200);
        return res.end(JSON.stringify({ url: `https://apis.roblox.com/oauth/v1/authorize?${params}` }));
    }

    // ===================================================
    // GET /api/roblox/callback?code=xxx&state=xxx
    // Roblox leitet hierher nach dem Login
    // ===================================================
    if (req.method === "GET" && url.pathname === "/api/roblox/callback") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        const stateEntry = robloxStates.get(state);
        robloxStates.delete(state);

        const closeHtml = (title, icon, msg, color) => `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>${title}</title>
        <style>*{margin:0;padding:0;box-sizing:border-box} body{background:#0a0a0f;color:#fff;font-family:-apple-system,system-ui,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
        .card{background:#14141e;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:48px 56px;text-align:center;max-width:460px}
        .icon{font-size:56px;margin-bottom:20px} h1{font-size:22px;margin-bottom:8px;color:${color}} p{color:rgba(255,255,255,.5);font-size:14px;line-height:1.6}
        </style><script>setTimeout(()=>window.close(),3000)</script></head>
        <body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${msg}<br><br>Dieses Fenster schließt sich automatisch.</p></div></body></html>`;

        if (error || !code || !stateEntry) {
            const { discordId } = stateEntry || {};
            if (discordId) io.emit(`roblox_error_${discordId}`, { error: error || "Vorgang abgebrochen" });
            res.writeHead(200);
            return res.end(closeHtml("Abgebrochen", "❌", "Die Roblox-Verbindung wurde abgebrochen.", "#ff4757"));
        }

        if (Date.now() > stateEntry.expires) {
            io.emit(`roblox_error_${stateEntry.discordId}`, { error: "Sitzung abgelaufen" });
            res.writeHead(200);
            return res.end(closeHtml("Abgelaufen", "⏱️", "Die Sitzung ist abgelaufen. Bitte erneut versuchen.", "#ffa502"));
        }

        try {
            // 1. Code gegen Token tauschen
            const tokenRes = await fetch("https://apis.roblox.com/oauth/v1/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: ROBLOX_REDIRECT_URI,
                    client_id: ROBLOX_CLIENT_ID,
                    client_secret: ROBLOX_CLIENT_SECRET,
                }),
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error("Token ungültig: " + JSON.stringify(tokenData));

            // 2. OAuth UserInfo laden
            const userInfoRes = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            const userInfo = await userInfoRes.json();
            const userId = userInfo.sub;

            // 3. Öffentliche Roblox-Daten + Avatar laden
            const [publicRes, avatarRes] = await Promise.allSettled([
                fetch(`https://users.roblox.com/v1/users/${userId}`),
                fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`),
            ]);
            const publicData = publicRes.status === "fulfilled" ? await publicRes.value.json() : {};
            const avatarData = avatarRes.status === "fulfilled" ? await avatarRes.value.json() : {};

            const profile = {
                userId,
                username: userInfo.name || publicData.name || "Unbekannt",
                displayName: publicData.displayName || userInfo.name || "Unbekannt",
                avatar: avatarData.data?.[0]?.imageUrl || null,
                description: publicData.description || null,
                created: publicData.created || null,
                profileUrl: `https://www.roblox.com/users/${userId}/profile`,
                connectedAt: new Date().toISOString(),
            };

            // 4. Profil ans Dashboard senden
            robloxLinks.set(stateEntry.discordId, profile.userId);
            saveLinks();
            io.emit(`roblox_connected_${stateEntry.discordId}`, profile);

            res.writeHead(200);
            return res.end(closeHtml("Verbunden! 🎮", "✅", `Willkommen, <strong>${profile.displayName}</strong>!<br>Dein Roblox-Konto wurde erfolgreich verbunden.`, "#00D1A7"));

        } catch (e) {
            console.error("[Roblox OAuth]", e.message);
            io.emit(`roblox_error_${stateEntry.discordId}`, { error: e.message });
            res.writeHead(200);
            return res.end(closeHtml("Fehler", "⚠️", "Ein Fehler ist aufgetreten. Bitte erneut versuchen.", "#ff6b81"));
        }
    }

    // ===================================================
    // POST /api/roblox/start-verify  { discordId, robloxUsername }
    // Schritt 1: Generiert einen Code, den der User in seine Bio einträgt
    // ===================================================
    if (req.method === "POST" && url.pathname === "/api/roblox/start-verify") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { discordId, robloxUsername } = JSON.parse(body || "{}");
                if (!discordId || !robloxUsername) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId und robloxUsername erforderlich" })); }

                // Roblox User-ID per Benutzername suchen
                const searchRes = await fetch(`https://users.roblox.com/v1/usernames/users`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true }),
                });
                const searchData = await searchRes.json();
                const robloxUser = searchData.data?.[0];
                if (!robloxUser) { res.writeHead(404); return res.end(JSON.stringify({ error: "Roblox-Benutzer nicht gefunden" })); }

                const code = "EMDEN-" + crypto.randomBytes(4).toString("hex").toUpperCase();
                robloxStates.set(`verify_${discordId}`, { userId: robloxUser.id, username: robloxUser.name, code, expires: Date.now() + 15 * 60 * 1000 });

                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, code, userId: robloxUser.id, username: robloxUser.name }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ===================================================
    // POST /api/roblox/confirm-verify  { discordId }
    // Schritt 2: Prüft ob der Code in der Roblox-Bio steht
    // ===================================================
    if (req.method === "POST" && url.pathname === "/api/roblox/confirm-verify") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                const entry = robloxStates.get(`verify_${discordId}`);
                if (!entry) { res.writeHead(400); return res.end(JSON.stringify({ error: "Kein Verifikations-Code gefunden. Bitte neu starten." })); }
                if (Date.now() > entry.expires) { robloxStates.delete(`verify_${discordId}`); res.writeHead(410); return res.end(JSON.stringify({ error: "Code abgelaufen. Bitte neu starten." })); }

                // Roblox-Bio prüfen
                const profileRes = await fetch(`https://users.roblox.com/v1/users/${entry.userId}`);
                const profileData = await profileRes.json();
                if (!profileData.description?.includes(entry.code)) {
                    res.writeHead(409);
                    return res.end(JSON.stringify({ error: `Code nicht in Bio gefunden. Füge "${entry.code}" zu deiner Roblox-Bio hinzu.` }));
                }

                // Avatar laden
                const avatarRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${entry.userId}&size=420x420&format=Png&isCircular=false`);
                const avatarData = await avatarRes.json();

                const profile = {
                    userId: entry.userId,
                    username: profileData.name,
                    displayName: profileData.displayName || profileData.name,
                    avatar: avatarData.data?.[0]?.imageUrl || null,
                    description: profileData.description || null,
                    created: profileData.created || null,
                    profileUrl: `https://www.roblox.com/users/${entry.userId}/profile`,
                    connectedAt: new Date().toISOString(),
                };

                robloxStates.delete(`verify_${discordId}`);
                robloxLinks.set(discordId, profile.userId);
                saveLinks();
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, profile }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // GET /api/roblox/profile?discordId=...
    if (req.method === "GET" && url.pathname === "/api/roblox/profile") {
        const discordId = url.searchParams.get("discordId");
        const rId = robloxLinks.get(discordId);
        if (!rId) {
            res.writeHead(404);
            return res.end(JSON.stringify({ success: false, error: "Kein Link gefunden." }));
        }

        try {
            // Profil von Roblox laden
            const [pRes, aRes] = await Promise.allSettled([
                fetch(`https://users.roblox.com/v1/users/${rId}`),
                fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${rId}&size=420x420&format=Png&isCircular=false`)
            ]);
            const pData = pRes.status === "fulfilled" ? await pRes.value.json() : {};
            const aData = aRes.status === "fulfilled" ? await aRes.value.json() : {};

            const profile = {
                userId: rId,
                username: pData.name || "Unbekannt",
                displayName: pData.displayName || pData.name || "Unbekannt",
                avatar: aData.data?.[0]?.imageUrl || null,
                description: pData.description || null,
                profileUrl: `https://www.roblox.com/users/${rId}/profile`,
                connectedAt: new Date().toISOString()
            };
            res.writeHead(200);
            return res.end(JSON.stringify({ success: true, profile }));
        } catch (e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ success: false, error: e.message }));
        }
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
});

// === WebSockets für Live-Chat ===
const io = new SocketIOServer(apiServer, {
    cors: { origin: "*" }
});

const chatHistory = []; // max 50 Nachrichten

// ================================================================
// 🎙️ GLOBALE Voice-User Tracking Map (MUSS global sein!)
// Vorher war diese Map lokal pro Socket → kritischer Bug behoben
// ================================================================
const activeVoiceUsers = new Map(); // socketId → { channelId, username, discordId }

// Hilfsfunktion: Aktuellen Voice-Status als Array bauen und an alle senden
function broadcastVoiceState() {
    const voiceChannels = [
        { id: 'vc-1', name: 'voice-general', type: 'public', active: false, members: [] },
        { id: 'vc-2', name: 'ops-room',      type: 'private', active: false, members: [] }
    ];
    for (const user of activeVoiceUsers.values()) {
        const vc = voiceChannels.find(v => v.id === user.channelId);
        if (vc && user.username && !vc.members.includes(user.username)) {
            vc.members.push(user.username);
        }
    }
    io.emit('voice_channel_members', voiceChannels);
    console.log('[Voice] 📡 Broadcast state:', voiceChannels.map(v => `${v.id}:[${v.members.join(',')}]`).join(' | '));
}

function broadcastOnlineUsers() {
    // Alte User (> 30s) entfernen
    const cutoff = Date.now() - 35000;
    for (const [id, u] of dashboardUsers.entries()) {
        if (u.lastSeen < cutoff) dashboardUsers.delete(id);
    }

    const users = [...dashboardUsers.values()].map(u => ({
        username: u.username, avatar: u.avatar, role: u.role
    }));

    io.emit("online_users", users);
}

io.on("connection", (socket) => {
    // Wenn ein Dashboard-User sich verbindet, sende die Historie
    socket.emit("chat_history", chatHistory);

    socket.on("overlay_client_connect", ({ discordId, robloxId, isAdmin }) => {
        if (discordId) overlayClients.set(socket.id, { discordId, isAdmin });

        // Re-verknüpfung im Speicher, falls Bot neugestartet ist
        if (discordId && robloxId) {
            robloxLinks.set(discordId, robloxId);
        }

        // Force update für den Supporter-Count beim Verbinden
        socket.emit("overlay_supporter_count", { count: Math.max(0, lastSupporterCount) });
        // Sende aktuellen Spiel-Status, falls schon aktiv 
        if (discordId && robloxPresenceState.get(discordId)) {
            socket.emit(`overlay_game_start_${discordId}`, { startTime: Date.now() });
        }
    });

    socket.on("disconnect", () => {
        overlayClients.delete(socket.id);
    });

    // User schickt Heartbeat via Socket für sofortiges Update
    socket.on("client_online", (user) => {
        if (user && user.discordId) {
            dashboardUsers.set(user.discordId, {
                username: user.username,
                avatar: user.avatar,
                role: user.role,
                lastSeen: Date.now()
            });
            broadcastOnlineUsers();
        }
    });

    socket.on("send_message", (msgData) => {
        // Nachricht speichern
        chatHistory.push(msgData);
        if (chatHistory.length > 50) chatHistory.shift();

        // An ALLE anderen Dashboards senden
        socket.broadcast.emit("receive_message", msgData);
    });

    // ================================================================
    // 🎙️ WALKIE-TALKIE VOICE SYSTEM (v2 — Global Tracking)
    // ================================================================

    // User tritt einem Sprachkanal bei → socket.io "room" beitreten
    socket.on("voice_channel_join", ({ channelId, username, discordId }) => {
        if (!channelId || !username) return;

        // Alle alten Voice-Rooms verlassen
        for (const room of socket.rooms) {
            if (room.startsWith("voice:") && room !== socket.id) {
                socket.leave(room);
            }
        }

        const room = `voice:${channelId}`;
        socket.join(room);

        socket.currentVoiceChannel = channelId;
        socket.voiceUsername        = username || "User";
        socket.voiceDiscordId       = discordId || "";

        // Globale Map aktualisieren
        activeVoiceUsers.set(socket.id, { channelId, username, discordId: discordId || '' });
        console.log(`[Voice] ✅ ${username} ist #${channelId} beigetreten (${activeVoiceUsers.size} aktive User)`);

        // Alle benachrichtigen wer wo ist
        broadcastVoiceState();
    });

    // User verlässt Kanal manuell (ohne App zu schließen)
    socket.on("voice_channel_leave", ({ channelId, username, discordId }) => {
        if (!channelId) return;

        const room = `voice:${channelId}`;
        socket.leave(room);

        // PTT-Stop senden falls noch aktiv
        socket.to(room).emit("voice_ptt_stop", {
            channelId, username: username || socket.voiceUsername || 'User',
            discordId: discordId || socket.voiceDiscordId || '',
        });

        activeVoiceUsers.delete(socket.id);
        socket.currentVoiceChannel = null;
        socket.voiceUsername        = null;

        console.log(`[Voice] 🚪 ${username} hat #${channelId} verlassen`);
        broadcastVoiceState();
    });

    // Kanal erstellen → an alle broadcasten
    socket.on("voice_create_channel", (newVC) => {
        socket.broadcast.emit("voice_created", newVC);
    });

    // PTT Start → nur an Leute im selben Voice-Channel
    socket.on("voice_ptt_start", (data) => {
        const room = `voice:${data.channelId}`;
        socket.to(room).emit("voice_ptt_start", data);
        console.log(`[Voice] 🔴 ${data.username} sendet in #${data.channelId}`);
    });

    // PTT Stop → nur an Leute im selben Voice-Channel
    socket.on("voice_ptt_stop", (data) => {
        const room = `voice:${data.channelId}`;
        socket.to(room).emit("voice_ptt_stop", data);
        console.log(`[Voice] ⏹ ${data.username} stoppt in #${data.channelId}`);
    });

    // Audio-Chunk → nur an Leute im selben Voice-Channel (NICHT zurück an Sender)
    socket.on("voice_audio_chunk", (data) => {
        const room = `voice:${data.channelId}`;
        socket.to(room).emit("voice_audio_chunk", data);
    });

    // Beim Disconnect: Aufräumen
    socket.on("disconnect", () => {
        overlayClients.delete(socket.id);

        if (activeVoiceUsers.has(socket.id)) {
            const user = activeVoiceUsers.get(socket.id);
            const room = `voice:${user.channelId}`;

            // PTT-Stop an alle im Raum senden (falls User noch sprach)
            io.to(room).emit("voice_ptt_stop", {
                channelId: user.channelId,
                username:  user.username,
                discordId: user.discordId || '',
            });

            activeVoiceUsers.delete(socket.id);
            console.log(`[Voice] 🔌 ${user.username} disconnected — aus #${user.channelId} entfernt`);

            // Allen den neuen State senden
            broadcastVoiceState();
        }
    });
});

apiServer.listen(API_PORT, "0.0.0.0", () => {
    console.log(`🌐 Dashboard-API läuft auf Port ${API_PORT} (inkl. WebSockets)`);
});

// === Reminder ===
async function sendReminder(ci, entry, msg) {
    const b = await ci.users.fetch(entry.bewerber).catch(() => null);
    const p = await ci.users.fetch(entry.pruefer).catch(() => null);
    const d = new Date(entry.date).toLocaleDateString("de-DE",
        { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
    const t = `${msg}\n📆 **Datum:** ${d} - ${entry.stunde}:${entry.minute} Uhr\n👤 ${p ? `<@${p.id}>` : "?"}`;
    if (b) await b.send(t).catch(() => { });
    if (p) await p.send(t).catch(() => { });
}
function startReminderScheduler(ci) {
    setInterval(async () => {
        const fp = "./kalender.json";
        if (!fs.existsSync(fp)) return;
        let k; try { k = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return; }
        const now = new Date(); let changed = false;
        for (const e of k.dates ?? []) {
            if (!e.date) continue;
            const et = new Date(e.date); if (et < now) continue;
            const d = et.getTime() - now.getTime();
            if (!e.dayReminderSent && d <= 86400000) { await sendReminder(ci, e, "📅 Morgen ist dein Gespräch!"); e.dayReminderSent = true; changed = true; }
            if (!e.hourReminderSent && d <= 3600000) { await sendReminder(ci, e, "⏰ In 1 Stunde ist dein Gespräch!"); e.hourReminderSent = true; changed = true; }
            if (!e.minuteReminderSent && d <= 60000) { await sendReminder(ci, e, "🚨 In 1 Minute beginnt dein Gespräch!"); e.minuteReminderSent = true; changed = true; }
        }
        if (changed) fs.writeFileSync(fp, JSON.stringify(k, null, 2));
    }, 60000);
}

async function updateBotStatus(ci) {
    try {
        const guild = ci.guilds.cache.get(GUILD_ID) || await ci.guilds.fetch(GUILD_ID);
        if (!guild) return;
        await ci.user.setPresence({
            activities: [{ name: `Emden Network • ${guild.memberCount} Mitglieder`, type: ActivityType.Watching }],
            status: "online"
        });
    } catch (e) { console.error("[STATUS]", e.message); }
}

// ================================================================
// 🚀 GITHUB RELEASE MONITOR — Sendet schönes Embed bei neuem Tag
// ================================================================
const GITHUB_OWNER = 'princearmy2024';
const GITHUB_REPO  = 'Emden-Network';
const UPDATE_WEBHOOK_URL = process.env.UPDATE_WEBHOOK_URL ||
    'https://discord.com/api/webhooks/1488902385786028084/MNd5QLJOThjoA8JZP2LDr2l3-dDzzQVCz4pCqCsMTEVVjIwnMfmqmlyvHXeSosXwOZPc';

let lastKnownTag = null;

async function checkGithubRelease() {
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
            headers: { 'User-Agent': 'EmdenNetwork-Bot' }
        });
        if (!res.ok) return;
        const release = await res.json();
        if (!release?.tag_name) return;

        // Beim ersten Check nur speichern, nicht senden
        if (!lastKnownTag) {
            lastKnownTag = release.tag_name;
            console.log(`[Update] Aktueller Tag: ${lastKnownTag}`);
            return;
        }

        if (release.tag_name === lastKnownTag) return;

        // Neuer Tag → Embed senden
        lastKnownTag = release.tag_name;
        const version = release.tag_name.replace('v', '');
        const notes = (release.body || 'Keine Änderungen angegeben.')
            .split('\n').slice(0, 8).join('\n').trim();
        const downloadUrl = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/EmdenNetworkSetup.exe`;
        const releaseUrl  = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${release.tag_name}`;
        const avatarUrl   = `https://github.com/${GITHUB_OWNER}.png`;
        const now         = new Date();
        const dateStr     = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

        const payload = JSON.stringify({
            username:   'Emden Network Updates',
            avatar_url: avatarUrl,
            embeds: [{
                author: {
                    name:     'Neues Update veröffentlicht',
                    icon_url: avatarUrl
                },
                title:       `⬆️  Emden Network Control Center — ${release.tag_name}`,
                description: '> Eine neue Version ist verfügbar. Bitte aktualisiere dein Dashboard.',
                color:       0x00D1A7,
                fields: [
                    { name: '📦  Version',   value: `\`${version}\``,  inline: true  },
                    { name: '✅  Status',    value: '`Stabil`',         inline: true  },
                    { name: '📅  Datum',     value: `\`${dateStr}\``,   inline: true  },
                    { name: '📝  Änderungen', value: notes.length > 0 ? `\`\`\`\n${notes}\n\`\`\`` : '_Keine Beschreibung_', inline: false },
                    { name: '📥  Download',  value: `[Setup herunterladen](${downloadUrl})`, inline: true  },
                    { name: '🔗  Release',   value: `[GitHub Release](${releaseUrl})`,        inline: true  }
                ],
                footer: {
                    text:     'Emden Network • Control Center',
                    icon_url: avatarUrl
                },
                timestamp: now.toISOString()
            }]
        });

        await fetch(UPDATE_WEBHOOK_URL, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    payload
        });
        console.log(`[Update] ✅ Discord-Benachrichtigung gesendet für ${release.tag_name}`);
    } catch (e) {
        console.error('[Update] Fehler beim GitHub-Check:', e.message);
    }
}

client.once("ready", async () => {
    console.log(`🤖 ${client.user.tag} ist online!`);
    startReminderScheduler(client);
    await client.guilds.fetch().catch(() => { });
    await updateBotStatus(client);
    setInterval(() => updateBotStatus(client), STATUS_UPDATE_INTERVAL);
    startOverlayDataLoop();

    // GitHub Release Monitor starten
    await checkGithubRelease(); // Beim Start: aktuellen Tag speichern
    setInterval(checkGithubRelease, 5 * 60 * 1000); // Alle 5 Minuten prüfen
});

client.on("channelCreate", channel => {
    if (channel.name && channel.name.startsWith("ticket-")) {
        const reason = channel.parent ? `Kategorie: ${channel.parent.name}` : "Neues Ticket";
        const ticketId = channel.name.replace("ticket-", "");
        io.emit("overlay_new_ticket", { ticketId, reason });
    }
});

let lastSupporterCount = -1;
function startOverlayDataLoop() {
    setInterval(async () => {
        // 1. Supporter Count (On Duty Rolle)
        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                const role = await guild.roles.fetch(ON_DUTY_ROLE_ID).catch(() => null);
                if (role) {
                    const count = role.members.size;
                    if (count !== lastSupporterCount) {
                        lastSupporterCount = count;
                        io.emit("overlay_supporter_count", { count });
                    }
                }
            }
        } catch (e) { console.error("[Overlay] Fehler beim Supporter-Count:", e.message); }

        // 2. Roblox Presence Tracker (Gespieltes Spiel == Emergency Emden)
        if (robloxLinks.size > 0 && overlayClients.size > 0) {
            try {
                const userIds = Array.from(new Set(Array.from(robloxLinks.values())));
                if (userIds.length > 0) {
                    const reqIds = userIds.map(id => ({ userId: Number(id) }));
                    const res = await fetch("https://presence.roblox.com/v1/presence/users", {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userIds: reqIds })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        for (const pres of data.userPresences) {
                            const rId = String(pres.userId);
                            let dId = null;
                            for (const [key, val] of robloxLinks.entries()) {
                                if (String(val) === rId) { dId = key; break; }
                            }
                            if (dId) {
                                const isPlayingEmden = pres.userPresenceType === 2 &&
                                    (String(pres.placeId) === "12716055617" || String(pres.rootPlaceId) === "12716055617");
                                const prevState = robloxPresenceState.get(dId) || false;

                                if (isPlayingEmden && !prevState) {
                                    robloxPresenceState.set(dId, true);
                                    io.emit(`overlay_game_start_${dId}`, { startTime: Date.now() });
                                } else if (!isPlayingEmden && prevState) {
                                    robloxPresenceState.set(dId, false);
                                    io.emit(`overlay_game_end_${dId}`);
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                // Leiser Fehlschlag bei Roblox API Errors
            }
        }
    }, 15000); // Alle 15 Sekunden prüfen
}

client.login(process.env.TOKEN).catch(e => console.error("❌ Login:", e));
