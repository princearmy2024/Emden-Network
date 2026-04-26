// index.js — Emden Network Bot (finale, einfache Version)
import {
    Client, GatewayIntentBits, REST, Routes,
    Partials, ActivityType, SlashCommandBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, EmbedBuilder, MessageFlags,
    ContainerBuilder, TextDisplayBuilder, SectionBuilder,
    SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
    StringSelectMenuBuilder, AttachmentBuilder
} from "discord.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import crypto from "node:crypto";
import os from "node:os";
import { execSync } from "node:child_process";

// In-Memory Code Store (alles in einer Datei — kein extra File nötig)
const verificationCodes = new Map();

dotenv.config();

const GUILD_ID = "1365082225296674970";
const API_PORT = process.env.SERVER_PORT || process.env.PORT || 5009;
const API_SECRET = process.env.API_SECRET || "emden-super-secret-key-2026";
const STATUS_UPDATE_INTERVAL = 60 * 1000;

// Owner-Whitelist fuer geschuetzte Commands (z.B. /leaderboard-init)
const OWNER_IDS = ["832520997311479809", "1051180937855119441", "415890114389082124"];
const LEADERBOARD_DEFAULT_CHANNEL_ID = "1495104816962080941";
const LEADERBOARD_UPDATE_INTERVAL_MS = 3 * 1000; // 3s = liveartig und rate-limit-sicher (Discord erlaubt ~5 Edits / 5s pro Message)
const LEADERBOARD_PAGE_SIZE = 10;
const PANEL_CONFIG_FILE = path.join(path.resolve(), "data", "panelConfig.json");

// Support-Case-System (Voice-Warteraum → Discord-Panel → Take-Over Button)
const SUPPORT_VOICE_CHANNEL_ID = "1365102454550695936"; // Warteraum — Join triggert Case
const SUPPORT_LOGS_CHANNEL_ID = "1383433388173820027";  // Voice-Logs Channel (Case-Panels werden hier gepostet)
const SUPPORT_PING_ROLE_ID = "1367924090513526874";     // Voice-Support-Rolle — wird bei neuem Case gepingt
const SUPPORT_CASES_FILE = path.join(path.resolve(), "data", "supportCases.json");
const SUPPORT_REENTRY_COOLDOWN_MS = 2 * 60 * 1000; // Nach Case-Close 2min Block vom Warteraum
// Support-Staff-Voice-Channels — Take-Over nur erlaubt wenn Staff in einem dieser Channels ist
const SUPPORT_STAFF_VOICE_IDS = [
    "1391570729677623449", // Support 1
    "1391570762514829384", // Support 2
    "1391570782261477397", // Support 3
    "1391570801815453837", // Support 4
    "1391570830215086170", // Support 5
];

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

// === Mod History ===
const MOD_HISTORY_FILE = path.join(path.resolve(), "data", "modHistory.json");
let modHistory = {};
if (fs.existsSync(MOD_HISTORY_FILE)) {
    try { modHistory = JSON.parse(fs.readFileSync(MOD_HISTORY_FILE, "utf-8")); } catch(e) {}
}
function saveModHistory() {
    try {
        if (!fs.existsSync(path.dirname(MOD_HISTORY_FILE))) fs.mkdirSync(path.dirname(MOD_HISTORY_FILE), { recursive: true });
        fs.writeFileSync(MOD_HISTORY_FILE, JSON.stringify(modHistory, null, 2));
    } catch(e) {}
}
function addModEntry(robloxUserId, entry) {
    if (!modHistory[robloxUserId]) modHistory[robloxUserId] = [];
    modHistory[robloxUserId].push(entry);
    saveModHistory();
    return modHistory[robloxUserId].length;
}
function getModHistory(robloxUserId) {
    return modHistory[robloxUserId] || [];
}

// === Shift System ===
const SHIFT_FILE = path.join(path.resolve(), "data", "shifts.json");
const SHIFT_LEADERBOARD_FILE = path.join(path.resolve(), "data", "shiftLeaderboard.json");
let shiftData = {};       // { discordId: { state: 'off'|'active'|'break', savedMs: 0, startedAt: null } }
let shiftLeaderboard = {}; // { discordId: { totalMs: 0, username: '', avatar: '' } }  — survives reset-all

if (fs.existsSync(SHIFT_FILE)) {
    try { shiftData = JSON.parse(fs.readFileSync(SHIFT_FILE, "utf-8")); } catch(e) {}
}
if (fs.existsSync(SHIFT_LEADERBOARD_FILE)) {
    try { shiftLeaderboard = JSON.parse(fs.readFileSync(SHIFT_LEADERBOARD_FILE, "utf-8")); } catch(e) {}
}
function saveShifts() {
    try {
        if (!fs.existsSync(path.dirname(SHIFT_FILE))) fs.mkdirSync(path.dirname(SHIFT_FILE), { recursive: true });
        fs.writeFileSync(SHIFT_FILE, JSON.stringify(shiftData, null, 2));
    } catch(e) {}
}
function saveLeaderboard() {
    try {
        if (!fs.existsSync(path.dirname(SHIFT_LEADERBOARD_FILE))) fs.mkdirSync(path.dirname(SHIFT_LEADERBOARD_FILE), { recursive: true });
        fs.writeFileSync(SHIFT_LEADERBOARD_FILE, JSON.stringify(shiftLeaderboard, null, 2));
    } catch(e) {}
}
function getShift(discordId) {
    if (!shiftData[discordId]) shiftData[discordId] = { state: 'off', savedMs: 0, startedAt: null, breakMs: 0, breakStartedAt: null, pauseHistory: [], lastTransitionAt: 0 };
    // Migration fuer alte Datensaetze ohne neue Felder
    const s = shiftData[discordId];
    if (s.breakMs === undefined) s.breakMs = 0;
    if (s.breakStartedAt === undefined) s.breakStartedAt = null;
    if (!Array.isArray(s.pauseHistory)) s.pauseHistory = [];
    if (s.lastTransitionAt === undefined) s.lastTransitionAt = 0;
    return s;
}
function getShiftTotalMs(discordId) {
    const s = getShift(discordId);
    let total = s.savedMs || 0;
    if (s.state === 'active' && s.startedAt) total += Date.now() - s.startedAt;
    return total;
}
function getShiftBreakTotalMs(discordId) {
    const s = getShift(discordId);
    let total = s.breakMs || 0;
    if (s.state === 'break' && s.breakStartedAt) total += Date.now() - s.breakStartedAt;
    return total;
}
// Single Source of Truth: Voller Snapshot fuer Broadcasts + API Responses
function buildShiftSnapshot(discordId) {
    const s = getShift(discordId);
    const known = allKnownUsers.get(discordId);
    return {
        discordId,
        state: s.state || 'off',
        savedMs: s.savedMs || 0,
        breakMs: s.breakMs || 0,
        startedAt: s.startedAt || null,       // absolute Unix-TS, null wenn nicht active
        breakStartedAt: s.breakStartedAt || null,
        totalMs: getShiftTotalMs(discordId),
        totalBreakMs: getShiftBreakTotalMs(discordId),
        pauseCount: (s.pauseHistory || []).length,
        serverNow: Date.now(),
        username: known?.username || s.username || '?',
        avatar: known?.avatar || s.avatar || '',
    };
}
// Mutex: Zustandswechsel dicht hintereinander ablehnen (verhindert Race + Timing-Exploits)
const SHIFT_TRANSITION_COOLDOWN_MS = 400;
function canTransitionShift(discordId) {
    const s = getShift(discordId);
    const now = Date.now();
    if (now - (s.lastTransitionAt || 0) < SHIFT_TRANSITION_COOLDOWN_MS) return false;
    s.lastTransitionAt = now;
    return true;
}

// Sync Shift-State zur ON_DUTY-Rolle:
//   Rolle da + state='off' → auto-start
//   Keine Rolle + state!='off' → auto-end (Leaderboard + Streak aktualisieren)
// Wird aufgerufen beim guildMemberUpdate-Event + beim Bot-Start fuer alle Mitglieder
async function syncShiftFromRole(member) {
    if (!member || member.user?.bot) return;
    const discordId = member.id;
    const hasRole = member.roles.cache.has(ON_DUTY_ROLE_ID);
    const s = getShift(discordId);
    const now = Date.now();

    if (hasRole && s.state === 'off') {
        // Rolle da, aber nicht im Shift → auto-start
        s.state = 'active';
        s.startedAt = now;
        s.breakStartedAt = null;
        saveShifts();
        io.emit('shift_update', buildShiftSnapshot(discordId));
        console.log(`[Shift] Auto-Start fuer ${member.displayName || discordId} (hat ON_DUTY Rolle)`);
        return 'started';
    }

    if (!hasRole && s.state !== 'off') {
        // Keine Rolle mehr → finalisiere laufende Zeit + beende Shift
        if (s.state === 'active' && s.startedAt) {
            s.savedMs = (s.savedMs || 0) + Math.max(0, now - s.startedAt);
        }
        if (s.state === 'break' && s.breakStartedAt) {
            const dur = Math.max(0, now - s.breakStartedAt);
            s.breakMs = (s.breakMs || 0) + dur;
            s.pauseHistory.push({ start: s.breakStartedAt, end: now, durationMs: dur });
            if (s.pauseHistory.length > 200) s.pauseHistory = s.pauseHistory.slice(-200);
        }
        // Leaderboard aktualisieren (permanent)
        const known = allKnownUsers.get(discordId);
        if (!shiftLeaderboard[discordId]) shiftLeaderboard[discordId] = { totalMs: 0, username: '', avatar: '' };
        shiftLeaderboard[discordId].totalMs += s.savedMs || 0;
        if (known) {
            shiftLeaderboard[discordId].username = known.username || shiftLeaderboard[discordId].username || '?';
            shiftLeaderboard[discordId].avatar = known.avatar || shiftLeaderboard[discordId].avatar || '';
        }
        saveLeaderboard();
        // Streak-Zeit gutschreiben
        const streakUp = addStreakTime(discordId, s.savedMs || 0);
        if (streakUp) {
            const st = getStreak(discordId);
            io.emit('streak_complete', { discordId, streak: st.streak, bestStreak: st.bestStreak, username: known?.username || '?' });
        }
        s.state = 'off';
        s.startedAt = null;
        s.breakStartedAt = null;
        saveShifts();
        io.emit('shift_update', buildShiftSnapshot(discordId));
        console.log(`[Shift] Auto-End fuer ${member.displayName || discordId} (ON_DUTY Rolle verloren)`);
        return 'ended';
    }
    return null;
}

// === Panel-Config (persistent Message-IDs fuer Live-Panels) ===
let panelConfig = {};
if (fs.existsSync(PANEL_CONFIG_FILE)) {
    try { panelConfig = JSON.parse(fs.readFileSync(PANEL_CONFIG_FILE, "utf-8")); } catch(e) {}
}
function savePanelConfig() {
    try {
        if (!fs.existsSync(path.dirname(PANEL_CONFIG_FILE))) fs.mkdirSync(path.dirname(PANEL_CONFIG_FILE), { recursive: true });
        fs.writeFileSync(PANEL_CONFIG_FILE, JSON.stringify(panelConfig, null, 2));
    } catch(e) {}
}

// === Ticket-Claim System (in-game Live-Chat fuer Discord-Tickets) ===
const TICKETS_FILE = path.join(path.resolve(), "data", "ticketClaims.json");
let ticketClaims = {}; // channelId → { channelId, channelName, claimerDiscordId, claimerName, claimedAt }
if (fs.existsSync(TICKETS_FILE)) {
    try { ticketClaims = JSON.parse(fs.readFileSync(TICKETS_FILE, "utf-8")); } catch(e) {}
}
function saveTicketClaims() {
    try {
        if (!fs.existsSync(path.dirname(TICKETS_FILE))) fs.mkdirSync(path.dirname(TICKETS_FILE), { recursive: true });
        fs.writeFileSync(TICKETS_FILE, JSON.stringify(ticketClaims, null, 2));
    } catch(e) {}
}
const TICKET_WEBHOOK_NAME = 'EmdenNetworkRelay';
async function getOrCreateTicketWebhook(channel) {
    try {
        const hooks = await channel.fetchWebhooks();
        let hook = hooks.find(w => w.name === TICKET_WEBHOOK_NAME);
        if (!hook) {
            hook = await channel.createWebhook({
                name: TICKET_WEBHOOK_NAME,
                reason: 'In-Game Ticket-Relay',
            });
        }
        return hook;
    } catch(e) {
        console.warn('[Ticket] Webhook-Fehler:', e.message);
        return null;
    }
}

// === Support-Case Storage + Helper ===
let supportCases = {}; // caseId → { userId, createdAt, channelId, messageId, status, takenBy, takenByName, takenAt, handlingChannelId, closedAt }
if (fs.existsSync(SUPPORT_CASES_FILE)) {
    try { supportCases = JSON.parse(fs.readFileSync(SUPPORT_CASES_FILE, "utf-8")); } catch(e) {}
}
function saveSupportCases() {
    try {
        if (!fs.existsSync(path.dirname(SUPPORT_CASES_FILE))) fs.mkdirSync(path.dirname(SUPPORT_CASES_FILE), { recursive: true });
        fs.writeFileSync(SUPPORT_CASES_FILE, JSON.stringify(supportCases, null, 2));
    } catch(e) {}
}
function findOpenSupportCase(userId) {
    for (const c of Object.values(supportCases)) {
        if (c.userId === userId && (c.status === 'open' || c.status === 'taken')) return c;
    }
    return null;
}
function generateSupportCaseId() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

async function postSupportCase(member) {
    const uname = member.displayName || member.user.username;
    console.log(`[Support] postSupportCase aufgerufen fuer ${uname} (${member.id}) → Channel ${SUPPORT_LOGS_CHANNEL_ID}, Role-Ping ${SUPPORT_PING_ROLE_ID}`);

    // Verhindere doppelte Cases: wenn User schon einen offenen Case hat, nichts tun
    const existing = findOpenSupportCase(member.id);
    if (existing) {
        console.log(`[Support] SKIP: ${uname} hat schon offenen Case #S-${existing.caseId} (status=${existing.status}). Kein neues Panel.`);
        return;
    }

    // Cache-first, dann fetch mit Fehler-Logging
    const guild = client.guilds.cache.get(GUILD_ID);
    let logsChannel = guild?.channels?.cache?.get(SUPPORT_LOGS_CHANNEL_ID) || null;
    if (logsChannel) console.log(`[Support] Logs-Channel im Cache gefunden: #${logsChannel.name} (${logsChannel.id})`);
    if (!logsChannel) {
        try {
            logsChannel = await client.channels.fetch(SUPPORT_LOGS_CHANNEL_ID);
        } catch(fetchErr) {
            console.warn(`[Support] Logs-Channel ${SUPPORT_LOGS_CHANNEL_ID} nicht erreichbar — Discord-Fehler:`, fetchErr.code || 'unknown', '·', fetchErr.message);
            // Diagnostik: welche Channels sieht der Bot ueberhaupt im Haupt-Guild?
            if (guild) {
                const visibleChannels = guild.channels.cache.filter(c => c.type === 0).size; // GuildText
                console.warn(`[Support] Bot sieht ${visibleChannels} Text-Channels im Guild ${guild.name} (${guild.id}). Channel fehlt oder Bot hat keine View-Permission.`);
            } else {
                console.warn(`[Support] Guild ${GUILD_ID} ist gar nicht im Bot-Cache — schwerwiegendes Problem.`);
            }
            return;
        }
    }
    if (!logsChannel) { console.warn('[Support] Logs-Channel nicht erreichbar:', SUPPORT_LOGS_CHANNEL_ID); return; }

    const caseId = generateSupportCaseId();
    const now = Date.now();
    const username = member.displayName || member.user.username;

    const { ButtonBuilder, ButtonStyle } = await import('discord.js');
    const pingPrefix = SUPPORT_PING_ROLE_ID ? `<@&${SUPPORT_PING_ROLE_ID}>\n` : '';
    const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `${pingPrefix}## 🟢 Ein neuer Support Fall\n<@${member.id}> braucht Hilfe!`
        ))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**CaseID** · \`#S-${caseId}\`\n` +
            `**Erstellt am** · <t:${Math.floor(now/1000)}:F>`
        ))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`sup_take_${caseId}`)
                    .setLabel('Übernehmen')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅'),
            )
        );

    try {
        const msg = await logsChannel.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: SUPPORT_PING_ROLE_ID ? { roles: [SUPPORT_PING_ROLE_ID] } : { parse: [] }
        });
        const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 128 });
        supportCases[caseId] = {
            caseId, userId: member.id, username, avatarUrl,
            createdAt: now, channelId: logsChannel.id, messageId: msg.id,
            status: 'open', takenBy: null, takenByName: null, takenAt: null,
            handlingChannelId: null, closedAt: null,
        };
        saveSupportCases();
        console.log(`[Support] Case #S-${caseId} erstellt fuer ${username}`);
        // Broadcast to connected clients (dashboard, mobile, overlay)
        try { io.emit('support_case_new', supportCaseSnapshot(supportCases[caseId])); } catch(_) {}
    } catch(e) {
        console.error('[Support] Konnte Case-Nachricht nicht senden:', e.message);
    }
}

