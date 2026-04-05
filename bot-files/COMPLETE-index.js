// index.js — Emden Network Bot (finale, einfache Version)
import {
    Client, GatewayIntentBits, REST, Routes,
    Partials, ActivityType, SlashCommandBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, EmbedBuilder
} from "discord.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import crypto from "node:crypto";

// In-Memory Code Store (alles in einer Datei — kein extra File nötig)
const verificationCodes = new Map();

dotenv.config();

const GUILD_ID = "1365082225296674970";
const API_PORT = process.env.SERVER_PORT || process.env.PORT || 5009;
const API_SECRET = process.env.API_SECRET || "emden-super-secret-key-2026";
const STATUS_UPDATE_INTERVAL = 60 * 1000;

// === Roblox OAuth2 Config ===
const ROBLOX_CLIENT_ID = process.env.ROBLOX_CLIENT_ID || '';
const ROBLOX_CLIENT_SECRET = process.env.ROBLOX_CLIENT_SECRET || '';
const ROBLOX_REDIRECT_URI = process.env.ROBLOX_REDIRECT_URI || 'http://localhost:7329/roblox-callback';
const robloxStates = new Map();

// === Overlay & Roblox Link Tracking ===
const ON_DUTY_ROLE_ID = "1367160344992284803";
const LINKS_FILE = path.join(path.resolve(), "data", "robloxLinks.json");
const robloxLinks = new Map();

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

const robloxPresenceState = new Map();
const overlayClients = new Map();

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

// === /verify Command (inline) ===
const verifyCommand = new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Erhalte deinen Verifikationscode für das Emden Network Dashboard");

// ================================================================
// 🔄 COMMAND LOADER — Lädt alle Commands aus commands/
// ================================================================
const commandsForDiscord = [verifyCommand.toJSON()];
const commandHandlers = new Map();

const commandsPath = path.join(path.resolve(), "commands");
if (fs.existsSync(commandsPath)) {
    const entries = fs.readdirSync(commandsPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".js")) {
            try {
                const mod = await import(`./commands/${entry.name}`);
                const cmd = mod.default;
                if (cmd?.data) {
                    if (commandsForDiscord.some(c => c.name === cmd.data.name)) {
                        console.log(`⏭️ Übersprungen (Duplikat): /${cmd.data.name}`);
                    } else {
                        commandsForDiscord.push(cmd.data.toJSON());
                        commandHandlers.set(cmd.data.name, cmd);
                        console.log(`📦 Command geladen: /${cmd.data.name} (commands/${entry.name})`);
                    }
                }
            } catch (e) {
                console.error(`❌ Fehler beim Laden von commands/${entry.name}:`, e.message);
            }
        }
    }

    for (const entry of entries) {
        if (entry.isDirectory()) {
            const subFiles = fs.readdirSync(path.join(commandsPath, entry.name)).filter(f => f.endsWith(".js"));
            for (const file of subFiles) {
                try {
                    const mod = await import(`./commands/${entry.name}/${file}`);
                    const cmd = mod.default;
                    if (cmd?.data) {
                        if (commandsForDiscord.some(c => c.name === cmd.data.name)) {
                            console.log(`⏭️ Übersprungen (Duplikat): /${cmd.data.name}`);
                        } else {
                            commandsForDiscord.push(cmd.data.toJSON());
                            commandHandlers.set(cmd.data.name, cmd);
                            console.log(`📦 Command geladen: /${cmd.data.name} (commands/${entry.name}/${file})`);
                        }
                    }
                } catch (e) {
                    console.error(`❌ Fehler beim Laden von commands/${entry.name}/${file}:`, e.message);
                }
            }
        }
    }
}

console.log(`📋 ${commandHandlers.size} Commands aus Ordner geladen, ${commandsForDiscord.length} total registriert.`);

