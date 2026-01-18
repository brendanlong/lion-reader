/**
 * Discord Bot for Lion Reader
 *
 * Saves articles when users react to messages with a configured emoji.
 * Users can link their account either by:
 * 1. Signing in with Discord on the web app (OAuth)
 * 2. Using /link with an API token
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type User,
  type PartialUser,
} from "discord.js";
import { eq, and } from "drizzle-orm";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import { saveArticle } from "@/server/services/saved";
import { validateApiToken } from "@/server/auth/api-token";
import { getRedisClient } from "@/server/redis";
import { logger } from "@/lib/logger";

// ============================================================================
// Configuration
// ============================================================================

const SAVE_EMOJI = process.env.DISCORD_SAVE_EMOJI || "🦁";
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

// Redis key prefix for storing Discord user -> API token mappings
const REDIS_KEY_PREFIX = "discord:token:";

// In-memory fallback when Redis is unavailable
const tokenCache = new Map<string, string>();

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
// Token Storage (Redis with in-memory fallback)
// ============================================================================

async function storeApiToken(discordId: string, apiToken: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.set(`${REDIS_KEY_PREFIX}${discordId}`, apiToken);
  } else {
    tokenCache.set(discordId, apiToken);
  }
}

async function getApiToken(discordId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    return await redis.get(`${REDIS_KEY_PREFIX}${discordId}`);
  }
  return tokenCache.get(discordId) ?? null;
}

async function removeApiToken(discordId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(`${REDIS_KEY_PREFIX}${discordId}`);
  } else {
    tokenCache.delete(discordId);
  }
}

// ============================================================================
// User Lookup
// ============================================================================

interface ResolvedUser {
  userId: string;
  method: "oauth" | "token";
}

/**
 * Look up a Lion Reader user by Discord ID.
 * Tries OAuth first, then falls back to API token.
 */
async function resolveUser(discordId: string): Promise<ResolvedUser | null> {
  // First, check OAuth linking
  const oauthResult = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(
      and(eq(oauthAccounts.provider, "discord"), eq(oauthAccounts.providerAccountId, discordId))
    )
    .limit(1);

  if (oauthResult[0]) {
    return { userId: oauthResult[0].userId, method: "oauth" };
  }

  // Fall back to API token
  const apiToken = await getApiToken(discordId);
  if (apiToken) {
    const tokenData = await validateApiToken(apiToken);
    if (tokenData) {
      return { userId: tokenData.user.id, method: "token" };
    }
    // Token is invalid, clean it up
    await removeApiToken(discordId);
  }

  return null;
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

    const { commandName, user } = interaction;

    if (commandName === "link") {
      await handleLinkCommand(interaction, user);
    } else if (commandName === "unlink") {
      await handleUnlinkCommand(interaction, user);
    } else if (commandName === "status") {
      await handleStatusCommand(interaction, user);
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
      .setName("link")
      .setDescription("Link your Lion Reader account using an API token")
      .addStringOption((option) =>
        option
          .setName("token")
          .setDescription("Your Lion Reader API token (from Settings > API Tokens)")
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("unlink")
      .setDescription("Remove your linked API token (OAuth link is not affected)"),
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

// ============================================================================
// Command Handlers
// ============================================================================

async function handleLinkCommand(
  interaction: ChatInputCommandInteraction,
  user: User
): Promise<void> {
  const token = interaction.options.getString("token", true);

  // Validate the token
  const tokenData = await validateApiToken(token);

  if (!tokenData) {
    await interaction.reply({
      content:
        "Invalid API token. Please check your token and try again.\n\n" +
        "To get a token: Lion Reader → Settings → API Tokens → Create with 'Save articles' scope.",
      ephemeral: true,
    });
    return;
  }

  // Store the token
  await storeApiToken(user.id, token);

  await interaction.reply({
    content:
      `Your Lion Reader account is now linked via API token. ` +
      `React to any message containing a URL with ${SAVE_EMOJI} to save it.`,
    ephemeral: true,
  });

  logger.info("Discord user linked via API token", {
    discordId: user.id,
    userId: tokenData.user.id,
  });
}

async function handleUnlinkCommand(
  interaction: ChatInputCommandInteraction,
  user: User
): Promise<void> {
  const hadToken = (await getApiToken(user.id)) !== null;
  await removeApiToken(user.id);

  // Check if they still have OAuth
  const oauthResult = await db
    .select({ userId: oauthAccounts.userId })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.provider, "discord"), eq(oauthAccounts.providerAccountId, user.id)))
    .limit(1);

  const hasOAuth = oauthResult.length > 0;

  if (hadToken) {
    await interaction.reply({
      content: hasOAuth
        ? "API token removed. You're still linked via Discord OAuth, so saving will continue to work."
        : "API token removed. You're no longer linked to Lion Reader.",
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: hasOAuth
        ? "You don't have an API token linked, but you're connected via Discord OAuth."
        : "You don't have an API token linked. Use `/link` to connect, or sign in with Discord on the Lion Reader website.",
      ephemeral: true,
    });
  }
}

async function handleStatusCommand(
  interaction: ChatInputCommandInteraction,
  user: User
): Promise<void> {
  const resolved = await resolveUser(user.id);

  if (resolved) {
    const methodText = resolved.method === "oauth" ? "Discord OAuth" : "API token";
    await interaction.reply({
      content: `Your account is linked via ${methodText}. React to messages with ${SAVE_EMOJI} to save articles.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content:
        `Your account is not linked. You can:\n` +
        `• Sign in with Discord at Lion Reader (recommended)\n` +
        `• Use \`/link\` with an API token from Settings > API Tokens`,
      ephemeral: true,
    });
  }
}

// ============================================================================
// Reaction Handler
// ============================================================================

async function handleSaveReaction(
  partialMessage: Message | { partial: true; fetch: () => Promise<Message> },
  user: User | PartialUser
): Promise<void> {
  // Look up Lion Reader user
  const resolved = await resolveUser(user.id);
  if (!resolved) {
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
      const saved = await saveArticle(db, resolved.userId, { url });
      logger.info("Saved article via Discord", {
        userId: resolved.userId,
        discordUser: user.tag,
        method: resolved.method,
        url,
        title: saved.title,
      });
      results.push({ success: true, title: saved.title ?? url, url });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to save article via Discord", {
        userId: resolved.userId,
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
