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
import {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_SAVE_EMOJI,
  DISCORD_SUCCESS_EMOJI,
  DISCORD_ERROR_EMOJI,
} from "./config";

// Redis key prefix for storing Discord user -> API token mappings
const REDIS_KEY_PREFIX = "discord:token:";

// How long after login() to wait for the gateway `clientReady` event before
// warning that the bot connected but isn't receiving events.
const READY_WATCHDOG_MS = 30 * 1000;

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
  if (!DISCORD_BOT_TOKEN) {
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
    // User partial: guild reaction payloads carry the full member, but DM
    // reactions from uncached users are silently dropped without it.
    partials: [Partials.Message, Partials.Reaction, Partials.User],
  });

  // Gateway diagnostics. `client.login()` resolves as soon as the token
  // handshake starts, long before the gateway is actually connected, so a bot
  // that authenticates but never reaches `clientReady` would silently receive
  // zero reaction events while still logging "started successfully". These
  // handlers make that failure mode visible instead of invisible.
  client.on("error", (error) => {
    logger.error("Discord client error", { error });
  });
  client.on("shardError", (error, shardId) => {
    logger.error("Discord gateway shard error", { error, shardId });
  });
  client.on("shardDisconnect", (event, shardId) => {
    // Only fires on unrecoverable close codes (recoverable drops go to
    // shardReconnecting instead), so this is always serious. The close code
    // explains why: 4014 = disallowed (privileged) intents, 4004 = auth failed,
    // etc. (event.reason is a deprecated placeholder in discord.js v14 — the
    // code is the real signal.)
    logger.warn("Discord gateway shard disconnected", {
      shardId,
      code: event.code,
    });
  });
  client.on("shardReconnecting", (shardId) => {
    logger.info("Discord gateway shard reconnecting", { shardId });
  });
  client.on("invalidated", () => {
    logger.error("Discord session invalidated (bot will stop receiving events)");
  });
  client.on("warn", (message) => {
    logger.warn("Discord client warning", { message });
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
    if (emoji !== DISCORD_SAVE_EMOJI) {
      // Users can't react with application emojis (they're only usable by the
      // bot itself), so the save trigger must be a server emoji whose name
      // matches DISCORD_SAVE_EMOJI exactly. Log mismatches so a wrong or
      // renamed server emoji is diagnosable instead of silently ignored.
      logger.info("Ignoring reaction with non-save emoji", {
        emoji,
        emojiId: reaction.emoji.id,
        expected: DISCORD_SAVE_EMOJI,
        userId: user.id,
      });
      return;
    }

    logger.info("Save reaction received", {
      userId: user.id,
      messageId: reaction.message.id,
    });

    await handleSaveReaction(reaction.message, user);
  });

  // Watchdog: `client.login()` below resolves on token handshake, not on a live
  // gateway. If `clientReady` hasn't fired within this window the bot is logged
  // in but not receiving events (stuck handshake, network, disallowed intents),
  // so log loudly rather than sitting silently "started successfully".
  const readyWatchdog = setTimeout(() => {
    logger.error("Discord gateway not ready after login", {
      timeoutMs: READY_WATCHDOG_MS,
      hint: "client.login() resolved but clientReady never fired; check gateway connectivity and privileged intents",
    });
  }, READY_WATCHDOG_MS);

  client.once("clientReady", async () => {
    clearTimeout(readyWatchdog);

    // Fetch application emojis to populate the cache
    if (client?.application) {
      try {
        await client.application.emojis.fetch();
        logger.info("Fetched application emojis", {
          count: client.application.emojis.cache.size,
        });
      } catch (error) {
        logger.warn("Failed to fetch application emojis", { error });
      }
    }

    logger.info("Discord bot started", {
      tag: client?.user?.tag,
      saveEmoji: DISCORD_SAVE_EMOJI,
    });
  });

  try {
    await client.login(DISCORD_BOT_TOKEN);
  } catch (error) {
    // login() rejected (bad token, network) — clear the watchdog so it can't
    // later fire the misleading "resolved but clientReady never fired" message.
    clearTimeout(readyWatchdog);
    throw error;
  }
}

async function registerCommands(): Promise<void> {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) return;

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

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

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
      `React to any message containing a URL with ${DISCORD_SAVE_EMOJI} to save it.`,
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
      content: `Your account is linked via ${methodText}. React to messages with ${DISCORD_SAVE_EMOJI} to save articles.`,
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
    logger.info("Ignoring save reaction from unlinked Discord user", { discordId: user.id });
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
  if (urls.length === 0) {
    logger.info("Save reaction message contained no URLs", {
      messageId: message.id,
      contentLength: message.content?.length ?? 0,
    });
    return;
  }

  // Save each URL
  let hasSuccess = false;
  let hasFailure = false;

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
      hasSuccess = true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to save article via Discord", {
        userId: resolved.userId,
        discordUser: user.tag,
        url,
        error: errorMessage,
      });
      hasFailure = true;
    }
  }

  // React with success/error emoji
  await addResultReaction(message, hasSuccess, hasFailure);
}

/**
 * Find an emoji by name, checking application emojis first, then guild emojis.
 * Application emojis are custom emojis uploaded to the Discord bot itself,
 * which can be used anywhere the bot can send messages.
 */
function findEmoji(message: Message, emojiName: string): string | null {
  // First, check application emojis (custom emojis on the bot itself)
  if (client?.application) {
    const appEmoji = client.application.emojis.cache.find((e) => e.name === emojiName);
    if (appEmoji) {
      return appEmoji.id;
    }
  }

  // Fall back to guild emojis
  if (!message.guild) return null;
  const guildEmoji = message.guild.emojis.cache.find((e) => e.name === emojiName);
  return guildEmoji ? guildEmoji.id : null;
}

/**
 * React to a message with the appropriate emoji based on save results.
 * Uses success emoji if any URLs saved successfully, error emoji if any failed.
 */
async function addResultReaction(
  message: Message,
  hasSuccess: boolean,
  hasFailure: boolean
): Promise<void> {
  // React with success emoji if anything succeeded
  if (hasSuccess) {
    try {
      // Check if it's a custom emoji (alphanumeric) or unicode
      const isCustom = /^[a-zA-Z0-9_]+$/.test(DISCORD_SUCCESS_EMOJI);
      if (isCustom) {
        const emojiId = findEmoji(message, DISCORD_SUCCESS_EMOJI);
        if (emojiId) {
          await message.react(emojiId);
        } else {
          // Custom emoji not found in app or guild
          logger.warn("Success emoji not found", {
            emoji: DISCORD_SUCCESS_EMOJI,
            guildId: message.guild?.id,
          });
        }
      } else {
        await message.react(DISCORD_SUCCESS_EMOJI);
      }
    } catch (error) {
      logger.warn("Failed to add success reaction", { error });
    }
  }

  // React with error emoji if anything failed
  if (hasFailure) {
    try {
      const isCustom = /^[a-zA-Z0-9_]+$/.test(DISCORD_ERROR_EMOJI);
      if (isCustom) {
        const emojiId = findEmoji(message, DISCORD_ERROR_EMOJI);
        if (emojiId) {
          await message.react(emojiId);
        } else {
          logger.warn("Error emoji not found", {
            emoji: DISCORD_ERROR_EMOJI,
            guildId: message.guild?.id,
          });
        }
      } else {
        await message.react(DISCORD_ERROR_EMOJI);
      }
    } catch (error) {
      logger.warn("Failed to add error reaction", { error });
    }
  }
}