// Snapshot-Shape fuer Socket/HTTP — was Clients zum Rendern brauchen
function supportCaseSnapshot(sCase) {
    if (!sCase) return null;
    return {
        caseId: sCase.caseId,
        userId: sCase.userId,
        username: sCase.username,
        avatarUrl: sCase.avatarUrl || null,
        createdAt: sCase.createdAt,
        status: sCase.status,
        takenBy: sCase.takenBy,
        takenByName: sCase.takenByName,
        takenAt: sCase.takenAt,
        handlingChannelId: sCase.handlingChannelId,
        closedAt: sCase.closedAt,
    };
}

// Take-Over Logik — wird von Discord-Button UND HTTP-Endpoint genutzt
async function performSupportTake(caseId, staffDiscordId) {
    const sCase = supportCases[caseId];
    if (!sCase) return { ok: false, error: 'Case nicht gefunden.' };
    if (sCase.status === 'taken')   return { ok: false, error: `Case bereits uebernommen von ${sCase.takenByName || sCase.takenBy}.`, taken: true };
    if (sCase.status === 'closed')  return { ok: false, error: 'Case bereits geschlossen.' };

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return { ok: false, error: 'Guild nicht im Cache.' };

    const staff = guild.members.cache.get(staffDiscordId) || await guild.members.fetch(staffDiscordId).catch(() => null);
    if (!staff) return { ok: false, error: 'Staff-User nicht gefunden.' };

    const EN_TEAM = '1365083291044282389';
    if (!staff.roles.cache.has(EN_TEAM)) {
        return { ok: false, error: 'Nur EN-Team kann Cases uebernehmen.' };
    }
    const staffVoice = staff.voice.channel;
    if (!staffVoice) {
        return { ok: false, error: 'Du musst in einem Support-Channel (Support 1–5) sein.' };
    }
    // NEU: Nur erlauben wenn Staff in einem der 5 Support-Channels ist
    if (!SUPPORT_STAFF_VOICE_IDS.includes(staffVoice.id)) {
        return { ok: false, error: `Du musst in einem Support-Channel (Support 1–5) sein. Aktuell: ${staffVoice.name}` };
    }
    const userMember = await guild.members.fetch(sCase.userId).catch(() => null);
    if (!userMember) return { ok: false, error: 'User ist nicht mehr im Server.' };
    if (!userMember.voice.channel) return { ok: false, error: 'User ist nicht mehr im Voice-Channel.' };

    await userMember.voice.setChannel(staffVoice, `Support #S-${caseId} von ${staff.displayName || staff.user.username}`);
    sCase.status = 'taken';
    sCase.takenBy = staff.id;
    sCase.takenByName = staff.displayName || staff.user.username;
    sCase.takenAt = Date.now();
    sCase.handlingChannelId = staffVoice.id;
    saveSupportCases();
    await rebuildSupportCaseMessage(caseId);
    try { io.emit('support_case_update', supportCaseSnapshot(sCase)); } catch(_) {}
    return {
        ok: true,
        movedToChannelId: staffVoice.id,
        movedToChannelName: staffVoice.name,
        userName: userMember.displayName || userMember.user.username,
        staffName: sCase.takenByName,
    };
}

async function rebuildSupportCaseMessage(caseId) {
    const sCase = supportCases[caseId];
    if (!sCase) return;
    const channel = await client.channels.fetch(sCase.channelId).catch(() => null);
    if (!channel) return;
    const msg = await channel.messages.fetch(sCase.messageId).catch(() => null);
    if (!msg) return;

    const { ButtonBuilder, ButtonStyle } = await import('discord.js');
    let headerEmoji = '🟢', statusText = 'OFFEN';
    if (sCase.status === 'taken')  { headerEmoji = '🔵'; statusText = 'UEBERNOMMEN'; }
    if (sCase.status === 'closed') { headerEmoji = '⚫'; statusText = 'GESCHLOSSEN'; }

    const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## ${headerEmoji} Support Fall · ${statusText}\n<@${sCase.userId}> braucht Hilfe!`
        ))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**CaseID** · \`#S-${sCase.caseId}\`\n` +
            `**Erstellt am** · <t:${Math.floor(sCase.createdAt/1000)}:F>` +
            (sCase.takenBy ? `\n**Uebernommen von** · <@${sCase.takenBy}> <t:${Math.floor(sCase.takenAt/1000)}:R>` : '') +
            (sCase.handlingChannelId ? `\n**Gespraechsraum** · <#${sCase.handlingChannelId}>` : '') +
            (sCase.closedAt ? `\n**Beendet** · <t:${Math.floor(sCase.closedAt/1000)}:R>` : '')
        ));

    if (sCase.status === 'open') {
        container
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`sup_take_${sCase.caseId}`)
                        .setLabel('Übernehmen')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('✅')
                )
            );
    }
    await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 }).catch(e => console.warn('[Support] rebuildCaseMessage edit fehlgeschlagen:', e.message));
}

// Startup-Cleanup: alle user-spezifischen Connect-Deny-Overwrites im Warteraum entfernen.
// Grund: setTimeout in closeSupportCase() geht beim Bot-Restart verloren, User bleiben
// sonst fuer immer geblockt. Da der Cooldown nur 2min ist, ist nach einem Restart
// jeder legitime Cooldown laengst abgelaufen → sicher alle zu entfernen.
async function cleanupSupportPermissionOverwrites() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        const supportChan = guild.channels.cache.get(SUPPORT_VOICE_CHANNEL_ID);
        if (!supportChan) return;
        let removed = 0;
        for (const [id, ow] of supportChan.permissionOverwrites.cache) {
            // Type 1 = Member overwrite. @everyone (Type 0) anfassen wir nicht.
            if (ow.type === 1 && ow.deny?.has('Connect')) {
                await supportChan.permissionOverwrites.delete(id, 'Startup-Cleanup: stale Cooldown-Block').catch(() => {});
                removed++;
            }
        }
        if (removed > 0) console.log(`[Support] Startup-Cleanup: ${removed} stale Permission-Overwrites entfernt.`);
    } catch(e) { console.warn('[Support] permission-cleanup:', e.message); }
}

// Stale-Case-Cleanup: alte Cases (>30min + User nicht im Warteraum) schliessen
const SUPPORT_CASE_STALE_MS = 30 * 60 * 1000; // 30 Minuten
async function cleanupStaleCases() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        const warteraum = guild.channels.cache.get(SUPPORT_VOICE_CHANNEL_ID);
        const now = Date.now();
        let closed = 0;
        for (const caseId of Object.keys(supportCases)) {
            const sCase = supportCases[caseId];
            if (sCase.status === 'closed') continue;
            const age = now - (sCase.createdAt || 0);
            const userInWarteraum = warteraum?.members?.has(sCase.userId) || false;
            // Schliessen wenn: alt UND User nicht mehr im Warteraum (Ghost-Case)
            if (age > SUPPORT_CASE_STALE_MS && !userInWarteraum) {
                await closeSupportCase(sCase, { applyBlock: false }).catch(() => {});
                closed++;
            }
        }
        if (closed > 0) console.log(`[Support] Cleanup: ${closed} stale Cases geschlossen.`);
    } catch(e) { console.warn('[Support] cleanupStaleCases:', e.message); }
}

async function closeSupportCase(sCase, { applyBlock = true } = {}) {
    if (!sCase || sCase.status === 'closed') return;
    sCase.status = 'closed';
    sCase.closedAt = Date.now();
    saveSupportCases();
    await rebuildSupportCaseMessage(sCase.caseId);
    try { io.emit('support_case_closed', { caseId: sCase.caseId }); } catch(_) {}

    if (!applyBlock) return;
    // Permission-Overwrite: User darf SUPPORT_VOICE_CHANNEL_ID fuer X Minuten nicht mehr betreten
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        const supportChan = guild?.channels?.cache?.get(SUPPORT_VOICE_CHANNEL_ID);
        if (!supportChan) return;
        await supportChan.permissionOverwrites.edit(sCase.userId, { Connect: false }, { reason: `Support-Case #S-${sCase.caseId} beendet — Cooldown` });
        console.log(`[Support] ${sCase.userId} geblockt in Warteraum fuer ${SUPPORT_REENTRY_COOLDOWN_MS/60000}min`);
        setTimeout(async () => {
            try {
                const ch = guild?.channels?.cache?.get(SUPPORT_VOICE_CHANNEL_ID);
                if (!ch) return;
                await ch.permissionOverwrites.delete(sCase.userId, 'Support-Cooldown abgelaufen').catch(() => {});
                console.log(`[Support] ${sCase.userId} wieder zugelassen (Cooldown abgelaufen)`);
            } catch(_) {}
        }, SUPPORT_REENTRY_COOLDOWN_MS);
    } catch(e) {
        console.warn('[Support] Block-Overwrite fehlgeschlagen:', e.message);
    }
}

// === Daily Streak System ===
const STREAK_FILE = path.join(path.resolve(), "data", "streaks.json");
const STREAK_MIN_MS = 10 * 60 * 1000;     // 10 Minuten On Duty
const STREAK_MIN_ENTRIES = 5;               // 5 Mod-Einträge
const STREAK_PROTECTED_ROLE = "1372674954625024012"; // Diese Rolle verliert den Streak NIE
let streakData = {};
// { discordId: { streak, lastDate, lastCompletedDate, todayMs, todayEntries, bestStreak } }

if (fs.existsSync(STREAK_FILE)) {
    try { streakData = JSON.parse(fs.readFileSync(STREAK_FILE, "utf-8")); } catch(e) {}
}
function saveStreaks() {
    try {
        if (!fs.existsSync(path.dirname(STREAK_FILE))) fs.mkdirSync(path.dirname(STREAK_FILE), { recursive: true });
        fs.writeFileSync(STREAK_FILE, JSON.stringify(streakData, null, 2));
    } catch(e) {}
}

function getToday() { return new Date().toISOString().split('T')[0]; }
function getYesterday() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; }

function getStreak(discordId) {
    if (!streakData[discordId]) {
        streakData[discordId] = { streak: 0, lastDate: null, lastCompletedDate: null, todayMs: 0, todayEntries: 0, bestStreak: 0, protected: false };
    }
    const s = streakData[discordId];
    const today = getToday();

    // Neuer Tag → Reset der Tages-Werte
    if (s.lastDate && s.lastDate !== today) {
        const yesterday = getYesterday();
        if (s.lastCompletedDate !== yesterday && s.lastCompletedDate !== today) {
            // Gestern nicht abgeschlossen → Streak reset (außer protected)
            if (!s.protected) {
                s.streak = 0;
            }
        }
        s.todayMs = 0;
        s.todayEntries = 0;
        s.lastDate = today;
    }
    if (!s.lastDate) s.lastDate = today;

    return s;
}

// Protected-Status für Rolle prüfen (beim Bot-Start + periodisch)
async function updateStreakProtection() {
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return;
        for (const [discordId, s] of Object.entries(streakData)) {
            try {
                const member = await guild.members.fetch(discordId).catch(() => null);
                s.protected = member ? member.roles.cache.has(STREAK_PROTECTED_ROLE) : false;
            } catch(e) { s.protected = false; }
        }
        saveStreaks();
    } catch(e) {}
}

function checkStreakComplete(discordId) {
    const s = getStreak(discordId);
    const today = getToday();
    const alreadyCompleted = s.lastCompletedDate === today;

    if (!alreadyCompleted && s.todayMs >= STREAK_MIN_MS && s.todayEntries >= STREAK_MIN_ENTRIES) {
        s.streak += 1;
        s.lastCompletedDate = today;
        if (s.streak > (s.bestStreak || 0)) s.bestStreak = s.streak;
        saveStreaks();
        console.log(`[Streak] 🔥 ${discordId} Streak ${s.streak}! (${s.todayMs}ms + ${s.todayEntries} Einträge)`);
        return true; // Streak gerade erhöht
    }
    return false;
}

function addStreakTime(discordId, ms) {
    const s = getStreak(discordId);
    s.todayMs += ms;
    s.lastDate = getToday();
    saveStreaks();
    return checkStreakComplete(discordId);
}

function addStreakEntry(discordId) {
    const s = getStreak(discordId);
    s.todayEntries += 1;
    s.lastDate = getToday();
    saveStreaks();
    return checkStreakComplete(discordId);
}

// Lead role IDs that can manage shifts + delete mod entries
const LEAD_ROLE_IDS = [
    "1365085407381028864",  // Projektleitung
    "1365085926551720096",  // Stv. Projektleitung
    "1365086249592815637",  // Manager
    "1365087911308951572",  // Teamleitung
    "1365088012517642343",  // Stv. Teamleitung
];

// === On-Duty Cache (refreshed every 15s in background) ===
let cachedOnDutyStaff = [];
let cachedGSG9Teams = [];

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

const gsg9VerifyCommand = new SlashCommandBuilder()
    .setName("gsg9verify")
    .setDescription("Verknüpfe deinen Roblox-Account mit dem GSG9 Panel")
    .addStringOption(opt => opt.setName("roblox_username").setDescription("Dein Roblox Benutzername").setRequired(true));

const moderateCommand = new SlashCommandBuilder()
    .setName("moderate")
    .setDescription("Erstelle einen Moderations-Eintrag fuer einen User")
    .addStringOption(opt => opt.setName("user").setDescription("Roblox Benutzername oder User-ID").setRequired(true).setAutocomplete(true))
    .addStringOption(opt => opt.setName("punishment").setDescription("Art der Bestrafung").setRequired(true)
        .addChoices(
            { name: 'Warn', value: 'Warn' },
            { name: 'Kick', value: 'Kick' },
            { name: 'Ban', value: 'Ban' },
            { name: '1-Day Ban', value: 'One Day Ban' },
            { name: 'Notiz', value: 'Notiz' },
        ))
    .addStringOption(opt => opt.setName("reason").setDescription("Grund fuer die Bestrafung").setRequired(true));

const moderationsCommand = new SlashCommandBuilder()
    .setName("moderations")
    .setDescription("Zeige alle Moderations-Eintraege eines Users")
    .addStringOption(opt => opt.setName("user").setDescription("Roblox Benutzername oder User-ID").setRequired(true).setAutocomplete(true));

const leaderboardInitCommand = new SlashCommandBuilder()
    .setName("leaderboard-init")
    .setDescription("Erstellt das Live-Shift-Leaderboard-Panel (nur Owner)");

