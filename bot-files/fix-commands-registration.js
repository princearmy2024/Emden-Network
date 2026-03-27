// ============================================================
// SCHRITT 1: Ersetze in deiner index.js den Commands-Registrierungs-Block
//
// SUCHE diesen Block:
//
//   const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);
//   (async () => {
//       ...
//       await rest.put(
//           Routes.applicationCommands(process.env.CLIENT_ID),  ← DAS hier
//           { body: commandsForDiscord }
//       );
//       ...
//   })();
//
// ERSETZE "Routes.applicationCommands(process.env.CLIENT_ID)"
// MIT    "Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID)"
//
// Fertig sieht es so aus:
// ============================================================

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log(`📡 Registriere ${commandsForDiscord.length} Slash Commands (Guild)...`);

        await rest.put(
            // ✅ Guild-spezifisch = SOFORT sichtbar (kein 1h Warten!)
            Routes.applicationGuildCommands(process.env.CLIENT_ID, GUILD_ID),
            { body: commandsForDiscord }
        );

        console.log("✅ Slash Commands sofort registriert auf Server: " + GUILD_ID);
    } catch (error) {
        console.error("❌ Fehler beim Registrieren:", error);
    }
})();
