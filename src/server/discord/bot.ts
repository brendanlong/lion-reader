/**
 * Discord Bot for Lion Reader
 *
 * Saves articles when users react to messages with a configured emoji.
 * Users link their account by signing in with Discord on the web app.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type Message,
  type User,
  type PartialUser,
} from "discord.js";
import { eq, and } from "drizzle-orm";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import { saveArticle } from "@/server/services/saved";
import { logger } from "@/lib/logger";

// ============================================================================
// Configuration
// ============================================================================

const SAVE_EMOJI = process.env.DISCORD_SAVE_EMOJI || "🦁";
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

// ============================================================================
// URL Extraction
// ============================================================================

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;

const IGNORED_DOMAINS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "tenor.com",
  "giphy.com",
]);

function extractUrls(content: string): string[] {
  if (!content) return [];

  const matches = content.match(URL_REGEX) || [];

  return matches
    .map((url) => url.replace(/[.,;:!?)]+$/, ""))
    .filter((url) => {
      try {
        const parsed = new URL(url);
        if (IGNORED_DOMAINS.has(parsed.hostname)) {
          return false;
        }
        if (parsed.pathname.match(/\.(png|jpg|jpeg|gif|webp|mp4|webm|mov)$/i)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    });
}

// ============================================================================
// User Lookup
// ============================================================================

async function getUserIdByDiscordId(discordId: string): Promise<string | null> {
  const result = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(
      and(eq(oauthAccounts.provider, "discord"), eq(oauthAccounts.providerAccountId, discordId))
    )
    .limit(1);

  return result[0]?.userId ?? null;
}

// ============================================================================
// Bot Client
// ============================================================================

let client: Client | null = null;

export async function startDiscordBot(): Promise<void> {
  if (!DISCORD_TOKEN) {
    logger.info("Discord bot disabled (DISCORD_BOT_TOKEN not set)");
    return;
  }

  if (!DISCORD_CLIENT_ID) {
    logger.error("DISCORD_CLIENT_ID is required for Discord bot");
    return;
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Reaction],
  });

  // Register slash commands
  await registerCommands();

  // Handle slash commands
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "status") {
      const userId = await getUserIdByDiscordId(interaction.user.id);
      await interaction.reply({
        content: userId
          ? `Your Discord account is linked to Lion Reader. React to messages with ${SAVE_EMOJI} to save articles.`
          : `Your Discord account is not linked. Sign in with Discord at Lion Reader to connect your account.`,
        ephemeral: true,
      });
    }
  });

  // Handle reactions
  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    const emoji = reaction.emoji.name;
    if (emoji !== SAVE_EMOJI) return;

    await handleSaveReaction(reaction.message, user);
  });

  client.once("ready", () => {
    logger.info("Discord bot started", {
      tag: client?.user?.tag,
      saveEmoji: SAVE_EMOJI,
    });
  });

  await client.login(DISCORD_TOKEN);
}

async function registerCommands(): Promise<void> {
  if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) return;

  const commands = [
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Check if your Discord account is linked to Lion Reader"),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  try {
    logger.info("Registering Discord slash commands...");
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    logger.info("Discord slash commands registered");
  } catch (error) {
    logger.error("Failed to register Discord commands", { error });
  }
}

async function handleSaveReaction(
  partialMessage: Message | { partial: true; fetch: () => Promise<Message> },
  user: User | PartialUser
): Promise<void> {
  // Look up Lion Reader user by Discord ID
  const userId = await getUserIdByDiscordId(user.id);
  if (!userId) {
    // User hasn't linked their account - silently ignore
    return;
  }

  // Fetch full message if partial
  let message: Message;
  if (partialMessage.partial) {
    try {
      message = await partialMessage.fetch();
    } catch (error) {
      logger.error("Failed to fetch Discord message", { error });
      return;
    }
  } else {
    message = partialMessage as Message;
  }

  // Extract URLs
  const urls = extractUrls(message.content);
  if (urls.length === 0) return;

  // Save each URL
  const results: Array<{ success: boolean; title?: string; url: string; error?: string }> = [];

  for (const url of urls) {
    try {
      const saved = await saveArticle(db, userId, { url });
      logger.info("Saved article via Discord", {
        userId,
        discordUser: user.tag,
        url,
        title: saved.title,
      });
      results.push({ success: true, title: saved.title ?? url, url });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to save article via Discord", {
        userId,
        discordUser: user.tag,
        url,
        error: errorMessage,
      });
      results.push({ success: false, url, error: errorMessage });
    }
  }

  // DM user with results
  await sendResultsDM(user, results);
}

async function sendResultsDM(
  user: User | PartialUser,
  results: Array<{ success: boolean; title?: string; url: string; error?: string }>
): Promise<void> {
  if (results.length === 0) return;

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  let dmMessage = "";
  if (successCount > 0) {
    const saved = results.filter((r) => r.success);
    if (saved.length === 1) {
      dmMessage = `Saved to Lion Reader: **${saved[0].title}**`;
    } else {
      dmMessage = `Saved ${saved.length} articles to Lion Reader:\n${saved.map((r) => `• ${r.title}`).join("\n")}`;
    }
  }
  if (failCount > 0) {
    const failed = results.filter((r) => !r.success);
    if (dmMessage) dmMessage += "\n\n";
    dmMessage += `Failed to save: ${failed.map((r) => r.url).join(", ")}`;
  }

  try {
    await user.send(dmMessage);
  } catch {
    // User may have DMs disabled
    logger.debug("Could not DM Discord user", { userId: user.id });
  }
}

export async function stopDiscordBot(): Promise<void> {
  if (client) {
    client.destroy();
    client = null;
    logger.info("Discord bot stopped");
  }
}