// ================================================================
// 🔄 COMMAND LOADER — Lädt alle Commands aus commands/
// ================================================================
const commandsForDiscord = [verifyCommand.toJSON(), gsg9VerifyCommand.toJSON(), moderateCommand.toJSON(), moderationsCommand.toJSON(), leaderboardInitCommand.toJSON()];
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
    // 📸 BUTTON: Beweis-Bild anzeigen (ephemeral)
    // ============================================
    if (interaction.isButton() && interaction.customId.startsWith("evidence_")) {
        const base64Data = global._evidenceStore?.get(interaction.customId);
        if (!base64Data) {
            return interaction.reply({ content: '❌ Beweis nicht mehr verfügbar (abgelaufen).', ephemeral: true });
        }

        const imgBuffer = Buffer.from(base64Data, 'base64');
        return interaction.reply({
            content: `📸 **Beweis-Bild:**`,
            files: [new AttachmentBuilder(imgBuffer, { name: 'beweis.png' })],
            ephemeral: true
        });
    }

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
    // 📋 SELECT MENU: Mod-History Eintrag anzeigen
    // ============================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith("mod_history_select_")) {
        const robloxUserId = interaction.customId.replace('mod_history_select_', '');
        const selected = interaction.values[0]; // z.B. "modentry_12345_42"
        const entryId = selected.split('_').pop();

        try {
            const history = getModHistory(robloxUserId);
            const entry = history[parseInt(entryId)] || null;

            if (!entry) {
                return interaction.reply({ content: '❌ Eintrag nicht gefunden.', ephemeral: true });
            }

            // Custom Emojis für Aktionen (gleiche Map wie in mod-action)
            const detailEmojis = {
                'Ban':         '<:Ban:1490446877785854163>',
                'One Day Ban': '<:OneDayBan:1490448467498373280>',
                'Kick':        '<:Kick:1490450344663322727>',
                'Warn':        '<:Warn:1490447092584288336>',
                'Notiz':       '<:notizblock:1490444362365272064>',
            };
            const eEmoji = detailEmojis[entry.action] || detailEmojis['Warn'];
            const eDate = new Date(entry.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const entryIdx = history.indexOf(entry) + 1;

            const profileUrl = `https://www.roblox.com/users/${robloxUserId}/profile`;
            const { ButtonBuilder, ButtonStyle } = await import('discord.js');

            const detailContainer = new ContainerBuilder()
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${eEmoji} **${entry.action}** — Eintrag #${entryIdx}\n` +
                        `# ${entry.displayName || 'Unbekannt'}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**User ID** · \`${robloxUserId}\`\n` +
                        `**Display Name** · ${entry.displayName || '—'}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:notizblock:1490444362365272064> **Reason**\n> ${entry.reason || 'Kein Grund'}`)
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`**Punishment** · ${eEmoji} ${entry.action}`)
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addActionRowComponents(
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setLabel('Roblox Profil')
                            .setStyle(ButtonStyle.Link)
                            .setURL(profileUrl)
                            .setEmoji({ name: 'roblox', id: '1433535007246516446' })
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# Moderator: @${entry.moderator || 'Unbekannt'} · ${eDate}`)
                );

            return interaction.reply({
                components: [detailContainer],
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
            });
        } catch(e) {
            console.error('[Mod] Select-Menu Fehler:', e.message);
            return interaction.reply({ content: '❌ Fehler beim Laden des Eintrags.', ephemeral: true });
        }
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
    // 🔍 AUTOCOMPLETE: /moderate user
    // ============================================
    if (interaction.isAutocomplete() && (interaction.commandName === 'moderate' || interaction.commandName === 'moderations')) {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'user') {
            const query = focused.value.trim();
            if (!query || query.length < 2) {
                return interaction.respond([]).catch(() => {});
            }
            try {
                // Prüfe ob es eine User-ID ist (nur Zahlen)
                if (/^\d+$/.test(query)) {
                    const res = await fetch(`https://users.roblox.com/v1/users/${query}`).catch(() => null);
                    if (res?.ok) {
                        const user = await res.json();
                        return interaction.respond([
                            { name: `${user.displayName} (@${user.name}) — ID: ${user.id}`, value: String(user.id) }
                        ]).catch(() => {});
                    }
                }
                // Username-Suche
                const searchRes = await fetch('https://users.roblox.com/v1/usernames/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usernames: [query], excludeBannedUsers: false })
                });
                const searchData = await searchRes.json();
                const results = (searchData.data || []).map(u => ({
                    name: `${u.displayName} (@${u.name}) — ID: ${u.id}`,
                    value: String(u.id)
                })).slice(0, 10);
                return interaction.respond(results).catch(() => {});
            } catch(e) {
                return interaction.respond([]).catch(() => {});
            }
        }
        return;
    }

    // ============================================
    // 🆘 SUPPORT Take-Over Button
    // ============================================
    if (interaction.isButton() && interaction.customId.startsWith('sup_take_')) {
        const caseId = interaction.customId.replace('sup_take_', '');
        try {
            const result = await performSupportTake(caseId, interaction.user.id);
            if (!result.ok) {
                return interaction.reply({ content: (result.taken ? 'ℹ️ ' : '❌ ') + result.error, flags: MessageFlags.Ephemeral });
            }
            return interaction.reply({
                content: `✅ **${result.userName}** wurde zu dir in <#${result.movedToChannelId}> gemoved.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch(e) {
            console.error('[Support] Uebernehmen-Fehler:', e);
            try { await interaction.reply({ content: `❌ Fehler: ${e.message}`, flags: MessageFlags.Ephemeral }); } catch(_) {}
        }
        return;
    }

    // ============================================
    // 🏆 LEADERBOARD Pagination / Refresh Buttons
    // ============================================
    if (interaction.isButton() && (interaction.customId === 'lb_prev' || interaction.customId === 'lb_next' || interaction.customId === 'lb_refresh')) {
        // 1) Interaction SOFORT acknowledgen (3s Discord-Deadline) — heavy work danach
        try { await interaction.deferUpdate(); }
        catch(e) { console.warn('[Leaderboard] deferUpdate scheiterte:', e.message); return; }
        try {
            const cfg = panelConfig.leaderboard || {};
            const curPage = cfg.currentPage || 0;
            const rows = await collectLeaderboardRows();
            const totalPages = Math.max(1, Math.ceil((rows?.length || 0) / LEADERBOARD_PAGE_SIZE));
            let newPage = curPage;
            if (interaction.customId === 'lb_next') newPage = Math.min(curPage + 1, totalPages - 1);
            else if (interaction.customId === 'lb_prev') newPage = Math.max(curPage - 1, 0);
            panelConfig.leaderboard = { ...cfg, currentPage: newPage };
            savePanelConfig();
            const container = await buildLeaderboardContainer(newPage);
            if (!container) return;
            // Nach deferUpdate: Nachricht editieren via editReply
            await interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
        } catch(e) {
            console.error('[Leaderboard] Button-Fehler nach defer:', e.message);
        }
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

    // /gsg9verify — Roblox-Account mit GSG9 Panel verknüpfen
    if (interaction.commandName === "gsg9verify") {
        try {
            const GSG9_GUILD_ID = '1398612779325329418';
            const GSG9_ALLOWED_ROLES = ['1398619556792242206', '1419353950234083480', '1405963717199527998'];

            // Prüfe ob User eine GSG9-Rolle hat
            const guild = client.guilds.cache.get(GSG9_GUILD_ID) || await client.guilds.fetch(GSG9_GUILD_ID);
            const member = await guild.members.fetch(interaction.user.id).catch(() => null);
            if (!member || !GSG9_ALLOWED_ROLES.some(r => member.roles.cache.has(r))) {
                return interaction.reply({ content: '❌ Du brauchst eine GSG9-Rolle um diesen Command zu nutzen.', ephemeral: true });
            }

            const robloxUsername = interaction.options.getString('roblox_username');
            await interaction.deferReply({ ephemeral: true });

            // Roblox-User suchen
            const searchRes = await fetch('https://users.roblox.com/v1/usernames/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: false })
            });
            const searchData = await searchRes.json();
            if (!searchData.data?.length) {
                return interaction.editReply({ content: `❌ Roblox-User "${robloxUsername}" nicht gefunden.` });
            }

            const robloxUser = searchData.data[0];
            robloxLinks.set(interaction.user.id, String(robloxUser.id));
            saveLinks();

            console.log(`[GSG9] ${interaction.user.username} verknüpft mit Roblox ${robloxUser.name} (${robloxUser.id})`);

            await interaction.editReply({
                content: [
                    '## ✅ GSG9 Roblox-Verknüpfung',
                    '',
                    `**Discord:** ${interaction.user.displayName || interaction.user.username}`,
                    `**Roblox:** ${robloxUser.displayName || robloxUser.name} (@${robloxUser.name})`,
                    `**User ID:** \`${robloxUser.id}\``,
                    '',
                    'Dein Roblox-Account ist jetzt im GSG9 Panel verknüpft. 🔗',
                ].join('\n')
            });
        } catch(e) {
            console.error('[GSG9 Verify] Fehler:', e.message);
            const reply = { content: '❌ Fehler: ' + e.message, ephemeral: true };
            if (interaction.deferred) await interaction.editReply(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
        return;
    }

    // /moderate — Mod-Eintrag direkt ueber Discord erstellen (nur EN Team)
    if (interaction.commandName === "moderate") {
        try {
            // Staff-Check: Nur EN Team darf moderieren
            const EN_TEAM_ROLE_ID = "1365083291044282389";
            const modGuild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            const modMember = await modGuild.members.fetch(interaction.user.id).catch(() => null);
            if (!modMember || !modMember.roles.cache.has(EN_TEAM_ROLE_ID)) {
                return interaction.reply({ content: '❌ Nur EN Team-Mitglieder koennen diesen Command nutzen.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const robloxUserId = interaction.options.getString('user');
            const action = interaction.options.getString('punishment');
            const reason = interaction.options.getString('reason');
            const moderatorName = interaction.user.displayName || interaction.user.username;

            // Roblox User-Daten holen
            const rblxRes = await fetch(`https://users.roblox.com/v1/users/${robloxUserId}`);
            if (!rblxRes.ok) {
                return interaction.editReply({ content: '❌ Roblox-User nicht gefunden.' });
            }
            const rblxUser = await rblxRes.json();
            const username = rblxUser.name;
            const displayName = rblxUser.displayName || username;
            const created = new Date(rblxUser.created).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

            // Avatar holen
            let avatar = null;
            try {
                const avRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png`);
                const avData = await avRes.json();
                avatar = avData.data?.[0]?.imageUrl || null;
            } catch(_) {}

            // Emojis
            const actionEmojis = {
                'Ban':         { text: '<:Ban:1490446877785854163>',        id: '1490446877785854163', name: 'Ban' },
                'One Day Ban': { text: '<:OneDayBan:1490448467498373280>',  id: '1490448467498373280', name: 'OneDayBan' },
                'Kick':        { text: '<:Kick:1490450344663322727>',       id: '1490450344663322727', name: 'Kick' },
                'Warn':        { text: '<:Warn:1490447092584288336>',       id: '1490447092584288336', name: 'Warn' },
                'Notiz':       { text: '<:notizblock:1490444362365272064>', id: '1490444362365272064', name: 'notizblock' },
            };
            const getActionEmoji = (a) => actionEmojis[a] || actionEmojis['Warn'];
            const emoji = getActionEmoji(action).text;

            // Moderator Rang
            const rankEmojis = {
                'projektleitung': '<:Projektleitung:1489311699625578666>',
                'stv. projektleitung': '<:StvPrpjektleitung:1489311731950944559>',
                'management': '<:Manager:1489311838016635151>',
                'manager': '<:Manager:1489311838016635151>',
                'teamleitung': '<:Teamleitung:1489312932415410237>',
                'stv. teamleitung': '<:StvTeamleitung:1489312944574435458>',
                'sen. admin': '<:Administration:1489312566030110721>',
                'admin': '<:Administration:1489312566030110721>',
                'administrator': '<:Administration:1489312566030110721>',
                'jun. admin': '<:Administration:1489312566030110721>',
                'sen. mod': '<:Moderation:1489312529254449353>',
                'moderator': '<:Moderation:1489312529254449353>',
                'mod': '<:Moderation:1489312529254449353>',
                'trial mod': '<:Trialmoderation:1489312502088073308>',
                'trial moderator': '<:Trialmoderation:1489312502088073308>',
            };
            let modRankEmoji = '<:Trialmoderation:1489312502088073308>';
            let modRankName = 'Moderator';
            try {
                const guild = client.guilds.cache.get(GUILD_ID);
                if (guild) {
                    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
                    if (member) {
                        const roles = member.roles.cache.sort((a, b) => b.position - a.position);
                        for (const [, role] of roles) {
                            const roleLower = role.name.toLowerCase();
                            for (const [key, emojiVal] of Object.entries(rankEmojis)) {
                                if (roleLower.includes(key)) { modRankEmoji = emojiVal; modRankName = role.name; break; }
                            }
                            if (modRankName !== 'Moderator') break;
                        }
                    }
                }
            } catch(_) {}

            // Mod-Avatar
            const modAvatarUrl = interaction.user.displayAvatarURL({ size: 128, extension: 'png' });

            // History speichern
            const history = getModHistory(robloxUserId);
            const entryNum = addModEntry(robloxUserId, {
                action, reason: reason || 'Kein Grund', moderator: moderatorName, date: new Date().toISOString(),
                displayName, modAvatar: modAvatarUrl
            });
            const prevCount = entryNum - 1;

            // Container bauen (identisch zum API)
            const MOD_CHANNEL_ID = "1367243128284905573";
            const channel = await client.channels.fetch(MOD_CHANNEL_ID).catch(() => null);
            if (!channel) {
                return interaction.editReply({ content: '❌ Mod-Kanal nicht gefunden.' });
            }

            const profileUrl = `https://www.roblox.com/users/${robloxUserId}/profile`;
            const { ButtonBuilder, ButtonStyle } = await import('discord.js');
            const buttonRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Roblox Profil')
                    .setStyle(ButtonStyle.Link)
                    .setURL(profileUrl)
                    .setEmoji({ name: 'roblox', id: '1433535007246516446' })
            );

            // Header — SectionBuilder braucht Accessory, nur bei Avatar. Sonst plain TextDisplay.
            const container = new ContainerBuilder();
            if (avatar) {
                const headerSection = new SectionBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${emoji} **${action}**\n# ${displayName}`))
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar));
                container.addSectionComponents(headerSection);
            } else {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`${emoji} **${action}**\n# ${displayName}`));
            }
            container
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**User ID** · \`${robloxUserId}\`\n` +
                        `**Display Name** · ${displayName}\n` +
                        `**Username** · @${username}\n` +
                        `**Account Created** · ${created}`
                    )
                )
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

            if (action === 'Notiz') {
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:notizblock:1490444362365272064> **Notiz**\n> ${reason || 'Keine Notiz'}`)
                );
            } else {
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`<:notizblock:1490444362365272064> **Reason**\n> ${reason || 'Kein Grund'}`)
                );
                container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`**Punishment** · ${emoji} ${action}`)
                );
            }

            container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addActionRowComponents(buttonRow);

            if (prevCount > 0) {
                const historyLines = history.slice(-3).map((h) => {
                    const hEmoji = getActionEmoji(h.action).text;
                    const hDate = new Date(h.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    return `-# ${hEmoji} ${h.action} · ${h.reason} · ${hDate}`;
                }).join('\n');
                container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`📋 **Eintrag #${entryNum}** — ${prevCount} vorherige Bestrafung${prevCount > 1 ? 'en' : ''}\n${historyLines}`)
                );
            }

            // Select-Menü
            const allEntries = getModHistory(robloxUserId);
            if (allEntries.length > 1) {
                try {
                    const offset = Math.max(0, allEntries.length - 25);
                    const options = allEntries.slice(-25).map((h, i) => {
                        const hE = getActionEmoji(h.action);
                        const hDate = new Date(h.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
                        return {
                            label: `#${offset + i + 1} ${h.action} — ${(h.reason || 'Kein Grund').slice(0, 50)}`.slice(0, 100),
                            description: `von ${h.moderator || 'Unbekannt'} · ${hDate}`.slice(0, 100),
                            value: `modentry_${robloxUserId}_${offset + i}`,
                            emoji: { name: hE.name, id: hE.id }
                        };
                    });
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`mod_history_select_${robloxUserId}`)
                        .setPlaceholder(`📋 Alle ${allEntries.length} Einträge anzeigen...`)
                        .addOptions(options);
                    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
                    container.addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));
                } catch(selectErr) { console.error('[Mod] Select-Menü Fehler:', selectErr.message); }
            }

            container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(`-# ${modRankEmoji} ${modRankName}: @${moderatorName} · <t:${Math.floor(Date.now()/1000)}:R>`)
                );

            await channel.send({
                components: [container],
                flags: MessageFlags.IsComponentsV2
            });

            // Streak: Eintrag zaehlen
            const streakUp = addStreakEntry(interaction.user.id);
            if (streakUp) {
                const st = getStreak(interaction.user.id);
                io.emit('streak_complete', { discordId: interaction.user.id, streak: st.streak, bestStreak: st.bestStreak, username: moderatorName });
            }

            // Live broadcast an alle Dashboard-Clients
            io.emit('mod_new_entry', {
                userId: robloxUserId, username, displayName,
                avatar: avatar || '', action, reason: reason || 'Kein Grund',
                moderator: moderatorName, moderatorAvatar: modAvatarUrl || '',
                date: new Date().toISOString(), entryNum,
            });

            console.log(`[Mod/CMD] ${moderatorName} → ${action} ${username} (${robloxUserId}): ${reason}`);
            await interaction.editReply({ content: `✅ **${action}** fuer **${displayName}** (@${username}) erstellt!\nEintrag #${entryNum} wurde im Mod-Kanal gepostet.` });
        } catch(e) {
            console.error('[Moderate CMD] Fehler:', e);
            const reply = { content: '❌ Fehler: ' + e.message, ephemeral: true };
            if (interaction.deferred) await interaction.editReply(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
        return;
    }

    // /moderations — Alle Eintraege eines Users anzeigen (nur EN Team)
    if (interaction.commandName === "moderations") {
        try {
            const EN_TEAM_ROLE_ID = "1365083291044282389";
            const modGuild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            const modMember = await modGuild.members.fetch(interaction.user.id).catch(() => null);
            if (!modMember || !modMember.roles.cache.has(EN_TEAM_ROLE_ID)) {
                return interaction.reply({ content: '❌ Nur EN Team-Mitglieder koennen diesen Command nutzen.', ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const robloxUserId = interaction.options.getString('user');

            // Roblox User-Daten holen
            const rblxRes = await fetch(`https://users.roblox.com/v1/users/${robloxUserId}`);
            if (!rblxRes.ok) {
                return interaction.editReply({ content: '❌ Roblox-User nicht gefunden.' });
            }
            const rblxUser = await rblxRes.json();
            const username = rblxUser.name;
            const displayName = rblxUser.displayName || username;
            const created = new Date(rblxUser.created).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

            // Avatar holen
            let avatar = null;
            try {
                const avRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxUserId}&size=150x150&format=Png`);
                const avData = await avRes.json();
                avatar = avData.data?.[0]?.imageUrl || null;
            } catch(_) {}

            // History laden
            const history = getModHistory(robloxUserId);

            if (history.length === 0) {
                return interaction.editReply({ content: `✅ **${displayName}** (@${username}) hat keine Moderations-Eintraege.` });
            }

            // Emojis
            const actionEmojis = {
                'Ban':         { text: '<:Ban:1490446877785854163>',        id: '1490446877785854163', name: 'Ban' },
                'One Day Ban': { text: '<:OneDayBan:1490448467498373280>',  id: '1490448467498373280', name: 'OneDayBan' },
                'Kick':        { text: '<:Kick:1490450344663322727>',       id: '1490450344663322727', name: 'Kick' },
                'Warn':        { text: '<:Warn:1490447092584288336>',       id: '1490447092584288336', name: 'Warn' },
                'Notiz':       { text: '<:notizblock:1490444362365272064>', id: '1490444362365272064', name: 'notizblock' },
            };
            const getActionEmoji = (a) => actionEmojis[a] || actionEmojis['Warn'];

            const profileUrl = `https://www.roblox.com/users/${robloxUserId}/profile`;
            const { ButtonBuilder, ButtonStyle } = await import('discord.js');

            // Header — SectionBuilder braucht Accessory, nur bei Avatar. Sonst plain TextDisplay.
            const container = new ContainerBuilder();
            if (avatar) {
                const headerSection = new SectionBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${displayName}'s moderations`))
                    .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar));
                container.addSectionComponents(headerSection);
            } else {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${displayName}'s moderations`));
            }
            container
                .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `**User ID** · \`${robloxUserId}\`\n` +
                        `**Display Name** · ${displayName}\n` +
                        `**Account Created** · ${created}`
                    )
                );

            // Eintraege anzeigen (letzte 10)
            const entries = history.slice(-10);
            for (const entry of entries) {
                const eEmoji = getActionEmoji(entry.action).text;
                const eDate = new Date(entry.date).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' });
                const eTime = new Date(entry.date).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

                container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `${eEmoji} **Staff:** @${entry.moderator || 'Unbekannt'}\n` +
                        `**Punishment** · ${entry.action}\n` +
                        `**Reason** · ${entry.reason || 'Kein Grund'}\n` +
                        `-# ${eDate} ${eTime}`
                    )
                );
            }

            // Footer mit Count + Button
            container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# ${history.length} moderation${history.length !== 1 ? 's' : ''}`)
            );
            container.addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Roblox Profil')
                        .setStyle(ButtonStyle.Link)
                        .setURL(profileUrl)
                        .setEmoji({ name: 'roblox', id: '1433535007246516446' })
                )
            );

            // Select-Menü wenn mehr als 10 Eintraege
            if (history.length > 1) {
                try {
                    const offset = Math.max(0, history.length - 25);
                    const options = history.slice(-25).map((h, i) => {
                        const hE = getActionEmoji(h.action);
                        const hDate = new Date(h.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
                        return {
                            label: `#${offset + i + 1} ${h.action} — ${(h.reason || 'Kein Grund').slice(0, 50)}`.slice(0, 100),
                            description: `von ${h.moderator || 'Unbekannt'} · ${hDate}`.slice(0, 100),
                            value: `modentry_${robloxUserId}_${offset + i}`,
                            emoji: { name: hE.name, id: hE.id }
                        };
                    });
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId(`mod_history_select_${robloxUserId}`)
                        .setPlaceholder(`📋 Alle ${history.length} Eintraege anzeigen...`)
                        .addOptions(options);
                    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
                    container.addActionRowComponents(new ActionRowBuilder().addComponents(selectMenu));
                } catch(selectErr) { console.error('[Moderations] Select-Menü Fehler:', selectErr.message); }
            }

            await interaction.editReply({
                components: [container],
                flags: MessageFlags.IsComponentsV2
            });
        } catch(e) {
            console.error('[Moderations CMD] Fehler:', e);
            const reply = { content: '❌ Fehler: ' + e.message, ephemeral: true };
            if (interaction.deferred) await interaction.editReply(reply).catch(() => {});
            else await interaction.reply(reply).catch(() => {});
        }
        return;
    }

    // /leaderboard-init — Erstellt oder repariert das Live-Shift-Leaderboard (nur Owner)
    if (interaction.commandName === "leaderboard-init") {
        console.log(`[Leaderboard] /leaderboard-init aufgerufen von ${interaction.user.id} (${interaction.user.username}) in Channel ${interaction.channelId}`);
        try {
            if (!OWNER_IDS.includes(interaction.user.id)) {
                console.log(`[Leaderboard] Ablehnung: ${interaction.user.id} nicht in OWNER_IDS`);
                return interaction.reply({ content: "❌ Dieser Command ist nur fuer Bot-Owner.", flags: MessageFlags.Ephemeral });
            }
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            console.log('[Leaderboard] Deferred — starte Panel-Erstellung...');
            const channelId = interaction.channelId || LEADERBOARD_DEFAULT_CHANNEL_ID;
            const result = await ensureLeaderboardPanel(channelId, { force: true });
            console.log('[Leaderboard] Panel-Ergebnis:', result);
            if (result.ok) {
                return interaction.editReply({ content: `✅ Live-Leaderboard-Panel aktiv in <#${channelId}>. Wird jede Minute aktualisiert. (Action: ${result.action}, Msg: ${result.messageId})` });
            }
            return interaction.editReply({ content: `❌ Konnte Panel nicht erstellen: ${result.error || 'unknown'}` });
        } catch(e) {
            console.error('[Leaderboard] Init-Fehler:', e.message, e.stack);
            const reply = { content: '❌ Fehler: ' + e.message, flags: MessageFlags.Ephemeral };
            if (interaction.deferred) await interaction.editReply({ content: reply.content }).catch(err => console.error('[Leaderboard] editReply scheiterte:', err.message));
            else await interaction.reply(reply).catch(err => console.error('[Leaderboard] reply scheiterte:', err.message));
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
const GSG9_GUILD_ID_CMD = '1398612779325329418';
(async () => {
    try {
        // Haupt-Server
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
            { body: commandsForDiscord }
        );
        // GSG9-Server (für /gsg9verify)
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GSG9_GUILD_ID_CMD),
            { body: [gsg9VerifyCommand.toJSON()] }
        );
        console.log("✅ Slash Commands auf beiden Servern registriert!");
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

    // Staff-only GET Endpoints: Caller muss ?discordId=... mitschicken und EN-Team-Rolle haben
    const staffOnlyPaths = ["/api/mod-log", "/api/on-duty", "/api/shifts", "/api/streaks", "/api/storage", "/api/mod-history", "/api/support-cases/open"];
    if (req.method === "GET" && staffOnlyPaths.includes(url.pathname)) {
        const callerDid = url.searchParams.get("discordId") || url.searchParams.get("callerId");
        if (!callerDid) {
            res.writeHead(403);
            return res.end(JSON.stringify({ error: "discordId required" }));
        }
        try {
            const EN_TEAM_CHECK = "1365083291044282389";
            const g = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            // Cache-First: verhindert, dass transiente Discord-API-Fehler Staff aussperren
            let m = g.members.cache.get(callerDid) || null;
            if (!m) {
                try { m = await g.members.fetch(callerDid); }
                catch(fErr) {
                    if (fErr?.code === 10007) {
                        res.writeHead(403);
                        return res.end(JSON.stringify({ error: "Nicht im Server" }));
                    }
                    // Transienter Fehler → 503 statt 403, damit Client weiss, dass Retry sinnvoll ist
                    res.writeHead(503);
                    return res.end(JSON.stringify({ error: "member_fetch_failed", retry: true }));
                }
            }
            if (!m.roles.cache.has(EN_TEAM_CHECK)) {
                res.writeHead(403);
                return res.end(JSON.stringify({ error: "Nicht berechtigt (keine EN-Team-Rolle)" }));
            }
        } catch (e) {
            res.writeHead(503);
            return res.end(JSON.stringify({ error: "Auth-Check fehlgeschlagen", retry: true }));
        }
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
                let isStaff = false;
                const EN_TEAM_ROLE_ID = "1365083291044282389";
                try {
                    const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
                    const member = await guild.members.fetch(entry.discordId).catch(() => null);
                    if (member) {
                        // STRIKTER Check: Nur EN-Team-Rolle = Staff. Admin nur wenn Staff + Administrator-Permission.
                        isStaff = member.roles.cache.has(EN_TEAM_ROLE_ID);
                        isAdmin = isStaff && member.permissions.has("Administrator");
                    }
                } catch (_) { }

                const role = isAdmin ? 'admin' : isStaff ? 'staff' : 'user';
                console.log(`[API] ✅ ${entry.username} eingeloggt — ${role.toUpperCase()}`);
                registerUser(entry.discordId, entry.username, entry.avatar, role);

                res.writeHead(200);
                return res.end(JSON.stringify({
                    success: true,
                    user: {
                        id: entry.discordId, username: entry.username,
                        tag: entry.tag, avatar: entry.avatar,
                        role, isStaff, discordId: entry.discordId,
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
    // GET /api/support-cases/open — staff-only Liste offener Cases (ohne Ghost-Cases)
    if (req.method === "GET" && url.pathname === "/api/support-cases/open") {
        const now = Date.now();
        const open = Object.values(supportCases)
            .filter(c => c.status === 'open' && (now - (c.createdAt || 0)) < SUPPORT_CASE_STALE_MS)
            .map(c => supportCaseSnapshot(c))
            .sort((a, b) => a.createdAt - b.createdAt);
        res.writeHead(200);
        return res.end(JSON.stringify({ cases: open }));
    }

    // ─── TICKET CLAIM/REPLY/HISTORY ────────────────────────────────
    // GET /api/ticket/history?channelId=...&discordId=... — Letzte 30 Messages
    if (req.method === "GET" && url.pathname === "/api/ticket/history") {
        try {
            const channelId = url.searchParams.get("channelId");
            const callerDid = url.searchParams.get("discordId");
            if (!channelId) { res.writeHead(400); return res.end(JSON.stringify({ error: "channelId required" })); }
            const guild = client.guilds.cache.get(GUILD_ID);
            const ch = guild?.channels?.cache?.get(channelId);
            if (!ch || !isTicketChannel(ch)) { res.writeHead(404); return res.end(JSON.stringify({ error: "Kein Ticket-Channel" })); }
            // Staff-Check
            const EN_TEAM = "1365083291044282389";
            const m = guild.members.cache.get(callerDid);
            if (!m || !m.roles.cache.has(EN_TEAM)) {
                res.writeHead(403); return res.end(JSON.stringify({ error: "Nicht berechtigt" }));
            }
            const messages = await ch.messages.fetch({ limit: 30 });
            const arr = Array.from(messages.values()).reverse().map(msg => ({
                channelId: ch.id,
                channelName: ch.name,
                messageId: msg.id,
                authorId: msg.author.id,
                authorName: msg.member?.displayName || msg.author.displayName || msg.author.username,
                authorAvatar: msg.author.displayAvatarURL({ size: 64, extension: 'png' }),
                authorIsBot: msg.author.bot,
                content: msg.content || '',
                attachments: msg.attachments?.map(a => ({ url: a.url, name: a.name })) || [],
                ts: msg.createdTimestamp,
            }));
            const claim = ticketClaims[channelId] || null;
            res.writeHead(200);
            return res.end(JSON.stringify({ ok: true, messages: arr, claim }));
        } catch(e) {
            res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // POST /api/ticket/claim — body: { channelId, discordId }
    if (req.method === "POST" && url.pathname === "/api/ticket/claim") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { channelId, discordId } = JSON.parse(body || "{}");
                if (!channelId || !discordId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "channelId + discordId" })); }
                const guild = client.guilds.cache.get(GUILD_ID);
                const ch = guild?.channels?.cache?.get(channelId);
                if (!ch) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "Channel nicht gefunden" })); }
                const EN_TEAM = "1365083291044282389";
                const m = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
                if (!m || !m.roles.cache.has(EN_TEAM)) {
                    res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "Nur Staff kann claimen" }));
                }
                if (ticketClaims[channelId] && ticketClaims[channelId].claimerDiscordId !== discordId) {
                    res.writeHead(409);
                    return res.end(JSON.stringify({ ok: false, error: "Bereits geclaimt von " + ticketClaims[channelId].claimerName, taken: true }));
                }
                const claimerName = m.displayName || m.user.username;
                ticketClaims[channelId] = {
                    channelId, channelName: ch.name,
                    claimerDiscordId: discordId,
                    claimerName,
                    claimerAvatar: m.user.displayAvatarURL({ size: 64, extension: 'png' }),
                    claimedAt: Date.now(),
                };
                saveTicketClaims();
                // Webhook-Post: "✅ @user hat das Ticket geclaimt"
                try {
                    const hook = await getOrCreateTicketWebhook(ch);
                    if (hook) {
                        await hook.send({
                            username: claimerName,
                            avatarURL: m.user.displayAvatarURL({ size: 128, extension: 'png' }),
                            content: `✅ **${claimerName}** hat das Ticket übernommen.\n-# Bearbeitet via Emden Network Overlay`,
                        });
                    }
                } catch(e) { console.warn('[Ticket] Webhook claim-post:', e.message); }
                io.emit("ticket_claimed", {
                    channelId, channelName: ch.name,
                    claimerDiscordId: discordId,
                    claimerName,
                    claimerAvatar: m.user.displayAvatarURL({ size: 64, extension: 'png' }),
                    claimedAt: ticketClaims[channelId].claimedAt,
                });
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, claim: ticketClaims[channelId] }));
            } catch (e) {
                console.error('[Ticket] /claim:', e);
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/ticket/reply — body: { channelId, discordId, text }
    if (req.method === "POST" && url.pathname === "/api/ticket/reply") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { channelId, discordId, text } = JSON.parse(body || "{}");
                if (!channelId || !discordId || !text) {
                    res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "channelId + discordId + text" }));
                }
                if (text.length > 2000) {
                    res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "Text zu lang (max 2000)" }));
                }
                const guild = client.guilds.cache.get(GUILD_ID);
                const ch = guild?.channels?.cache?.get(channelId);
                if (!ch || !isTicketChannel(ch)) {
                    res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "Kein Ticket-Channel" }));
                }
                const EN_TEAM = "1365083291044282389";
                const m = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
                if (!m || !m.roles.cache.has(EN_TEAM)) {
                    res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "Nur Staff" }));
                }
                const hook = await getOrCreateTicketWebhook(ch);
                if (!hook) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, error: "Kann Webhook nicht erstellen (Bot-Permissions: Manage Webhooks?)" })); }
                const name = m.displayName || m.user.username;
                const avatarURL = m.user.displayAvatarURL({ size: 128, extension: 'png' });
                const sentMsg = await hook.send({ username: name, avatarURL, content: text });
                // Live-Broadcast (messageCreate skipt webhooks → wir broadcasten manuell mit Staff-Discord-ID)
                try {
                    io.emit("ticket_message", {
                        channelId: ch.id,
                        channelName: ch.name,
                        messageId: sentMsg?.id || ('local-' + Date.now()),
                        authorId: discordId,
                        authorName: name,
                        authorAvatar: avatarURL,
                        authorIsBot: false,
                        content: text,
                        attachments: [],
                        ts: Date.now(),
                        claimerDiscordId: ticketClaims[ch.id]?.claimerDiscordId || null,
                    });
                } catch(_) {}
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                console.error('[Ticket] /reply:', e);
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/ticket/my-claims?discordId=... → Aktive Claims dieses Staff-Members
    if (req.method === "GET" && url.pathname === "/api/ticket/my-claims") {
        try {
            const discordId = url.searchParams.get("discordId");
            if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "discordId" })); }
            const guild = client.guilds.cache.get(GUILD_ID);
            const items = [];
            for (const [chId, claim] of Object.entries(ticketClaims)) {
                if (claim.claimerDiscordId !== discordId) continue;
                const ch = guild?.channels?.cache?.get(chId);
                if (!ch) {
                    delete ticketClaims[chId];
                    continue;
                }
                items.push({
                    channelId: chId,
                    channelName: ch.name,
                    claimedAt: claim.claimedAt,
                    lastActivity: ch.lastMessage?.createdTimestamp || claim.claimedAt,
                });
            }
            saveTicketClaims();
            items.sort((a, b) => b.lastActivity - a.lastActivity);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, items }));
        } catch (e) {
            console.error('[Ticket] /my-claims:', e);
            res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
        }
        return;
    }

    // POST /api/ticket/close — body: { channelId, discordId } → Channel nach Bestätigung schließen
    if (req.method === "POST" && url.pathname === "/api/ticket/close") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { channelId, discordId } = JSON.parse(body || "{}");
                if (!channelId || !discordId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "channelId + discordId" })); }
                const guild = client.guilds.cache.get(GUILD_ID);
                const ch = guild?.channels?.cache?.get(channelId);
                if (!ch || !isTicketChannel(ch)) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "Kein Ticket-Channel" })); }
                const EN_TEAM = "1365083291044282389";
                const m = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
                if (!m || !m.roles.cache.has(EN_TEAM)) { res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "Nur Staff" })); }
                const claim = ticketClaims[channelId];
                if (claim && claim.claimerDiscordId !== discordId) {
                    res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "Nicht dein Ticket" }));
                }
                // Posten via Webhook als Staff: "Ticket wird in 30s geschlossen"
                const hook = await getOrCreateTicketWebhook(ch);
                const name = m.displayName || m.user.username;
                const avatarURL = m.user.displayAvatarURL({ size: 128, extension: 'png' });
                if (hook) {
                    await hook.send({
                        username: name,
                        avatarURL,
                        content: '🔒 **Dieses Ticket wird in 30 Sekunden geschlossen.** Antworte mit `cancel` um abzubrechen.'
                    }).catch(() => {});
                }
                // Schedule deletion
                const cancelKey = '__close_' + channelId;
                if (global[cancelKey]) clearTimeout(global[cancelKey]);
                global[cancelKey] = setTimeout(async () => {
                    try {
                        const cur = guild?.channels?.cache?.get(channelId);
                        if (!cur) return;
                        delete ticketClaims[channelId];
                        saveTicketClaims();
                        io.emit("ticket_closed", { channelId });
                        await cur.delete('Ticket geschlossen via Overlay').catch(() => {});
                    } catch (e) { console.error('[Ticket] close timer:', e); }
                    delete global[cancelKey];
                }, 30000);
                // Listener für 'cancel' Nachricht (einmalig)
                const cancelListener = (m2) => {
                    if (m2.channel.id !== channelId) return;
                    if ((m2.content || '').trim().toLowerCase() === 'cancel') {
                        if (global[cancelKey]) {
                            clearTimeout(global[cancelKey]);
                            delete global[cancelKey];
                            if (hook) hook.send({ username: name, avatarURL, content: '✅ Schließung abgebrochen.' }).catch(() => {});
                            client.off('messageCreate', cancelListener);
                        }
                    }
                };
                client.on('messageCreate', cancelListener);
                setTimeout(() => client.off('messageCreate', cancelListener), 35000);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, scheduledIn: 30 }));
            } catch (e) {
                console.error('[Ticket] /close:', e);
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/ticket/transfer — body: { channelId, discordId } → Claim freigeben + neuen Toast für andere Staff
    if (req.method === "POST" && url.pathname === "/api/ticket/transfer") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { channelId, discordId } = JSON.parse(body || "{}");
                if (!channelId || !discordId) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, error: "channelId + discordId" })); }
                const guild = client.guilds.cache.get(GUILD_ID);
                const ch = guild?.channels?.cache?.get(channelId);
                if (!ch || !isTicketChannel(ch)) { res.writeHead(404); return res.end(JSON.stringify({ ok: false, error: "Kein Ticket-Channel" })); }
                const claim = ticketClaims[channelId];
                if (!claim || claim.claimerDiscordId !== discordId) {
                    res.writeHead(403); return res.end(JSON.stringify({ ok: false, error: "Nicht dein Ticket" }));
                }
                const m = guild.members.cache.get(discordId) || await guild.members.fetch(discordId).catch(() => null);
                const name = m?.displayName || m?.user?.username || claim.claimerName || 'Staff';
                const avatarURL = m?.user?.displayAvatarURL({ size: 128, extension: 'png' }) || claim.claimerAvatar;
                // Claim entfernen
                delete ticketClaims[channelId];
                saveTicketClaims();
                // Webhook-Hinweis im Channel
                const hook = await getOrCreateTicketWebhook(ch);
                if (hook) {
                    await hook.send({
                        username: name, avatarURL,
                        content: '↪️ **Ticket zur Übernahme freigegeben.** Anderer Staff kann jetzt claimen.'
                    }).catch(() => {});
                }
                // Broadcast: Toast wieder anzeigen für alle Staff
                io.emit("ticket_claimed", {
                    channelId, channelName: ch.name,
                    claimerDiscordId: null, claimerName: null, claimerAvatar: null, claimedAt: null,
                });
                io.emit("overlay_new_ticket", {
                    channelId, channelName: ch.name,
                    ticketId: ch.name, reason: 'Übernahme angefragt',
                });
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
            } catch (e) {
                console.error('[Ticket] /transfer:', e);
                res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // POST /api/support-case/take — body: { caseId, discordId }
    if (req.method === "POST" && url.pathname === "/api/support-case/take") {
        let body = "";
        req.on("data", c => (body += c));
        req.on("end", async () => {
            try {
                const { caseId, discordId } = JSON.parse(body || "{}");
                if (!caseId || !discordId) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ ok: false, error: "caseId und discordId erforderlich" }));
                }
                const result = await performSupportTake(caseId, discordId);
                if (!result.ok) {
                    res.writeHead(result.taken ? 409 : 400);
                    return res.end(JSON.stringify(result));
                }
                res.writeHead(200);
                res.end(JSON.stringify(result));
            } catch (e) {
                console.error('[Support] /take Fehler:', e);
                res.writeHead(500);
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

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
                const { userId, username, displayName, avatar, created, reason, action, moderator, moderatorDiscordId, moderatorAvatar, evidence, notiz } = JSON.parse(body || "{}");
                if (!userId || !action) {
                    res.writeHead(400);
                    return res.end(JSON.stringify({ success: false, error: "userId und action erforderlich" }));
                }
                // Security: Caller muss EN-Team-Rolle haben
                if (!moderatorDiscordId) {
                    res.writeHead(403);
                    return res.end(JSON.stringify({ success: false, error: "moderatorDiscordId erforderlich" }));
                }
                try {
                    const EN_TEAM = "1365083291044282389";
                    const gg = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
                    // Cache-First fuer Robustheit gegen Discord-Rate-Limits
                    let mm = gg.members.cache.get(moderatorDiscordId) || null;
                    if (!mm) {
                        try { mm = await gg.members.fetch(moderatorDiscordId); }
                        catch(fErr) {
                            if (fErr?.code === 10007) {
                                res.writeHead(403);
                                return res.end(JSON.stringify({ success: false, error: "Nicht im Discord-Server" }));
                            }
                            res.writeHead(503);
                            return res.end(JSON.stringify({ success: false, error: "member_fetch_failed", retry: true }));
                        }
                    }
                    if (!mm.roles.cache.has(EN_TEAM)) {
                        res.writeHead(403);
                        return res.end(JSON.stringify({ success: false, error: "Nicht berechtigt (keine EN-Team-Rolle)" }));
                    }
                } catch (permErr) {
                    res.writeHead(503);
                    return res.end(JSON.stringify({ success: false, error: "Auth-Check fehlgeschlagen", retry: true }));
                }

                const MOD_CHANNEL_ID = "1367243128284905573";
                // Custom Emojis für Aktionen
                const actionEmojis = {
                    'Ban':         { text: '<:Ban:1490446877785854163>',        id: '1490446877785854163', name: 'Ban' },
                    'One Day Ban': { text: '<:OneDayBan:1490448467498373280>',  id: '1490448467498373280', name: 'OneDayBan' },
                    'Kick':        { text: '<:Kick:1490450344663322727>',       id: '1490450344663322727', name: 'Kick' },
                    'Warn':        { text: '<:Warn:1490447092584288336>',       id: '1490447092584288336', name: 'Warn' },
                    'Notiz':       { text: '<:notizblock:1490444362365272064>', id: '1490444362365272064', name: 'notizblock' },
                };
                const getActionEmoji = (a) => actionEmojis[a] || actionEmojis['Warn'];
                const emoji = getActionEmoji(action).text;

                // Moderator Rang-Emoji ermitteln
                const rankEmojis = {
                    'projektleitung': '<:Projektleitung:1489311699625578666>',
                    'stv. projektleitung': '<:StvPrpjektleitung:1489311731950944559>',
                    'management': '<:Manager:1489311838016635151>',
                    'manager': '<:Manager:1489311838016635151>',
                    'teamleitung': '<:Teamleitung:1489312932415410237>',
                    'stv. teamleitung': '<:StvTeamleitung:1489312944574435458>',
                    'sen. admin': '<:Administration:1489312566030110721>',
                    'admin': '<:Administration:1489312566030110721>',
                    'administrator': '<:Administration:1489312566030110721>',
                    'jun. admin': '<:Administration:1489312566030110721>',
                    'sen. mod': '<:Moderation:1489312529254449353>',
                    'moderator': '<:Moderation:1489312529254449353>',
                    'mod': '<:Moderation:1489312529254449353>',
                    'trial mod': '<:Trialmoderation:1489312502088073308>',
                    'trial moderator': '<:Trialmoderation:1489312502088073308>',
                };

                // Moderator-Rolle aus Discord holen
                let modRankEmoji = '<:Trialmoderation:1489312502088073308>';
                let modRankName = 'Moderator';
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        // Moderator Discord-ID aus allKnownUsers finden
                        let modDiscordId = null;
                        for (const [id, u] of allKnownUsers.entries()) {
                            if (u.username === moderator) { modDiscordId = id; break; }
                        }
                        if (modDiscordId) {
                            const member = await guild.members.fetch(modDiscordId).catch(() => null);
                            if (member) {
                                // Höchste passende Rolle finden
                                const roles = member.roles.cache.sort((a, b) => b.position - a.position);
                                for (const [, role] of roles) {
                                    const roleLower = role.name.toLowerCase();
                                    // Prüfe ob der Rollenname einen der Keys enthält
                                    for (const [key, emojiVal] of Object.entries(rankEmojis)) {
                                        if (roleLower.includes(key)) { modRankEmoji = emojiVal; modRankName = role.name; break; }
                                    }
                                    if (modRankName !== 'Moderator') break; // Gefunden, aufhören
                                }
                            }
                        }
                    }
                } catch(e) {}

                // History speichern + Eintragsnummer holen
                const history = getModHistory(userId);
                // Moderator-Avatar aus allKnownUsers holen
                let modAvatarUrl = moderatorAvatar || null;
                if (!modAvatarUrl) {
                    for (const [, u] of allKnownUsers.entries()) {
                        if (u.username === moderator) { modAvatarUrl = u.avatar || null; break; }
                    }
                }
                const entryNum = addModEntry(userId, {
                    action, reason: reason || 'Kein Grund', moderator, date: new Date().toISOString(),
                    displayName: displayName || username, modAvatar: modAvatarUrl,
                    notiz: notiz || null
                });
                const prevCount = entryNum - 1;

                // Components V2 via discord.js Builder
                const channel = await client.channels.fetch(MOD_CHANNEL_ID).catch(() => null);
                if (!channel) {
                    res.writeHead(500);
                    return res.end(JSON.stringify({ success: false, error: "Kanal nicht gefunden" }));
                }

                const profileUrl = `https://www.roblox.com/users/${userId}/profile`;

                // Roblox Profil Button mit Custom Emoji
                const { ButtonBuilder, ButtonStyle } = await import('discord.js');
                const buttonRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Roblox Profil')
                        .setStyle(ButtonStyle.Link)
                        .setURL(profileUrl)
                        .setEmoji({ name: 'roblox', id: '1433535007246516446' })
                );

                // Container bauen — SectionBuilder braucht zwingend ein Accessory (Thumbnail),
                // daher nur nutzen wenn Avatar vorhanden. Sonst plain TextDisplay.
                const container = new ContainerBuilder();
                if (avatar) {
                    const headerSection = new SectionBuilder()
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(`${emoji} **${action}**\n# ${displayName || username}`)
                        )
                        .setThumbnailAccessory(new ThumbnailBuilder().setURL(avatar));
                    container.addSectionComponents(headerSection);
                } else {
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`${emoji} **${action}**\n# ${displayName || username}`)
                    );
                }
                container
                    .addSeparatorComponents(
                        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `**User ID** · \`${userId}\`\n` +
                            `**Display Name** · ${displayName || '—'}\n` +
                            `**Username** · @${username}\n` +
                            `**Account Created** · ${created || 'Unbekannt'}`
                        )
                    )
                    .addSeparatorComponents(
                        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                    )
                // Bei Notiz: Notiz-Text statt Reason/Punishment anzeigen
                if (action === 'Notiz') {
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`<:notizblock:1490444362365272064> **Notiz**\n> ${notiz || reason || 'Keine Notiz'}`)
                    );
                    if (reason && reason !== 'Kein Grund') {
                        container.addSeparatorComponents(
                            new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
                        );
                        container.addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(`-# Grund: ${reason}`)
                        );
                    }
                } else {
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`<:notizblock:1490444362365272064> **Reason**\n> ${reason || 'Kein Grund angegeben'}`)
                    );
                    container.addSeparatorComponents(
                        new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
                    );
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`**Punishment** · ${emoji} ${action}`)
                    );
                    // Extra Notiz (wenn bei Nicht-Notiz-Aktion trotzdem eine Notiz dabei ist)
                    if (notiz) {
                        container.addSeparatorComponents(
                            new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
                        );
                        container.addTextDisplayComponents(
                            new TextDisplayBuilder().setContent(`<:notizblock:1490444362365272064> **Notiz**\n> ${notiz}`)
                        );
                    }
                }
                container.addSeparatorComponents(
                        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                    )
                    .addActionRowComponents(buttonRow)
                // Historie-Info wenn vorherige Einträge existieren
                if (prevCount > 0) {
                    const historyLines = history.slice(-3).map((h) => {
                        const hEmoji = getActionEmoji(h.action).text;
                        const hDate = new Date(h.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
                        return `-# ${hEmoji} ${h.action} · ${h.reason} · ${hDate}`;
                    }).join('\n');

                    container.addSeparatorComponents(
                        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                    );
                    container.addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`📋 **Eintrag #${entryNum}** — ${prevCount} vorherige Bestrafung${prevCount > 1 ? 'en' : ''}\n${historyLines}`)
                    );
                }

                // Select-Menü direkt im Container (wenn mehr als 1 Eintrag)
                const allEntries = getModHistory(userId);
                if (allEntries.length > 1) {
                    try {
                        const offset = Math.max(0, allEntries.length - 25);
                        const options = allEntries.slice(-25).map((h, i) => {
                            const hE = getActionEmoji(h.action);
                            const hDate = new Date(h.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
                            return {
                                label: `#${offset + i + 1} ${h.action} — ${(h.reason || 'Kein Grund').slice(0, 50)}`.slice(0, 100),
                                description: `von ${h.moderator || 'Unbekannt'} · ${hDate}`.slice(0, 100),
                                value: `modentry_${userId}_${offset + i}`,
                                emoji: { name: hE.name, id: hE.id }
                            };
                        });

                        const selectMenu = new StringSelectMenuBuilder()
                            .setCustomId(`mod_history_select_${userId}`)
                            .setPlaceholder(`📋 Alle ${allEntries.length} Einträge anzeigen...`)
                            .addOptions(options);

                        container.addSeparatorComponents(
                            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
                        );
                        container.addActionRowComponents(
                            new ActionRowBuilder().addComponents(selectMenu)
                        );
                    } catch(selectErr) {
                        console.error('[Mod] Select-Menü Fehler:', selectErr.message);
                    }
                }

                // Beweis-Bild: Base64 speichern + Button im Container
                if (evidence) {
                    try {
                        const base64Data = evidence.replace(/^data:image\/\w+;base64,/, '');
                        const evidenceId = `evidence_${userId}_${Date.now()}`;
                        // Base64 in Memory speichern für Button-Handler
                        if (!global._evidenceStore) global._evidenceStore = new Map();
                        global._evidenceStore.set(evidenceId, base64Data);
                        // Nach 7 Tagen löschen
                        setTimeout(() => global._evidenceStore?.delete(evidenceId), 7 * 86400000);

                        buttonRow.addComponents(
                            new ButtonBuilder()
                                .setCustomId(evidenceId)
                                .setLabel('Beweis')
                                .setStyle(ButtonStyle.Secondary)
                                .setEmoji({ name: '📸' })
                        );
                    } catch(imgErr) {
                        console.error('[Mod] Bild-Fehler:', imgErr.message);
                    }
                }

                container.addSeparatorComponents(
                        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large)
                    )
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(`-# ${modRankEmoji} ${modRankName}: @${moderator || 'Unbekannt'} · <t:${Math.floor(Date.now()/1000)}:R>`)
                    );

                await channel.send({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2
                });

                console.log(`[Mod] ${moderator} → ${action} ${username} (${userId}): ${reason}`);

                // Streak: Eintrag zählen (Moderator Discord-ID finden)
                let modIdForStreak = null;
                for (const [id, u] of allKnownUsers.entries()) {
                    if (u.username === moderator) { modIdForStreak = id; break; }
                }
                if (modIdForStreak) {
                    const streakUp = addStreakEntry(modIdForStreak);
                    if (streakUp) {
                        const st = getStreak(modIdForStreak);
                        io.emit('streak_complete', { discordId: modIdForStreak, streak: st.streak, bestStreak: st.bestStreak, username: moderator });
                    }
                }

                // Live broadcast: neuer Eintrag an alle Clients
                io.emit('mod_new_entry', {
                    userId, username, displayName: displayName || username,
                    avatar: avatar || '', action, reason: reason || 'Kein Grund',
                    moderator, moderatorAvatar: modAvatarUrl || '',
                    date: new Date().toISOString(), entryNum,
                });

                res.writeHead(200);
                return res.end(JSON.stringify({ success: true }));
            } catch (e) {
                console.error("[Mod] Fehler:", e.message, e.stack);
                res.writeHead(500);
                return res.end(JSON.stringify({ success: false, error: e.message }));
            }
        });
        return;
    }

    // GET /api/mod-history?userId=xxx — Gibt Mod-History eines Users zurück
    if (req.method === "GET" && url.pathname === "/api/mod-history") {
        const userId = url.searchParams.get("userId");
        if (!userId) { res.writeHead(400); return res.end(JSON.stringify({ error: "userId required" })); }
        const history = getModHistory(userId);

        // Moderator-Avatare aus allKnownUsers holen
        const enriched = history.map((h, i) => {
            let modAvatar = h.modAvatar || null;
            let modDiscordId = null;
            if (h.moderator) {
                for (const [id, u] of allKnownUsers.entries()) {
                    if (u.username === h.moderator) {
                        if (!modAvatar) modAvatar = u.avatar || null;
                        modDiscordId = id;
                        break;
                    }
                }
            }
            return { ...h, index: i + 1, modAvatar, modDiscordId };
        });

        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, userId, count: enriched.length, entries: enriched }));
    }

    // GET /api/mod-log — Gibt die letzten Moderations-Einträge zurück (alle User)
    if (req.method === "GET" && url.pathname === "/api/mod-log") {
        const limit = parseInt(url.searchParams.get("limit")) || 50;
        const allEntries = [];
        for (const [userId, entries] of Object.entries(modHistory)) {
            for (const e of entries) {
                allEntries.push({ ...e, userId });
            }
        }
        allEntries.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        const limited = allEntries.slice(0, limit);

        // Moderator-Avatare anreichern
        const enriched = limited.map(e => {
            let moderatorAvatar = e.modAvatar || null;
            if (e.moderator) {
                for (const [id, u] of allKnownUsers.entries()) {
                    if (u.username === e.moderator) {
                        if (!moderatorAvatar) moderatorAvatar = u.avatar || null;
                        break;
                    }
                }
            }
            return { ...e, moderatorAvatar };
        });

        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, log: enriched }));
    }

    // GET /api/on-duty — Gibt gecachte On-Duty Members zurück (Cache refreshed alle 15s)
    if (req.method === "GET" && url.pathname === "/api/on-duty") {
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, staff: cachedOnDutyStaff }));
    }

    // GET /api/streaks — Alle Streak-Daten
    if (req.method === "GET" && url.pathname === "/api/streaks") {
        const result = {};
        for (const [id, s] of Object.entries(streakData)) {
            const known = allKnownUsers.get(id);
            const gs = getStreak(id); // Aktualisiert Tag-Reset
            result[id] = {
                streak: gs.streak, bestStreak: gs.bestStreak || 0,
                todayMs: gs.todayMs, todayEntries: gs.todayEntries,
                protected: gs.protected || false,
                completed: gs.lastCompletedDate === getToday(),
                username: known?.username || '?', avatar: known?.avatar || '',
            };
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, streaks: result, requirements: { minMs: STREAK_MIN_MS, minEntries: STREAK_MIN_ENTRIES } }));
    }

    // ================================================================
    // GSG9 TEAM ROSTER (Cached — refreshed alle 30s im Hintergrund)
    // ================================================================
    if (req.method === "GET" && url.pathname === "/api/gsg9") {
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, teams: cachedGSG9Teams }));
    }

    // ================================================================
    // SHIFT SYSTEM ENDPOINTS
    // ================================================================

    // Helper: Check if user has lead role
    async function isLead(discordId) {
        try {
            const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(discordId).catch(() => null);
            if (!member) return false;
            return LEAD_ROLE_IDS.some(id => member.roles.cache.has(id));
        } catch(e) { return false; }
    }

    // GET /api/shifts — Alle Shifts + Leaderboard
    if (req.method === "GET" && url.pathname === "/api/shifts") {
        const shifts = {};
        for (const id of Object.keys(shiftData)) {
            shifts[id] = buildShiftSnapshot(id);
        }
        // Leaderboard Usernames korrigieren (alte Einträge haben '?')
        const enrichedLb = {};
        for (const [id, lb] of Object.entries(shiftLeaderboard)) {
            const known = allKnownUsers.get(id);
            enrichedLb[id] = { ...lb, username: known?.username || lb.username || '?', avatar: known?.avatar || lb.avatar || '' };
        }
        res.writeHead(200);
        return res.end(JSON.stringify({ success: true, shifts, leaderboard: enrichedLb, serverNow: Date.now() }));
    }

    // POST /api/shift/start — On Duty starten
    if (req.method === "POST" && url.pathname === "/api/shift/start") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId required" })); }
                if (!canTransitionShift(discordId)) {
                    res.writeHead(429);
                    return res.end(JSON.stringify({ success: false, error: "Zu schnell — kurz warten." }));
                }
                const s = getShift(discordId);
                if (s.state === 'active') {
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true, shift: buildShiftSnapshot(discordId), message: "Bereits aktiv" }));
                }
                const now = Date.now();
                // Pause beenden: Zeit in breakMs + pauseHistory persistieren
                if (s.state === 'break' && s.breakStartedAt) {
                    const dur = Math.max(0, now - s.breakStartedAt);
                    s.breakMs = (s.breakMs || 0) + dur;
                    s.pauseHistory.push({ start: s.breakStartedAt, end: now, durationMs: dur });
                    if (s.pauseHistory.length > 200) s.pauseHistory = s.pauseHistory.slice(-200);
                }
                s.state = 'active';
                s.startedAt = now;
                s.breakStartedAt = null;
                saveShifts();
                const snapshot = buildShiftSnapshot(discordId);
                io.emit('shift_update', snapshot);
                // On Duty Rolle geben
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        const member = await guild.members.fetch(discordId).catch(() => null);
                        if (member && !member.roles.cache.has(ON_DUTY_ROLE_ID)) {
                            await member.roles.add(ON_DUTY_ROLE_ID).catch(() => {});
                        }
                    }
                } catch(e) {}
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, shift: snapshot }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        }); return;
    }

    // POST /api/shift/pause — Pause (Zeit wird gespeichert, Timer stoppt)
    if (req.method === "POST" && url.pathname === "/api/shift/pause") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId required" })); }
                if (!canTransitionShift(discordId)) {
                    res.writeHead(429);
                    return res.end(JSON.stringify({ success: false, error: "Zu schnell — kurz warten." }));
                }
                const s = getShift(discordId);
                if (s.state !== 'active') {
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true, shift: buildShiftSnapshot(discordId), message: "Nicht aktiv" }));
                }
                const now = Date.now();
                if (s.startedAt) s.savedMs = (s.savedMs || 0) + Math.max(0, now - s.startedAt);
                s.state = 'break';
                s.startedAt = null;
                s.breakStartedAt = now;
                saveShifts();
                const snapshot = buildShiftSnapshot(discordId);
                io.emit('shift_update', snapshot);
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, shift: snapshot }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        }); return;
    }

    // POST /api/shift/end — Shift beenden (Zeit gespeichert, State = off)
    if (req.method === "POST" && url.pathname === "/api/shift/end") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ error: "discordId required" })); }
                if (!canTransitionShift(discordId)) {
                    res.writeHead(429);
                    return res.end(JSON.stringify({ success: false, error: "Zu schnell — kurz warten." }));
                }
                const s = getShift(discordId);
                const now = Date.now();
                // Laufende Zeit finalisieren
                if (s.state === 'active' && s.startedAt) {
                    s.savedMs = (s.savedMs || 0) + Math.max(0, now - s.startedAt);
                }
                if (s.state === 'break' && s.breakStartedAt) {
                    const dur = Math.max(0, now - s.breakStartedAt);
                    s.breakMs = (s.breakMs || 0) + dur;
                    s.pauseHistory.push({ start: s.breakStartedAt, end: now, durationMs: dur });
                    if (s.pauseHistory.length > 200) s.pauseHistory = s.pauseHistory.slice(-200);
                }
                const known = allKnownUsers.get(discordId);
                if (!shiftLeaderboard[discordId]) shiftLeaderboard[discordId] = { totalMs: 0, username: '', avatar: '' };
                shiftLeaderboard[discordId].totalMs += s.savedMs || 0;
                shiftLeaderboard[discordId].username = known?.username || shiftLeaderboard[discordId].username || '?';
                shiftLeaderboard[discordId].avatar = known?.avatar || shiftLeaderboard[discordId].avatar || '';
                saveLeaderboard();

                const streakUp = addStreakTime(discordId, s.savedMs || 0);
                if (streakUp) {
                    const st = getStreak(discordId);
                    io.emit('streak_complete', { discordId, streak: st.streak, bestStreak: st.bestStreak, username: known?.username || '?' });
                }

                s.state = 'off';
                s.startedAt = null;
                s.breakStartedAt = null;
                // savedMs + breakMs bleiben erhalten — User kann weiter machen / Lead sieht Daten
                saveShifts();
                const snapshot = buildShiftSnapshot(discordId);
                io.emit('shift_update', snapshot);
                try {
                    const guild = client.guilds.cache.get(GUILD_ID);
                    if (guild) {
                        const member = await guild.members.fetch(discordId).catch(() => null);
                        if (member && member.roles.cache.has(ON_DUTY_ROLE_ID)) {
                            await member.roles.remove(ON_DUTY_ROLE_ID).catch(() => {});
                        }
                    }
                } catch(e) {}
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, shift: snapshot, savedMs: s.savedMs }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        }); return;
    }

    // POST /api/shift/manage — Zeit geben/nehmen/reset (nur Leads)
    if (req.method === "POST" && url.pathname === "/api/shift/manage") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
            try {
                const { leadDiscordId, targetDiscordId, action, amountMs } = JSON.parse(body || "{}");
                if (!leadDiscordId || !action) { res.writeHead(400); return res.end(JSON.stringify({ error: "leadDiscordId und action required" })); }

                const hasPermission = await isLead(leadDiscordId);
                if (!hasPermission) { res.writeHead(403); return res.end(JSON.stringify({ error: "Keine Berechtigung" })); }

                if (action === 'reset-all') {
                    // Reset ALL shifts to 0 (leaderboard stays!)
                    for (const id of Object.keys(shiftData)) {
                        shiftData[id].savedMs = 0;
                        shiftData[id].breakMs = 0;
                        shiftData[id].pauseHistory = [];
                        shiftData[id].startedAt = shiftData[id].state === 'active' ? Date.now() : null;
                        shiftData[id].breakStartedAt = shiftData[id].state === 'break' ? Date.now() : null;
                    }
                    saveShifts();
                    for (const id of Object.keys(shiftData)) {
                        io.emit('shift_update', buildShiftSnapshot(id));
                    }
                    res.writeHead(200);
                    return res.end(JSON.stringify({ success: true, message: "Alle Shifts zurückgesetzt" }));
                }

                if (!targetDiscordId) { res.writeHead(400); return res.end(JSON.stringify({ error: "targetDiscordId required" })); }
                const s = getShift(targetDiscordId);

                if (action === 'add') {
                    s.savedMs = (s.savedMs || 0) + (amountMs || 0);
                } else if (action === 'remove') {
                    s.savedMs = Math.max(0, (s.savedMs || 0) - (amountMs || 0));
                } else if (action === 'reset') {
                    s.savedMs = 0;
                    if (s.state === 'active') s.startedAt = Date.now();
                } else if (action === 'add-break') {
                    s.breakMs = (s.breakMs || 0) + (amountMs || 0);
                } else if (action === 'remove-break') {
                    s.breakMs = Math.max(0, (s.breakMs || 0) - (amountMs || 0));
                } else if (action === 'reset-break') {
                    s.breakMs = 0;
                    if (s.state === 'break') s.breakStartedAt = Date.now();
                }
                saveShifts();
                const snapshot = buildShiftSnapshot(targetDiscordId);
                io.emit('shift_update', snapshot);

                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, shift: snapshot, savedMs: s.savedMs }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        }); return;
    }

    // ================================================================
    // MOD-LOG DELETE (nur Leads)
    // ================================================================

    // POST /api/mod-log/delete — Einzelnen Eintrag löschen
    if (req.method === "POST" && url.pathname === "/api/mod-log/delete") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
            try {
                const { leadDiscordId, userId, entryIndex } = JSON.parse(body || "{}");
                if (!leadDiscordId || !userId || entryIndex === undefined) {
                    res.writeHead(400); return res.end(JSON.stringify({ error: "leadDiscordId, userId, entryIndex required" }));
                }

                const hasPermission = await isLead(leadDiscordId);
                if (!hasPermission) { res.writeHead(403); return res.end(JSON.stringify({ error: "Keine Berechtigung" })); }

                const history = modHistory[userId];
                if (!history || entryIndex < 0 || entryIndex >= history.length) {
                    res.writeHead(404); return res.end(JSON.stringify({ error: "Eintrag nicht gefunden" }));
                }

                history.splice(entryIndex, 1);
                if (history.length === 0) delete modHistory[userId];
                saveModHistory();

                console.log(`[Mod] Lead ${leadDiscordId} hat Eintrag #${entryIndex} von User ${userId} gelöscht`);
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        }); return;
    }

    // POST /api/check-lead — Prüft ob ein User Lead-Rechte hat
    if (req.method === "POST" && url.pathname === "/api/check-lead") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                const hasPermission = await isLead(discordId);
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, isLead: hasPermission }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ error: e.message })); }
        }); return;
    }

    // POST /api/check-staff — Prüft ob ein User Staff (EN Team) oder Admin ist
    if (req.method === "POST" && url.pathname === "/api/check-staff") {
        let body = ""; req.on("data", c => (body += c)); req.on("end", async () => {
            try {
                const { discordId } = JSON.parse(body || "{}");
                if (!discordId) { res.writeHead(400); return res.end(JSON.stringify({ success: false, error: "discordId erforderlich" })); }
                const EN_TEAM_ROLE_ID = "1365083291044282389";
                let guild = null;
                try {
                    guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
                } catch(gErr) {
                    res.writeHead(503);
                    return res.end(JSON.stringify({ success: false, error: "guild_fetch_failed" }));
                }
                if (!guild) { res.writeHead(503); return res.end(JSON.stringify({ success: false, error: "guild_unavailable" })); }

                // Cache-First: vermeidet unnoetige Discord-API-Calls und ist robust gegen Rate-Limits
                let member = guild.members.cache.get(discordId) || null;
                if (!member) {
                    try { member = await guild.members.fetch(discordId); }
                    catch(fErr) {
                        // 10007 = Unknown Member → User ist wirklich nicht im Server (kein Fehler, nur kein Staff)
                        const code = fErr?.code;
                        if (code === 10007) {
                            res.writeHead(200);
                            return res.end(JSON.stringify({ success: true, isStaff: false, isAdmin: false }));
                        }
                        // Andere Fehler (Rate-Limit, Timeout, etc.) → Client soll retryen
                        res.writeHead(503);
                        return res.end(JSON.stringify({ success: false, error: "member_fetch_failed", code: code || 'unknown' }));
                    }
                }
                const isStaff = member.roles.cache.has(EN_TEAM_ROLE_ID);
                const isAdmin = isStaff && member.permissions.has("Administrator");
                res.writeHead(200);
                return res.end(JSON.stringify({ success: true, isStaff, isAdmin }));
            } catch(e) { res.writeHead(500); return res.end(JSON.stringify({ success: false, error: e.message })); }
        }); return;
    }

    // GET /api/storage — Speicher-Statistik aller Daten
    if (req.method === "GET" && url.pathname === "/api/storage") {
        try {
            const dataDir = path.join(path.resolve(), "data");
            const files = [
                { name: 'modHistory.json', path: MOD_HISTORY_FILE, desc: 'Mod-Eintraege' },
                { name: 'shifts.json', path: SHIFT_FILE, desc: 'Shift-Daten' },
                { name: 'shiftLeaderboard.json', path: SHIFT_LEADERBOARD_FILE, desc: 'Shift-Rangliste' },
                { name: 'streaks.json', path: STREAK_FILE, desc: 'Streak-Daten' },
                { name: 'robloxLinks.json', path: LINKS_FILE, desc: 'Roblox-Verknuepfungen' },
                { name: 'allUsers.json', path: ALL_USERS_FILE, desc: 'User-Registry' },
            ];

            let totalBytes = 0;
            const details = files.map(f => {
                let size = 0;
                try { if (fs.existsSync(f.path)) size = fs.statSync(f.path).size; } catch(_) {}
                totalBytes += size;
                return { name: f.name, desc: f.desc, bytes: size, display: size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(2)} MB` };
            });

            // Zaehler
            let totalEntries = 0;
            let totalUsers = 0;
            for (const entries of Object.values(modHistory)) totalEntries += entries.length;
            totalUsers = Object.keys(modHistory).length;

            res.writeHead(200);
            return res.end(JSON.stringify({
                success: true,
                total: { bytes: totalBytes, display: totalBytes < 1048576 ? `${(totalBytes / 1024).toFixed(1)} KB` : `${(totalBytes / 1048576).toFixed(2)} MB` },
                files: details,
                counts: {
                    modEntries: totalEntries,
                    modUsers: totalUsers,
                    shifts: Object.keys(shiftData).length,
                    streaks: Object.keys(streakData).length,
                    robloxLinks: robloxLinks.size,
                    knownUsers: allKnownUsers.size,
                    evidenceStore: global._evidenceStore?.size || 0,
                },
                memory: {
                    heapUsed: `${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB`,
                    heapTotal: `${(process.memoryUsage().heapTotal / 1048576).toFixed(1)} MB`,
                    rss: `${(process.memoryUsage().rss / 1048576).toFixed(1)} MB`,
                },
                server: {
                    totalRAM: `${(os.totalmem() / 1073741824).toFixed(1)} GB`,
                    freeRAM: `${(os.freemem() / 1073741824).toFixed(2)} GB`,
                    usedRAM: `${((os.totalmem() - os.freemem()) / 1073741824).toFixed(2)} GB`,
                    ramPercent: `${(((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(0)}%`,
                    platform: os.platform(),
                    cpus: os.cpus().length,
                    disk: (() => { try { const out = execSync('df -h / --output=size,used,avail,pcent 2>/dev/null || df -h / 2>/dev/null', { timeout: 3000 }).toString().trim().split('\n'); return out.length > 1 ? out[1].trim().replace(/\s+/g, ' ') : 'N/A'; } catch(_) { return 'N/A'; } })(),
                },
                uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
            }));
        } catch(e) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: e.message }));
        }
    }

    // GET /api/mobile-version — Mobile App Update-Check
    if (req.method === "GET" && url.pathname === "/api/mobile-version") {
        // Aktuelle Mobile-Version + APK-URL
        const MOBILE_VERSION = '1.1.0';
        const APK_URL = `https://github.com/princearmy2024/Emden-Network/releases/latest/download/Emden-Network-Mobile.apk`;
        const CHANGELOG = [
            'Mod-Panel: Roblox-Suche + Warn/Kick/Ban/Notiz',
            'Mod-History Anzeige pro User',
            'Auto-Update System',
        ];
        res.writeHead(200);
        return res.end(JSON.stringify({
            success: true,
            version: MOBILE_VERSION,
            apkUrl: APK_URL,
            changelog: CHANGELOG,
            mandatory: false,
        }));
    }

    // GET /api/roblox/lookup?robloxId=xxx — Prüft ob ein Roblox-User mit Discord verknüpft ist
    if (req.method === "GET" && url.pathname === "/api/roblox/lookup") {
        const robloxId = url.searchParams.get("robloxId");
        if (!robloxId) { res.writeHead(400); return res.end(JSON.stringify({ error: "robloxId required" })); }

        // Reverse-Lookup: robloxLinks ist discordId -> robloxId
        let discordId = null;
        for (const [dId, rId] of robloxLinks.entries()) {
            if (String(rId) === String(robloxId)) { discordId = dId; break; }
        }

        if (!discordId) {
            res.writeHead(200);
            return res.end(JSON.stringify({ linked: false }));
        }

        // Discord-User Info holen
        try {
            const guild = client.guilds.cache.get(GUILD_ID) || await client.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(discordId).catch(() => null);
            const knownUser = allKnownUsers.get(discordId);

            res.writeHead(200);
            return res.end(JSON.stringify({
                linked: true,
                discordId,
                discordUsername: member?.displayName || member?.user?.username || knownUser?.username || 'Unbekannt',
                discordAvatar: member?.user?.displayAvatarURL({ size: 128 }) || knownUser?.avatar || null,
                discordTag: member?.user?.tag || null,
                inServer: !!member,
                status: member?.presence?.status || 'offline',
                roles: member?.roles?.cache
                    ?.filter(r => r.name !== '@everyone')
                    ?.sort((a, b) => b.position - a.position)
                    ?.first(3)
                    ?.map(r => ({ name: r.name, color: r.hexColor })) || [],
            }));
        } catch (e) {
            res.writeHead(200);
            return res.end(JSON.stringify({ linked: true, discordId, error: e.message }));
        }
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

    // Panic Button: Broadcast an alle
    socket.on("panic_button", (data) => {
        console.log(`[PANIC] ${data.username} (${data.robloxUsername}) hat Panic Button gedrückt!`);
        io.emit("panic_alert", {
            discordId: data.discordId,
            username: data.username,
            robloxUsername: data.robloxUsername,
            avatar: data.avatar,
            timestamp: Date.now(),
        });
    });

    // Panic Accept: Jemand kommt zur Hilfe — ALLE sehen es
    socket.on("panic_accept", (data) => {
        console.log(`[PANIC] ${data.username} akzeptiert Panic von ${data.targetDiscordId}`);
        io.emit("panic_accepted", {
            acceptedBy: data.username,
            acceptedByRoblox: data.robloxUsername,
            acceptedByAvatar: data.avatar,
            targetDiscordId: data.targetDiscordId,
            targetUsername: data.targetUsername || 'Unbekannt',
        });
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
            socket.emit("msg_status", { id: msgData.id, status: otherCount > 0 ? 'delivered' : 'sent' });
        } else if (to.startsWith('@')) {
            // PN: an ALLE Sockets des Empfaengers + Echo an alle anderen Geraete des Senders
            const targetUsername = to.substring(1);
            const senderUsername = socket.chatUsername || msgData.username;
            let sent = false;
            for (const [, s] of io.sockets.sockets) {
                if (s.id === socket.id) continue;
                // Empfaenger
                if (s.chatUsername === targetUsername) {
                    s.emit("receive_message", msgData);
                    sent = true;
                }
                // Echo an Sender's andere Geraete (gleiche username, anderer socket)
                else if (s.chatUsername === senderUsername) {
                    s.emit("receive_message", msgData);
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

    // Read Receipt — nur an den urspruenglichen Sender (alle seine Geraete), nicht an alle
    socket.on("msg_read", ({ msgId, reader, sender }) => {
        if (!sender) return; // Privacy: ohne expliziten Sender nichts broadcasten
        for (const [sid, s] of io.sockets.sockets) {
            if (sid === socket.id) continue;
            if (s.chatUsername === sender) {
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
// 🏆 LIVE SHIFT LEADERBOARD — Components V2 Panel, Single-Message-Edit
// ================================================================
function formatShiftDuration(ms) {
    if (!ms || ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    const s = Math.floor((ms % 60000) / 1000);
    return `${s}s`;
}

function stateLabel(state) {
    if (state === 'active') return '🟢 On Duty';
    if (state === 'break')  return '🟡 Pause';
    return '⚫ Off Duty';
}

// Single Source für Leaderboard-Daten (damit Pagination und Auto-Update dieselben Zeilen haben)
async function collectLeaderboardRows() {
    // Cache-only — startOverlayDataLoop haelt Members aktuell (15s Intervall).
    // Kein members.fetch() hier: blockt sonst den Interaction-Response und spamt bei grossen Guilds Timeouts.
    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) return null;
    const EN_TEAM_ROLE_ID = "1365083291044282389";
    const enTeamMembers = guild.members.cache.filter(m => !m.user.bot && m.roles.cache.has(EN_TEAM_ROLE_ID));
    const rows = [];
    for (const [, member] of enTeamMembers) {
        const snap = buildShiftSnapshot(member.id);
        rows.push({
            discordId: member.id,
            username: member.displayName || member.user.username,
            state: snap.state,
            activeMs: snap.totalMs,
            breakMs: snap.totalBreakMs,
            pauseCount: snap.pauseCount,
        });
    }
    rows.sort((a, b) => (b.activeMs - a.activeMs) || a.username.localeCompare(b.username));
    return rows;
}

async function buildLeaderboardContainer(page = 0) {
    const rows = await collectLeaderboardRows();
    if (!rows) return null;

    const activeCount = rows.filter(r => r.state === 'active').length;
    const pauseCount  = rows.filter(r => r.state === 'break').length;
    const offCount    = rows.filter(r => r.state === 'off').length;
    const totalMsSum  = rows.reduce((sum, r) => sum + r.activeMs, 0);
    const totalPages  = Math.max(1, Math.ceil(rows.length / LEADERBOARD_PAGE_SIZE));
    const curPage     = Math.min(Math.max(0, page | 0), totalPages - 1);

    const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🏆  EN-Team · Shift-Leaderboard`))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `<:Moderation:1489312529254449353> **Im Dienst** · \`${activeCount}\` ` +
            `· ⏸️ **Pause** · \`${pauseCount}\` ` +
            `· 💤 **Off** · \`${offCount}\` ` +
            `· 👥 **Team** · \`${rows.length}\`\n` +
            `⌛ **Gesamtzeit** · \`${formatShiftDuration(totalMsSum)}\``
        ))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

    if (rows.length === 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Noch keine Shift-Daten vorhanden.`));
    } else {
        // Podium (Seite 1): Top 3 hervorgehoben
        // Ab Seite 2: nur die Liste
        if (curPage === 0) {
            const podium = rows.slice(0, 3);
            const rankEmoji = (i) => i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
            const rankLabel = (i) => i === 0 ? 'Platz 1' : i === 1 ? 'Platz 2' : i === 2 ? 'Platz 3' : `Platz ${i+1}`;
            for (let i = 0; i < podium.length; i++) {
                const r = podium[i];
                const pauseLine = r.breakMs > 0 ? `  ·  ⏸️ \`${formatShiftDuration(r.breakMs)}\`` : '';
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `${rankEmoji(i)}  **${rankLabel(i)}** · ${r.username}  ${stateLabel(r.state)}\n` +
                    `⏱ \`${formatShiftDuration(r.activeMs)}\`${pauseLine}`
                ));
                if (i < podium.length - 1) {
                    container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
                }
            }
            container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        }

        // Listen-Seite: pageSlice = Rest ab Rang 4 (auf Seite 1), oder alle 10 (auf Seite 2+)
        let sliceStart, sliceEnd, startRank;
        if (curPage === 0) {
            // Seite 1: zeige Rang 4..10 (7 Eintraege nach Podium)
            sliceStart = 3;
            sliceEnd = Math.min(LEADERBOARD_PAGE_SIZE, rows.length);
            startRank = 4;
        } else {
            sliceStart = curPage * LEADERBOARD_PAGE_SIZE;
            sliceEnd = Math.min(sliceStart + LEADERBOARD_PAGE_SIZE, rows.length);
            startRank = sliceStart + 1;
        }
        const pageRows = rows.slice(sliceStart, sliceEnd);
        if (pageRows.length > 0) {
            const lines = pageRows.map((r, i) => {
                const rank = startRank + i;
                const stateIcon = r.state === 'active' ? '🟢' : r.state === 'break' ? '🟡' : '⚫';
                const pauseInfo = r.breakMs > 0 ? `  ·  ⏸️ \`${formatShiftDuration(r.breakMs)}\`` : '';
                return `\`#${String(rank).padStart(2,' ')}\`  ${stateIcon}  **${r.username}**  ·  \`${formatShiftDuration(r.activeMs)}\`${pauseInfo}`;
            }).join('\n');
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines));
        }
    }

    // Pagination nur wenn mehr als 1 Seite
    if (totalPages > 1) {
        const { ButtonBuilder, ButtonStyle } = await import('discord.js');
        const navRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('lb_prev')
                .setLabel('Zurueck')
                .setEmoji('◀')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(curPage === 0),
            new ButtonBuilder()
                .setCustomId('lb_page_indicator')
                .setLabel(`Seite ${curPage + 1} / ${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId('lb_next')
                .setLabel('Weiter')
                .setEmoji('▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(curPage >= totalPages - 1),
            new ButtonBuilder()
                .setCustomId('lb_refresh')
                .setEmoji('🔄')
                .setStyle(ButtonStyle.Primary),
        );
        container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        container.addActionRowComponents(navRow);
    }

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# 🔄 Live · alle ${Math.round(LEADERBOARD_UPDATE_INTERVAL_MS/1000)}s aktualisiert  ·  Stand <t:${Math.floor(Date.now()/1000)}:T>`
    ));

    return container;
}

async function ensureLeaderboardPanel(fallbackChannelId = LEADERBOARD_DEFAULT_CHANNEL_ID, opts = {}) {
    try {
        const cfg = panelConfig.leaderboard || {};
        const channelId = opts.force ? fallbackChannelId : (cfg.channelId || fallbackChannelId);
        const page = cfg.currentPage || 0;
        const channel = await client.channels.fetch(channelId).catch(err => { console.warn('[Leaderboard] Channel-Fetch-Fehler:', err.message); return null; });
        if (!channel) { return { ok: false, error: 'channel_not_found' }; }

        const container = await buildLeaderboardContainer(page);
        if (!container) return { ok: false, error: 'guild_unavailable' };

        if (cfg.messageId && !opts.force) {
            try {
                const msg = await channel.messages.fetch(cfg.messageId);
                await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 });
                return { ok: true, action: 'edited', messageId: msg.id };
            } catch(e) {
                console.warn('[Leaderboard] Edit scheiterte, poste neu:', e.message);
            }
        }
        try {
            const newMsg = await channel.send({ components: [container], flags: MessageFlags.IsComponentsV2 });
            panelConfig.leaderboard = { channelId: channel.id, messageId: newMsg.id, createdAt: Date.now(), currentPage: page };
            savePanelConfig();
            console.log(`[Leaderboard] Neue Nachricht ${newMsg.id} gepostet in ${channel.id}.`);
            return { ok: true, action: 'created', messageId: newMsg.id };
        } catch(sendErr) {
            console.error('[Leaderboard] channel.send FEHLER:', sendErr.message, sendErr.code);
            return { ok: false, error: `send_failed: ${sendErr.message}` };
        }
    } catch(e) {
        console.error('[Leaderboard] ensure failed:', e.message, e.stack);
        return { ok: false, error: e.message };
    }
}

function startLeaderboardLoop() {
    setInterval(async () => {
        if (!panelConfig.leaderboard?.messageId) return; // Panel wurde nie initialisiert
        await ensureLeaderboardPanel().catch(e => console.warn('[Leaderboard] Update-Fehler:', e.message));
    }, LEADERBOARD_UPDATE_INTERVAL_MS);
}

// ================================================================
// 🚀 GITHUB RELEASE MONITOR (Components V2 — direkt via Bot)
// ================================================================
const GITHUB_OWNER = 'princearmy2024';
const GITHUB_REPO  = 'Emden-Network';
const UPDATE_CHANNEL_ID = '1487189134799011873'; // Channel fuer Update-Nachrichten

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
        const dateStr = new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

        // Commit-Messages seit letztem Tag holen (was genau geaendert wurde)
        let changes = [];
        try {
            const commitsRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits?per_page=15`, {
                headers: { 'User-Agent': 'EmdenNetwork-Bot' }
            });
            if (commitsRes.ok) {
                const commits = await commitsRes.json();
                // Commits bis zum vorherigen Tag sammeln
                for (const c of commits) {
                    const msg = c.commit?.message?.split('\n')[0] || '';
                    if (msg.includes('Co-Authored-By')) continue; // Skip co-author lines
                    if (msg.length < 3) continue;
                    changes.push(msg);
                    // Stoppe beim vorherigen Release
                    if (c.commit?.message?.includes(lastKnownTag)) break;
                    if (changes.length >= 8) break;
                }
            }
        } catch(_) {}

        // Fallback auf Release-Body wenn keine Commits
        if (changes.length === 0) {
            const body = release.body || '';
            changes = body.split('\n').filter(l => l.trim().length > 2).slice(0, 8);
        }

        const changeText = changes.length > 0
            ? changes.map(c => `> ${c.replace(/^[-*•]\s*/, '')}`).join('\n')
            : '> Keine Details verfuegbar';

        // Components V2 Container
        const channel = await client.channels.fetch(UPDATE_CHANNEL_ID).catch(() => null);
        if (!channel) {
            console.error('[Update] Update-Channel nicht gefunden:', UPDATE_CHANNEL_ID);
            return;
        }

        const { ButtonBuilder, ButtonStyle } = await import('discord.js');

        const container = new ContainerBuilder()
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`# Emden Network Control Center — ${release.tag_name}`)
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `**Version** · \`${version}\`\n` +
                    `**Status** · Stabil\n` +
                    `**Datum** · ${dateStr}`
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`**Aenderungen**\n${changeText}`)
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addActionRowComponents(
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setLabel('Emden Network')
                        .setStyle(ButtonStyle.Link)
                        .setURL('https://enrp.net')
                )
            )
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large))
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# Emden Network • Control Center · <t:${Math.floor(Date.now()/1000)}:R>`)
            );

        await channel.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2
        });

        console.log(`[Update] ✅ Update-Nachricht gesendet fuer ${release.tag_name}`);
    } catch (e) {
        console.error('[Update] Fehler beim GitHub-Check:', e.message);
    }
}

