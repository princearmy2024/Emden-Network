// commands/verify.js
import { SlashCommandBuilder } from "discord.js";
import crypto from "node:crypto";
import { verificationCodes } from "../data/verificationStore.js";

export default {
    data: new SlashCommandBuilder()
        .setName("verify")
        .setDescription("Erhalte deinen Verifikationscode für das Emden Network Dashboard"),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        // Alten Code dieses Users löschen
        for (const [k, v] of verificationCodes.entries()) {
            if (v.discordId === interaction.user.id) verificationCodes.delete(k);
        }

        const code      = `EN-${crypto.randomInt(100000, 999999)}`;
        const expiresAt = Date.now() + 10 * 60 * 1000;

        verificationCodes.set(code, {
            discordId: interaction.user.id,
            username:  interaction.user.displayName || interaction.user.username,
            tag:       interaction.user.tag,
            avatar:    interaction.user.displayAvatarURL({ size: 128 }),
            expiresAt,
        });

        console.log(`[VERIFY] Code ${code} → ${interaction.user.tag} | Store-Größe: ${verificationCodes.size}`);

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
    },
};