// ================================================================
// ⚡ INTERACTION HANDLER (Buttons, Modals, Slash Commands)
// ================================================================
client.on("interactionCreate", async interaction => {

    // ============================================
    // 🔘 BUTTON: Termin vorschlagen → Modal öffnen
    // ============================================
    if (interaction.isButton() && interaction.customId.startsWith("phase2_termin_")) {
        const parts = interaction.customId.split("_");
        // Format: phase2_termin_{bewerberId}_{prueferId}
        const bewerberId = parts[2];
        const prueferId = parts[3];

        // Nur der Bewerber darf den Button drücken
        if (interaction.user.id !== bewerberId) {
            return interaction.reply({
                content: "❌ Nur der Bewerber kann einen Termin vorschlagen!",
                ephemeral: true
            });
        }

        const modal = new ModalBuilder()
            .setCustomId(`phase2_modal_${bewerberId}_${prueferId}`)
            .setTitle("📅 Termin vorschlagen");

        const datumInput = new TextInputBuilder()
            .setCustomId("datum")
            .setLabel("Datum (z.B. 15.04.2026)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("TT.MM.JJJJ")
            .setRequired(true);

        const uhrzeitInput = new TextInputBuilder()
            .setCustomId("uhrzeit")
            .setLabel("Uhrzeit (z.B. 18:00)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("HH:MM")
            .setRequired(true);

        const anmerkungInput = new TextInputBuilder()
            .setCustomId("anmerkung")
            .setLabel("Anmerkungen (optional)")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("z.B. bevorzugte Wochentage, Zeitfenster...")
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(datumInput),
            new ActionRowBuilder().addComponents(uhrzeitInput),
            new ActionRowBuilder().addComponents(anmerkungInput)
        );

        return interaction.showModal(modal);
    }

    // ============================================
    // 📋 MODAL: Termin wird im Channel gepostet
    // ============================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith("phase2_modal_")) {
        const parts = interaction.customId.split("_");
        // Format: phase2_modal_{bewerberId}_{prueferId}
        const bewerberId = parts[2];
        const prueferId = parts[3];

        const datum = interaction.fields.getTextInputValue("datum");
        const uhrzeit = interaction.fields.getTextInputValue("uhrzeit");
        const anmerkung = interaction.fields.getTextInputValue("anmerkung") || "Keine";

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("📅 Terminvorschlag — Phase 2 Gespräch")
            .setDescription(
                `**Bewerber:** <@${bewerberId}>\n` +
                `**Prüfer:** <@${prueferId}>\n\n` +
                `📆 **Datum:** ${datum}\n` +
                `🕐 **Uhrzeit:** ${uhrzeit} Uhr\n` +
                `📝 **Anmerkung:** ${anmerkung}\n\n` +
                `_Bitte bestätigt den Termin oder schlagt eine Alternative vor._`
            )
            .setFooter({ text: "Emden Network • Bewerbungssystem" })
            .setTimestamp();

        // Direkt im Channel posten, sodass alle es sehen
        await interaction.reply({
            content: `📅 <@${bewerberId}> hat einen Termin vorgeschlagen! <@${prueferId}>`,
            embeds: [embed]
        });
        return;
    }

    // ============================================
    // ⚡ SLASH COMMANDS
    // ============================================
    if (!interaction.isChatInputCommand()) return;

    // /verify — inline behandeln
    if (interaction.commandName === "verify") {
        try {
            await interaction.deferReply({ ephemeral: true });

            for (const [k, v] of verificationCodes.entries()) {
                if (v.discordId === interaction.user.id) verificationCodes.delete(k);
            }

            const code      = `EN-${crypto.randomInt(100000, 999999)}`;
            const expiresAt = Date.now() + 10 * 60 * 1000;

            verificationCodes.set(code, {
                discordId: interaction.user.id,
                username:  interaction.user.displayName || interaction.user.username,
                tag:       interaction.user.tag,
                avatar:    interaction.user.displayAvatarURL({ size: 128, extension: 'png' }) || interaction.user.defaultAvatarURL,
                expiresAt,
            });

            console.log(`[VERIFY] Code ${code} → ${interaction.user.tag} | Store: ${verificationCodes.size} Codes`);

            await interaction.editReply({
                content: [
                    "## 🔐 Emden Network Dashboard",
                    "",
                    "Dein persönlicher Verifikationscode:",
                    `\`\`\`${code}\`\`\``,
                    "⏱️ Gültig für **10 Minuten**",
                    "⚠️ Teile diesen Code mit **niemandem**!",
                ].join("\n"),
            });
        } catch (e) {
            console.error("[VERIFY] Fehler:", e);
            const reply = { content: "❌ Fehler beim Erstellen des Codes.", ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply).catch(() => {});
            } else {
                await interaction.reply(reply).catch(() => {});
            }
        }
        return;
    }

    // Alle anderen Commands aus commands/-Ordner
    const handler = commandHandlers.get(interaction.commandName);
    if (handler) {
        try {
            await handler.execute(interaction);
        } catch (e) {
            console.error(`[CMD] Fehler bei /${interaction.commandName}:`, e);
            const reply = { content: "❌ Fehler beim Ausführen des Commands.", ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(reply).catch(() => {});
            } else {
                await interaction.reply(reply).catch(() => {});
            }
        }
        return;
    }
});

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
const dashboardUsers = new Map();