client.once("ready", async () => {
    console.log(`🤖 ${client.user.tag} ist online!`);
    console.log(`[Bot-Config] Support-System → Warteraum=${SUPPORT_VOICE_CHANNEL_ID}, Logs=${SUPPORT_LOGS_CHANNEL_ID}, Ping-Rolle=${SUPPORT_PING_ROLE_ID}`);

    // === Trident-Einträge importieren (einmalig beim Start) ===
    if (Object.keys(modHistory).length === 0) {
        console.log('[Mod] Importiere alte Einträge aus Kanal...');
        try {
            const modChannel = await client.channels.fetch("1367243128284905573").catch(() => null);
            if (modChannel) {
                let imported = 0;
                let lastId = null;
                // Letzte 4000 Nachrichten durchgehen
                for (let i = 0; i < 40; i++) {
                    const opts = { limit: 100 };
                    if (lastId) opts.before = lastId;
                    const messages = await modChannel.messages.fetch(opts);
                    if (messages.size === 0) break;
                    lastId = messages.last().id;

                    for (const [, msg] of messages) {
                        // Embeds (Trident-Format)
                        for (const embed of msg.embeds) {
                            const title = embed.title || '';
                            const match = title.match(/Moderation\s*\|\s*(\d+)/);
                            if (!match) continue;

                            const fields = {};
                            for (const f of (embed.fields || [])) {
                                fields[f.name?.toLowerCase()?.trim()] = f.value?.trim();
                            }

                            const robloxUserId = fields['user id'] || '';
                            const punishment = fields['punishment'] || '';
                            const reason = fields['reason'] || 'Kein Grund';
                            const displayName = fields['display name'] || '';
                            const moderatorText = embed.footer?.text || '';
                            const mod = moderatorText.replace(/Moderator:\s*@?/i, '').trim();

                            if (robloxUserId && punishment) {
                                if (!modHistory[robloxUserId]) modHistory[robloxUserId] = [];
                                modHistory[robloxUserId].push({
                                    action: punishment,
                                    reason,
                                    moderator: mod,
                                    date: msg.createdAt.toISOString(),
                                    displayName,
                                    source: 'trident'
                                });
                                imported++;
                            }
                        }

                        // Components V2 (unser Format) — Text aus TextDisplay parsen
                        if (msg.flags?.has('IsComponentsV2') || msg.components?.length > 0) {
                            // Unsere eigenen Nachrichten überspringen — die werden schon live gespeichert
                        }
                    }
                }
                if (imported > 0) {
                    saveModHistory();
                    console.log(`[Mod] ✅ ${imported} Einträge aus Trident importiert (${Object.keys(modHistory).length} User)`);
                } else {
                    console.log('[Mod] Keine Trident-Einträge gefunden.');
                }
            }
        } catch(e) {
            console.error('[Mod] Import-Fehler:', e.message);
        }
    } else {
        console.log(`[Mod] ${Object.keys(modHistory).length} User in History geladen.`);
    }

    startReminderScheduler(client);
    await client.guilds.fetch().catch(() => { });
    await updateBotStatus(client);
    setInterval(() => updateBotStatus(client), STATUS_UPDATE_INTERVAL);

    // Streak-Schutz prüfen (beim Start + alle 30min)
    await updateStreakProtection();
    setInterval(() => updateStreakProtection(), 30 * 60 * 1000);
    startOverlayDataLoop();

    // Auto-Sync Shifts zur ON_DUTY-Rolle — beim Start einmal alle Member durchgehen
    // (faengt auch Role-Changes ab die waehrend Bot-Downtime passiert sind)
    try {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (guild) {
            await guild.members.fetch().catch(() => {});
            let started = 0, ended = 0;
            // 1) Alle mit Rolle → auto-start falls off
            const role = guild.roles.cache.get(ON_DUTY_ROLE_ID);
            if (role) {
                for (const [, member] of role.members) {
                    const r = await syncShiftFromRole(member);
                    if (r === 'started') started++;
                }
            }
            // 2) Alle die Shift haben aber keine Rolle (mehr) → auto-end
            for (const [id, s] of Object.entries(shiftData)) {
                if (s.state === 'off') continue;
                const m = guild.members.cache.get(id);
                if (!m || !m.roles.cache.has(ON_DUTY_ROLE_ID)) {
                    if (m) {
                        const r = await syncShiftFromRole(m);
                        if (r === 'ended') ended++;
                    } else {
                        // User gar nicht mehr im Server → Shift sauber beenden
                        const now = Date.now();
                        if (s.state === 'active' && s.startedAt) s.savedMs = (s.savedMs || 0) + Math.max(0, now - s.startedAt);
                        s.state = 'off'; s.startedAt = null; s.breakStartedAt = null;
                        ended++;
                    }
                }
            }
            if (started || ended) saveShifts();
            console.log(`[Shift] Role-Sync beim Start: ${started} gestartet, ${ended} beendet.`);
        }
    } catch(e) { console.error('[Shift] Role-Sync Fehler:', e.message); }

    await checkGithubRelease();
    setInterval(checkGithubRelease, 5 * 60 * 1000);

    // Support-Cases Cleanup: einmal beim Start + alle 10min
    await cleanupStaleCases();
    setInterval(cleanupStaleCases, 10 * 60 * 1000);
    // Permission-Overwrite Cleanup: einmal beim Start (setTimeout geht bei Restart verloren)
    await cleanupSupportPermissionOverwrites();

    // Live-Shift-Leaderboard: falls Panel jemals initialisiert → alle 60s aktualisieren
    startLeaderboardLoop();
    if (panelConfig.leaderboard?.messageId) {
        setTimeout(() => ensureLeaderboardPanel().catch(() => {}), 3000);
        console.log(`[Leaderboard] Live-Panel aktiv: Kanal ${panelConfig.leaderboard.channelId}, Msg ${panelConfig.leaderboard.messageId}`);
    } else {
        console.log('[Leaderboard] Kein Panel initialisiert. Owner kann /leaderboard-init ausfuehren.');
    }
});

