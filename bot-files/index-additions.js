// ============================================================
// ANLEITUNG: Diese Blöcke in deine bestehende index.js einfügen
// Kein "npm install" nötig — nutzt nur eingebaute Node.js Module!
// ============================================================

// ----- SCHRITT 1: Diese 2 Zeilen OBEN in index.js hinzufügen (nach den anderen imports) -----

import http from "node:http";
import { verificationCodes } from "./data/verificationStore.js";


// ----- SCHRITT 2: Diesen Block KOMPLETT vor "client.once('ready', ...)" einfügen -----

// === 🌐 Dashboard API Server (kein express nötig!) ===
// Pterodactyl setzt SERVER_PORT automatisch auf deinen Port (5009)
const API_PORT   = process.env.SERVER_PORT || process.env.PORT || 5009;
const API_SECRET = process.env.API_SECRET  || "emden-change-this-key";

const apiServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    res.setHeader("Content-Type", "application/json");

    // OPTIONS Preflight (für Electron fetch)
    if (req.method === "OPTIONS") {
        res.writeHead(200);
        return res.end();
    }

    // API-Key prüfen
    if (req.headers["x-api-key"] !== API_SECRET) {
        res.writeHead(401);
        return res.end(JSON.stringify({ error: "Unauthorized" }));
    }

    const url = new URL(req.url, "http://localhost");

    // ── POST /api/verify ──────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/api/verify") {
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", async () => {
            try {
                const { code } = JSON.parse(body || "{}");
                const upperCode = (code || "").trim().toUpperCase();

                if (!upperCode) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "Kein Code angegeben." }));
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

                verificationCodes.delete(upperCode); // Einmalverwendung!

                // Admin-Check über Discord-Rollen
                let isAdmin = false;
                try {
                    const guild  = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(entry.discordId).catch(() => null);
                    if (member) {
                        isAdmin = member.permissions.has("Administrator") ||
                                  member.roles.cache.some(r => r.name.toLowerCase().includes("admin"));
                    }
                } catch (_) {}

                console.log(`[API] ✅ Verify: ${entry.username} — ${isAdmin ? "ADMIN" : "USER"}`);

                res.writeHead(200);
                return res.end(JSON.stringify({
                    success: true,
                    user: {
                        id:        entry.discordId,
                        username:  entry.username,
                        tag:       entry.tag,
                        avatar:    entry.avatar,
                        role:      isAdmin ? "admin" : "user",
                        discordId: entry.discordId,
                    },
                }));
            } catch (e) {
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // ── GET /api/status ───────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/api/status") {
        try {
            const guild   = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            const members = guild?.memberCount || 0;
            const online  = guild?.members.cache.filter(m =>
                ["online", "dnd", "idle"].includes(m.presence?.status)
            ).size || 0;

            res.writeHead(200);
            return res.end(JSON.stringify({
                online:        true,
                guildName:     guild?.name || "Emden Network",
                members,
                onlineMembers: online,
                botTag:        client.user?.tag || "—",
                uptimeSec:     Math.floor(process.uptime()),
            }));
        } catch (e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ online: false, error: e.message }));
        }
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
});

apiServer.listen(API_PORT, "0.0.0.0", () => {
    console.log(`🌐 Dashboard-API läuft auf Port ${API_PORT}`);
});