// Persistente User-Registry (ALLE jemals gesehenen User)
const ALL_USERS_FILE = path.join(path.resolve(), "data", "allUsers.json");
const allKnownUsers = new Map();
if (fs.existsSync(ALL_USERS_FILE)) {
    try {
        const data = JSON.parse(fs.readFileSync(ALL_USERS_FILE, "utf-8"));
        for (const [id, u] of Object.entries(data)) allKnownUsers.set(id, u);
        console.log(`✅ ${allKnownUsers.size} bekannte User geladen.`);
    } catch(e) {}
}
function saveAllUsers() {
    try {
        if (!fs.existsSync(path.dirname(ALL_USERS_FILE))) fs.mkdirSync(path.dirname(ALL_USERS_FILE), { recursive: true });
        fs.writeFileSync(ALL_USERS_FILE, JSON.stringify(Object.fromEntries(allKnownUsers), null, 2));
    } catch(e) {}
}
function registerUser(discordId, username, avatar, role) {
    if (!discordId) return;
    allKnownUsers.set(discordId, { discordId, username, avatar, role, lastSeen: Date.now() });
    saveAllUsers();
}

const apiServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(200); return res.end(); }

    const url = new URL(req.url, "http://localhost");

    const publicPaths = ["/api/roblox/auth", "/api/roblox/callback", "/api/roblox/start-verify", "/api/roblox/confirm-verify", "/api/team"];
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
                registerUser(entry.discordId, entry.username, entry.avatar, isAdmin ? 'admin' : 'user');

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

    // POST /api/heartbeat
    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", () => {
            try {
                const { discordId, username, avatar, role } = JSON.parse(body || "{}");
                if (discordId) {
                    dashboardUsers.set(discordId, { username, avatar, role, lastSeen: Date.now() });
                    registerUser(discordId, username, avatar, role);
                }
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

    // POST /api/link-roblox
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

            const cutoff = Date.now() - 90000;
            for (const [id, u] of dashboardUsers.entries()) {
                if (u.lastSeen < cutoff) dashboardUsers.delete(id);
            }

            // Online Discord-Usernamen sammeln
            const onlineDiscordUsers = guild?.members.cache
                .filter(m => ["online", "dnd", "idle"].includes(m.presence?.status) && !m.user.bot)
                .map(m => m.displayName || m.user.username)
                .slice(0, 50) || [];

            res.writeHead(200);
            return res.end(JSON.stringify({
                online: true, guildName: guild?.name || "Emden Network",
                members, onlineMembers: online,
                dashboardOnline: dashboardUsers.size,
                dashboardUsers: [...allKnownUsers.values()].map(u => ({
                    discordId: u.discordId, username: u.username, avatar: u.avatar, role: u.role,
                    online: dashboardUsers.has(u.discordId),
                })),
                onlineDiscordUsers,
                botTag: client.user?.tag || "—",
                uptimeSec: Math.floor(process.uptime()),
            }));
        } catch (e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ online: false, error: e.message }));
        }
    }

    // GET /api/team — Gibt alle Rollen + Members mit Status zurück
    if (req.method === "GET" && url.pathname === "/api/team") {
        try {
            const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            await guild.members.fetch();

            // Wichtige Rollen (Reihenfolge = Hierarchie)
            const teamRoles = guild.roles.cache
                .filter(r => r.members.size > 0 && !r.name.startsWith('@') && r.position > 1)
                .sort((a, b) => b.position - a.position)
                .slice(0, 15)
                .map(role => ({
                    name: role.name,
                    color: role.hexColor !== '#000000' ? role.hexColor : '#5B9AFF',
                    members: role.members.map(m => ({
                        username: m.displayName || m.user.username,
                        avatar: m.user.displayAvatarURL({ size: 64 }),
                        status: m.presence?.status || 'offline',
                        id: m.user.id,
                    }))
                }));

            res.writeHead(200);
            return res.end(JSON.stringify({ success: true, roles: teamRoles }));
        } catch (e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ success: false, error: e.message }));
        }
    }

    // GET /api/roblox/auth?discordId=xxx
    if (req.method === "GET" && url.pathname === "/api/roblox/auth") {
        const discordId = url.searchParams.get("discordId");
        if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId required" })); }
        if (!ROBLOX_CLIENT_ID) { res.writeHead(503); return res.end(JSON.stringify({ error: "Roblox OAuth nicht konfiguriert" })); }

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

    // GET /api/roblox/callback?code=xxx&state=xxx
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

            const userInfoRes = await fetch("https://apis.roblox.com/oauth/v1/userinfo", {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            const userInfo = await userInfoRes.json();
            const userId = userInfo.sub;

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

    // POST /api/roblox/start-verify
    if (req.method === "POST" && url.pathname === "/api/roblox/start-verify") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { discordId, robloxUsername } = JSON.parse(body || "{}");
                if (!discordId || !robloxUsername) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId und robloxUsername erforderlich" })); }

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

    // POST /api/roblox/confirm-verify
    if (req.method === "POST" && url.pathname === "/api/roblox/confirm-verify") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                const entry = robloxStates.get(`verify_${discordId}`);
                if (!entry) { res.writeHead(400); return res.end(JSON.stringify({ error: "Kein Verifikations-Code gefunden. Bitte neu starten." })); }
                if (Date.now() > entry.expires) { robloxStates.delete(`verify_${discordId}`); res.writeHead(410); return res.end(JSON.stringify({ error: "Code abgelaufen. Bitte neu starten." })); }

                const profileRes = await fetch(`https://users.roblox.com/v1/users/${entry.userId}`);
                const profileData = await profileRes.json();
                if (!profileData.description?.includes(entry.code)) {
                    res.writeHead(409);
                    return res.end(JSON.stringify({ error: `Code nicht in Bio gefunden. Füge "${entry.code}" zu deiner Roblox-Bio hinzu.` }));
                }

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

    // POST /api/mod-action — Moderation via Bot (Components v2 Container)
    if (req.method === "POST" && url.pathname === "/api/mod-action") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { userId, username, displayName, avatar, created, reason, action, moderator, moderatorAvatar } = JSON.parse(body || "{}");
                if (!userId || !action) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "userId und action erforderlich" }));
                }

                const MOD_CHANNEL_ID = "1367243128284905573";
                const emoji = action === 'Ban' ? '🔨' : action === 'Kick' ? '👢' : '⚠️';
                const accentColor = action === 'Ban' ? 0xFF4444 : action === 'Kick' ? 0xF59E0B : 0x0088FF;
                const now = new Date();
                const timeStr = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
                const dateStr = now.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

                // Components v2 Message (Container-based)
                const components = [
                    {
                        type: 17, // Container
                        components: [
                            // Header: Avatar + Action
                            {
                                type: 10, // Section
                                components: [
                                    {
                                        type: 10, // TextDisplay in section
                                        content: `${emoji} **${action}**\n### ${displayName || username}`
                                    }
                                ],
                                accessory: avatar ? {
                                    type: 11, // Thumbnail
                                    media: { url: avatar }
                                } : undefined
                            },
                            // Separator
                            { type: 14, spacing: 1 },
                            // Info Fields
                            {
                                type: 10,
                                content: `**User ID**\n\`${userId}\``
                            },
                            {
                                type: 10,
                                content: `**Display Name** · ${displayName || '—'}\n**Username** · @${username}\n**Account Created** · ${created || 'Unbekannt'}`
                            },
                            // Separator
                            { type: 14, spacing: 1 },
                            // Reason
                            {
                                type: 10,
                                content: `**Reason**\n${reason || 'Kein Grund angegeben'}`
                            },
                            {
                                type: 10,
                                content: `**Punishment**\n${emoji} ${action}`
                            },
                            // Separator
                            { type: 14, spacing: 2 },
                            // Footer
                            {
                                type: 10,
                                content: `-# ${moderatorAvatar ? '' : '👮 '}Moderator: @${moderator || 'Unbekannt'} • ${dateStr} um ${timeStr} Uhr`
                            }
                        ]
                    }
                ];

                // Discord API direkt aufrufen (Components v2 braucht flags: 32768)
                const apiRes = await fetch(`https://discord.com/api/v10/channels/${MOD_CHANNEL_ID}/messages`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bot ${process.env.TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        components,
                        flags: 32768 // IS_COMPONENTS_V2
                    })
                });

                if (!apiRes.ok) {
                    const errData = await apiRes.json().catch(() => ({}));
                    console.error('[Mod] Discord API Error:', JSON.stringify(errData));
                    // Fallback: Klassisches Embed wenn Components v2 nicht geht
                    const channel = await client.channels.fetch(MOD_CHANNEL_ID).catch(() => null);
                    if (channel) {
                        const embed = new EmbedBuilder()
                            .setColor(accentColor)
                            .setAuthor({ name: `${emoji} ${action}`, iconURL: avatar || undefined })
                            .setTitle(`${displayName || username}`)
                            .setThumbnail(avatar || null)
                            .addFields(
                                { name: 'User ID', value: `\`${userId}\``, inline: true },
                                { name: 'Display Name', value: displayName || '—', inline: true },
                                { name: 'Account Created', value: created || 'Unbekannt', inline: true },
                                { name: 'Username', value: `@${username}`, inline: true },
                                { name: 'Punishment', value: `${emoji} ${action}`, inline: true },
                                { name: '\u200b', value: '\u200b', inline: true },
                                { name: 'Reason', value: reason || 'Kein Grund angegeben' },
                            )
                            .setFooter({ text: `Moderator: @${moderator || 'Unbekannt'}`, iconURL: moderatorAvatar || undefined })
                            .setTimestamp();
                        await channel.send({ embeds: [embed] });
                    }
                }

                console.log(`[Mod] ${moderator} → ${action} ${username} (${userId}): ${reason}`);
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true }));
            } catch (e) {
                console.error("[Mod] Fehler:", e.message);
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
});