// ================================================================
// 🎯 ON_DUTY ROLLE → SHIFT AUTO-SYNC
// Sobald jemand die Rolle bekommt/verliert, wird die Shift entsprechend gestartet/beendet
// ================================================================
client.on("guildMemberUpdate", async (oldMember, newMember) => {
    if (newMember.guild.id !== GUILD_ID) return;
    const hadRole = oldMember.roles.cache.has(ON_DUTY_ROLE_ID);
    const hasRole = newMember.roles.cache.has(ON_DUTY_ROLE_ID);
    if (hadRole === hasRole) return; // Kein Wechsel der relevanten Rolle
    try {
        await syncShiftFromRole(newMember);
    } catch(e) {
        console.error('[Shift] guildMemberUpdate Sync-Fehler:', e.message);
    }
});

// ================================================================
// 📩 TICKET NOTIFICATION
// ================================================================
client.on("channelCreate", channel => {
    // Erkennt: ticket-XXX, -ticket-XXX, oder Channels in Ticket-Kategorien
    const name = channel.name || '';
    const parentName = channel.parent?.name?.toLowerCase() || '';
    const isTicket = name.includes('ticket') ||
                     parentName.includes('ticket') ||
                     parentName.includes('support ticket') ||
                     parentName.includes('report ticket');

    if (isTicket) {
        const reason = channel.parent ? channel.parent.name : "Neues Ticket";
        const ticketId = name.replace(/^-?ticket-?/, '').replace(/^-/, '') || name;
        console.log(`[Ticket] Neues Ticket: #${name} (${reason}) — channelId=${channel.id}`);
        // Erweiterte Daten: channelId fuer Claim/Reply
        io.emit("overlay_new_ticket", {
            ticketId,
            reason,
            channelName: name,
            channelId: channel.id,
        });
    }
});

function isTicketChannel(channel) {
    if (!channel) return false;
    const name = (channel.name || '').toLowerCase();
    const parentName = (channel.parent?.name || '').toLowerCase();
    return name.includes('ticket') || parentName.includes('ticket') ||
           parentName.includes('support ticket') || parentName.includes('report ticket');
}

// Live-Relay: Messages aus Ticket-Channels → Overlay
client.on("messageCreate", msg => {
    if (!msg.guild || msg.guild.id !== GUILD_ID) return;
    if (!isTicketChannel(msg.channel)) return;
    // Eigene Webhook-Messages NICHT zurueckschicken (verhindert Echo)
    if (msg.webhookId) return;
    // Bot-Messages mit "Ticket-Tool"-Style normal weiterleiten (User sieht Ticket-Bot Nachrichten)
    const claim = ticketClaims[msg.channel.id];
    const payload = {
        channelId: msg.channel.id,
        channelName: msg.channel.name,
        messageId: msg.id,
        authorId: msg.author.id,
        authorName: msg.member?.displayName || msg.author.displayName || msg.author.username,
        authorAvatar: msg.author.displayAvatarURL({ size: 64, extension: 'png' }),
        authorIsBot: msg.author.bot,
        content: msg.content || '',
        attachments: msg.attachments?.map(a => ({ url: a.url, name: a.name })) || [],
        ts: Date.now(),
        claimerDiscordId: claim?.claimerDiscordId || null,
    };
    // An den Claimer (gezielt) UND alle Staff-Overlays (zum Live-Anzeigen wenn man hineinschaut)
    io.emit("ticket_message", payload);
});