// === WebSockets für Live-Chat ===
const io = new SocketIOServer(apiServer, {
    cors: { origin: "*" }
});

const chatHistory = [];

// ================================================================
// 🎙️ GLOBALE Voice-User Tracking Map
// ================================================================
const activeVoiceUsers = new Map();

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
    const cutoff = Date.now() - 35000;
    for (const [id, u] of dashboardUsers.entries()) {
        if (u.lastSeen < cutoff) dashboardUsers.delete(id);
    }

    const onlineIds = new Set(dashboardUsers.keys());

    // ALLE bekannten User senden (mit online/offline Status)
    const users = [...allKnownUsers.values()].map(u => ({
        discordId: u.discordId, username: u.username, avatar: u.avatar, role: u.role,
        online: onlineIds.has(u.discordId),
    }));

    io.emit("online_users", users);
}

io.on("connection", (socket) => {
    socket.emit("chat_history", chatHistory);

    socket.on("overlay_client_connect", ({ discordId, robloxId, isAdmin }) => {
        if (discordId) overlayClients.set(socket.id, { discordId, isAdmin });

        if (discordId && robloxId) {
            robloxLinks.set(discordId, robloxId);
        }

        socket.emit("overlay_supporter_count", { count: Math.max(0, lastSupporterCount) });
        if (discordId && robloxPresenceState.get(discordId)) {
            socket.emit(`overlay_game_start_${discordId}`, { startTime: Date.now() });
        }
    });

    socket.on("disconnect", () => {
        overlayClients.delete(socket.id);
    });

    socket.on("client_online", (user) => {
        if (user && user.discordId) {
            dashboardUsers.set(user.discordId, {
                username: user.username,
                avatar: user.avatar,
                role: user.role,
                lastSeen: Date.now()
            });
            registerUser(user.discordId, user.username, user.avatar, user.role);
            broadcastOnlineUsers();
        }
    });

    // Chat: User registriert sich mit discordId für PNs
    socket.on("chat_register", ({ discordId, username }) => {
        socket.chatUserId = discordId;
        socket.chatUsername = username;
        console.log(`[Chat] ${username} registriert (${discordId})`);
    });

    socket.on("send_message", (msgData) => {
        const to = msgData.to || 'general';
        const otherCount = io.sockets.sockets.size - 1;
        console.log(`[Chat] ${msgData.username} → ${to}: "${msgData.text || msgData.message}" (${otherCount} andere online)`);

        if (to === 'general') {
            // Broadcast an alle ANDEREN
            chatHistory.push(msgData);
            if (chatHistory.length > 50) chatHistory.shift();
            socket.broadcast.emit("receive_message", msgData);
            // Delivery-Status: zugestellt wenn andere online sind
            socket.emit("msg_status", { id: msgData.id, status: otherCount > 0 ? 'delivered' : 'sent' });
        } else if (to.startsWith('@')) {
            // PN: NUR an den Empfänger senden
            const targetUsername = to.substring(1);
            let sent = false;
            for (const [, s] of io.sockets.sockets) {
                if (s.chatUsername === targetUsername && s.id !== socket.id) {
                    s.emit("receive_message", msgData);
                    sent = true;
                    break;
                }
            }
            socket.emit("msg_status", { id: msgData.id, status: sent ? 'delivered' : 'sent' });
        }
    });

    // Legacy chat_message ignoriert — nur send_message nutzen

    // Typing Indicator
    socket.on("typing_start", ({ to, username }) => {
        if (to === 'general') {
            socket.broadcast.emit("typing_indicator", { username, typing: true });
        } else if (to.startsWith('@')) {
            const target = to.substring(1);
            for (const [sid, s] of io.sockets.sockets) {
                if (s.chatUsername === target) { s.emit("typing_indicator", { username, typing: true }); break; }
            }
        }
    });
    socket.on("typing_stop", ({ to, username }) => {
        if (to === 'general') {
            socket.broadcast.emit("typing_indicator", { username, typing: false });
        } else if (to.startsWith('@')) {
            const target = to.substring(1);
            for (const [sid, s] of io.sockets.sockets) {
                if (s.chatUsername === target) { s.emit("typing_indicator", { username, typing: false }); break; }
            }
        }
    });

    // Read Receipt
    socket.on("msg_read", ({ msgId, reader }) => {
        // Finde den Sender und schicke ihm den Read-Status
        for (const [sid, s] of io.sockets.sockets) {
            if (sid !== socket.id) {
                s.emit("msg_status", { id: msgId, status: 'read', reader });
            }
        }
    });

    // Message Delete
    socket.on("msg_delete", ({ msgId }) => {
        socket.broadcast.emit("msg_deleted", { msgId });
    });

    // 🎙️ WALKIE-TALKIE VOICE SYSTEM
    socket.on("voice_channel_join", ({ channelId, username, discordId }) => {
        if (!channelId || !username) return;

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

        activeVoiceUsers.set(socket.id, { channelId, username, discordId: discordId || '' });
        console.log(`[Voice] ✅ ${username} ist #${channelId} beigetreten (${activeVoiceUsers.size} aktive User)`);

        broadcastVoiceState();
    });

    socket.on("voice_channel_leave", ({ channelId, username, discordId }) => {
        if (!channelId) return;

        const room = `voice:${channelId}`;
        socket.leave(room);

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

    socket.on("voice_create_channel", (newVC) => {
        socket.broadcast.emit("voice_created", newVC);
    });

    socket.on("voice_ptt_start", (data) => {
        const room = `voice:${data.channelId}`;
        socket.to(room).emit("voice_ptt_start", data);
        console.log(`[Voice] 🔴 ${data.username} sendet in #${data.channelId}`);
    });

    socket.on("voice_ptt_stop", (data) => {
        const room = `voice:${data.channelId}`;
        socket.to(room).emit("voice_ptt_stop", data);
        console.log(`[Voice] ⏹ ${data.username} stoppt in #${data.channelId}`);
    });

    socket.on("voice_audio_chunk", (data) => {
        const room = `voice:${data.channelId}`;
        socket.to(room).emit("voice_audio_chunk", data);
    });

    socket.on("disconnect", () => {
        overlayClients.delete(socket.id);

        if (activeVoiceUsers.has(socket.id)) {
            const user = activeVoiceUsers.get(socket.id);
            const room = `voice:${user.channelId}`;

            io.to(room).emit("voice_ptt_stop", {
                channelId: user.channelId,
                username:  user.username,
                discordId: user.discordId || '',
            });

            activeVoiceUsers.delete(socket.id);
            console.log(`[Voice] 🔌 ${user.username} disconnected — aus #${user.channelId} entfernt`);

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
// 🚀 GITHUB RELEASE MONITOR
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

        if (!lastKnownTag) {
            lastKnownTag = release.tag_name;
            console.log(`[Update] Aktueller Tag: ${lastKnownTag}`);
            return;
        }

        if (release.tag_name === lastKnownTag) return;

        lastKnownTag = release.tag_name;
        const version = release.tag_name.replace('v', '');
        const notes = (release.body || 'Keine Änderungen angegeben.')
            .split('\n').slice(0, 8).join('\n').trim();
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
                color:       0x0088FF,
                fields: [
                    { name: '📦  Version',   value: `\`${version}\``,  inline: true  },
                    { name: '✅  Status',    value: '`Stabil`',         inline: true  },
                    { name: '📅  Datum',     value: `\`${dateStr}\``,   inline: true  },
                    { name: '📝  Änderungen', value: notes.length > 0 ? `\`\`\`\n${notes}\n\`\`\`` : '_Keine Beschreibung_', inline: false }
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

    await checkGithubRelease();
    setInterval(checkGithubRelease, 5 * 60 * 1000);
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
    }, 15000);
}

client.login(process.env.TOKEN).catch(e => console.error("❌ Login:", e));	