// Auch Threads erkennen (manche Ticket-Bots nutzen Threads)
client.on("threadCreate", thread => {
    const name = thread.name || '';
    const parentName = thread.parent?.name?.toLowerCase() || '';
    const isTicket = name.includes('ticket') || parentName.includes('ticket');

    if (isTicket) {
        const reason = thread.parent ? thread.parent.name : "Neues Ticket";
        console.log(`[Ticket] Neuer Thread-Ticket: ${name} (${reason})`);
        io.emit("overlay_new_ticket", { ticketId: name, reason, channelName: name });
        io.emit("dc_notification", {
            type: 'ticket',
            title: '📩 Neues Ticket',
            message: `${name} — ${reason}`,
            timestamp: Date.now()
        });
    }
});

// ================================================================
// 🔔 MENTION/PING NOTIFICATION
// ================================================================
client.on("messageCreate", async msg => {
    if (msg.author.bot) return;
    if (!msg.guild || msg.guild.id !== GUILD_ID) return;

    // Prüfe ob ein Dashboard-User erwähnt wurde
    for (const [userId] of msg.mentions.users) {
        if (dashboardUsers.has(userId) || allKnownUsers.has(userId)) {
            io.emit(`dc_mention_${userId}`, {
                type: 'mention',
                title: '🔔 Du wurdest erwähnt',
                message: `${msg.author.displayName || msg.author.username} in #${msg.channel.name}: "${msg.content.substring(0, 100)}"`,
                channelName: msg.channel.name,
                author: msg.author.displayName || msg.author.username,
                authorAvatar: msg.author.displayAvatarURL({ size: 64 }),
                timestamp: Date.now()
            });
        }
    }
});

// ================================================================
// 🎧 SUPPORT WARTERAUM TRACKING
// ================================================================
const SUPPORT_WAITING_CATEGORY = "Support channel"; // Name der Kategorie
let supportWaitingUsers = [];

client.on("voiceStateUpdate", (oldState, newState) => {
    // ─── SUPPORT-CASE SYSTEM ────────────────────────────────────────
    // ORDER: close vor post, sonst findet postSupportCase noch den alten
    // 'taken' Case und skipt die Neu-Erstellung.

    // 1) User mit uebernommenem Case verlaesst Support-Staff-Channel (Support 1-5):
    //    → Case schliessen. Block NUR wenn User NICHT zurueck zum Warteraum geht
    //      (wenn User wieder Hilfe will, soll neuer Case sofort moeglich sein).
    const leftSupportStaffChan = oldState.channelId && SUPPORT_STAFF_VOICE_IDS.includes(oldState.channelId);
    const switchedChannel = newState.channelId !== oldState.channelId;
    if (leftSupportStaffChan && switchedChannel) {
        const openCase = findOpenSupportCase(oldState.id);
        if (openCase && openCase.status === 'taken') {
            const goingToWarteraum = newState.channelId === SUPPORT_VOICE_CHANNEL_ID;
            // SYNC: status wird sofort auf 'closed' gesetzt; Discord-Edit laeuft async
            closeSupportCase(openCase, { applyBlock: !goingToWarteraum }).catch(e => console.warn('[Support] closeCase Fehler:', e.message));
        }
    }

    // 2) User joint den Warteraum → NEUEN Case-Panel posten (nach evtl. close oben)
    if (newState.channelId === SUPPORT_VOICE_CHANNEL_ID && oldState.channelId !== SUPPORT_VOICE_CHANNEL_ID) {
        const m = newState.member;
        if (m && !m.user.bot) {
            postSupportCase(m).catch(e => console.warn('[Support] postSupportCase Fehler:', e.message));
        }
    }

    // 3) User verlaesst Warteraum ohne dass Case uebernommen wurde → abbrechen ohne Block
    if (oldState.channelId === SUPPORT_VOICE_CHANNEL_ID && newState.channelId !== SUPPORT_VOICE_CHANNEL_ID) {
        const openCase = findOpenSupportCase(oldState.id);
        if (openCase && openCase.status === 'open') {
            closeSupportCase(openCase, { applyBlock: false }).catch(() => {});
        }
    }

    // ─── LEGACY support_waiting (Dashboard-Notification) ────────────
    // Prüfe ob jemand einen Support-Warteraum betritt/verlässt
    const channel = newState.channel || oldState.channel;
    if (!channel) return;

    const isSupport = channel.parent?.name?.toLowerCase().includes('support') ||
                      channel.name?.toLowerCase().includes('support') ||
                      channel.name?.toLowerCase().includes('warteraum') ||
                      channel.name?.toLowerCase().includes('wartezimmer');

    // Jemand betritt Support-Channel
    if (newState.channel && isSupport && (!oldState.channel || oldState.channel.id !== newState.channel.id)) {
        const member = newState.member;
        // Bots ignorieren (z.B. GalaxyBot 697498867754729482)
        if (member?.user?.bot) return;
        // Nur nicht-Staff (keine On-Duty Rolle)
        if (member && !member.roles.cache.has(ON_DUTY_ROLE_ID)) {
            console.log(`[Support] ${member.displayName} wartet in ${newState.channel.name}`);
            // NUR support_waiting senden (kein dc_notification — verhindert doppelt)
            io.emit("support_waiting", {
                action: 'join',
                userId: member.id,
                username: member.displayName || member.user.username,
                avatar: member.user.displayAvatarURL({ size: 64 }),
                channelName: newState.channel.name,
                channelId: newState.channel.id
            });
        }
    }

    // Jemand verlässt Support-Channel
    if (oldState.channel && !newState.channel && isSupport) {
        const member = oldState.member;
        if (member) {
            io.emit("support_waiting", {
                action: 'leave',
                userId: member.id,
                username: member.displayName || member.user.username
            });
        }
    }
});

let lastSupporterCount = -1;
// GSG9 Cache Refresh (alle 30s)
async function refreshGSG9Cache() {
    try {
        const GSG9_GID = '1398612779325329418';
        const guild = client.guilds.cache.get(GSG9_GID);
        if (!guild) return;
        await guild.members.fetch().catch(() => {});

        const GSG9_ROLES = [
            { id: '1398619556792242206', name: 'GSG9' },
            { id: '1419353950234083480', name: 'GSG9 Chief' },
            { id: '1405963717199527998', name: 'GSG9 Trial' },
        ];
        const GSG9_ON_DUTY_ROLE = '1419050043822047375';

        cachedGSG9Teams = GSG9_ROLES.map(r => {
            const role = guild.roles.cache.get(r.id);
            if (!role) return { name: r.name, color: '#5B9AFF', members: [] };
            return {
                name: role.name || r.name,
                color: role.hexColor !== '#000000' ? role.hexColor : '#5B9AFF',
                members: role.members.map(m => ({
                    discordId: m.id,
                    username: m.displayName || m.user.username,
                    avatar: m.user.displayAvatarURL({ size: 64 }),
                    status: m.presence?.status || 'offline',
                    onDuty: m.roles.cache.has(GSG9_ON_DUTY_ROLE),
                    robloxId: robloxLinks.get(m.id) || null,
                }))
            };
        });
    } catch(e) {}
}

function startOverlayDataLoop() {
    // GSG9 Cache sofort + alle 30s
    refreshGSG9Cache();
    setInterval(refreshGSG9Cache, 30000);
    setInterval(async () => {
        try {
            const guild = client.guilds.cache.get(GUILD_ID);
            if (guild) {
                // Members fetchen damit role.members aktuell ist
                await guild.members.fetch().catch(() => {});
                const role = guild.roles.cache.get(ON_DUTY_ROLE_ID);
                if (role) {
                    const count = role.members.size;
                    if (count !== lastSupporterCount) {
                        lastSupporterCount = count;
                        io.emit("overlay_supporter_count", { count });
                    }
                    // Update on-duty cache
                    cachedOnDutyStaff = role.members.map(m => ({
                        discordId: m.id,
                        username: m.user.username,
                        displayName: m.displayName,
                        avatar: m.user.displayAvatarURL({ size: 128 }),
                        roles: m.roles.cache
                            .filter(r => r.id !== guild.id)
                            .sort((a, b) => b.position - a.position)
                            .map(r => r.name)
                            .slice(0, 3),
                    }));
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