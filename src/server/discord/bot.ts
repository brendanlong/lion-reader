/**
 * Discord Bot for Lion Reader
 *
 * Saves articles when users:
 * - React to a message with the configured save emoji, or
 * - Send/forward a message containing a URL directly to the bot in a DM.
 *
 * Either way the bot reacts to the message with the success/error emoji.
 *
 * Users can link their account either by:
 * 1. Signing in with Discord on the web app (OAuth)
 * 2. Using /link with an API token
 */

import * as Sentry from "@sentry/nextjs";
import {
  Client,
  GatewayDispatchEvents,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GatewayMessageCreateDispatchData,
  type Message,
  type User,
  type PartialUser,
} from "discord.js";
import { eq, and } from "drizzle-orm";
import { db } from "@/server/db";
import { oauthAccounts } from "@/server/db/schema";
import { saveArticle } from "@/server/services/saved";
import { validateApiToken, SAVE_ARTICLE_SCOPES } from "@/server/auth/api-token";
import {
  linkDiscordApiToken,
  resolveDiscordApiTokenUserId,
  unlinkDiscordApiToken,
} from "@/server/services/discord-links";
import { getMaintenance } from "@/server/services/site-status";
import { logger } from "@/lib/logger";
import {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_SAVE_EMOJI,
  DISCORD_SUCCESS_EMOJI,
  DISCORD_ERROR_EMOJI,
} from "./config";

/** Shown to users when the bot is paused for maintenance. */
const MAINTENANCE_REPLY =
  "🛠️ Lion Reader is temporarily down for maintenance — please try again shortly.";

/**
 * Whether maintenance mode is active. Every DB-touching handler consults this
 * before doing any work, so during a database migration the bot stays connected
 * but does nothing that would hit Postgres. The read is cached in-process, so
 * this adds no per-event Redis load.
 */
async function isUnderMaintenance(): Promise<boolean> {
  return (await getMaintenance()).enabled;
}

// How long after login() to wait for the gateway `clientReady` event before
// warning that the bot connected but isn't receiving events.
const READY_WATCHDOG_MS = 30 * 1000;

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

/**
 * Gather all text that might contain URLs from a message, including the content
 * of any forwarded messages (Discord delivers a forward's text in
 * `messageSnapshots`, not `message.content`).
 */
function gatherMessageText(message: Message): string {
  const parts: string[] = [];
  if (message.content) parts.push(message.content);
  for (const snapshot of message.messageSnapshots.values()) {
    if (snapshot.content) parts.push(snapshot.content);
  }
  // Embeds (e.g. link previews on a forwarded post) can carry the canonical URL.
  for (const embed of message.embeds) {
    if (embed.url) parts.push(embed.url);
  }
  for (const snapshot of message.messageSnapshots.values()) {
    for (const embed of snapshot.embeds) {
      if (embed.url) parts.push(embed.url);
    }
  }
  return parts.join("\n");
}

function extractUrls(content: string): string[] {
  if (!content) return [];

  const matches = content.match(URL_REGEX) || [];

  const urls = matches
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

  // Dedupe: the same URL commonly appears in both the message text and its
  // embed/forward snapshot, and we don't want to save it twice.
  return [...new Set(urls)];
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
 * Tries OAuth first, then falls back to a durable Postgres API-token link.
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

  // Fall back to the API-token link (Postgres). A revoked/expired token
  // resolves to null, exactly as an unlinked user would.
  const userId = await resolveDiscordApiTokenUserId(db, discordId);
  if (userId) {
    return { userId, method: "token" };
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
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    // User partial: guild reaction payloads carry the full member, but DM
    // reactions from uncached users are silently dropped without it.
    // Channel partial: DM channels aren't cached, so messageCreate/reaction
    // events for DMs are dropped without it.
    partials: [Partials.Message, Partials.Reaction, Partials.User, Partials.Channel],
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

  // Handle slash commands.
  // A rejection from an async event listener is an unhandled promise rejection,
  // which kills the whole process (Sentry's global handler captures then exits)
  // — so one failed reply or DB hiccup must not take the bot down.
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;

    try {
      if (await isUnderMaintenance()) {
        await interaction.reply({ content: MAINTENANCE_REPLY, flags: MessageFlags.Ephemeral });
        return;
      }
      if (commandName === "link") {
        await handleLinkCommand(interaction, user);
      } else if (commandName === "unlink") {
        await handleUnlinkCommand(interaction, user);
      } else if (commandName === "status") {
        await handleStatusCommand(interaction, user);
      }
    } catch (error) {
      // logger.error only adds a Sentry breadcrumb; capture explicitly so the
      // error still becomes a Sentry event now that it no longer crashes the
      // process (where the global handler used to report it).
      Sentry.captureException(error);
      logger.error("Discord command handler failed", { commandName, error });
    }
  });

  // Handle reactions
  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    // Users can't react with application emojis (they're only usable by the
    // bot itself), so the save trigger must be a server emoji whose name
    // matches DISCORD_SAVE_EMOJI exactly.
    const emoji = reaction.emoji.name;
    if (emoji !== DISCORD_SAVE_EMOJI) return;

    logger.info("Save reaction received", {
      userId: user.id,
      messageId: reaction.message.id,
    });

    try {
      await handleSaveReaction(reaction.message, user);
    } catch (error) {
      // Same rationale as interactionCreate: a rejection here (e.g. the
      // resolveUser DB lookup) would otherwise crash the whole bot process.
      Sentry.captureException(error);
      logger.error("Discord save-reaction handler failed", {
        messageId: reaction.message.id,
        error,
      });
    }
  });

  // Handle direct messages: a URL sent (or forwarded) to the bot in a DM is
  // saved just like a save-emoji reaction, and the DM is reacted to the same way.
  client.on("messageCreate", async (message) => {
    if (message.author?.bot) return;
    // Only DMs — guild messages are handled via the save-emoji reaction, not by
    // treating every posted link as a save.
    if (message.guildId) return;

    try {
      await handleDirectMessage(message);
    } catch (error) {
      // Same rationale as interactionCreate: a rejection here would otherwise
      // crash the whole bot process.
      Sentry.captureException(error);
      logger.error("Discord direct-message handler failed", {
        messageId: message.id,
        error,
      });
    }
  });

  // Recover DMs whose channel isn't cached yet.
  //
  // discord.js can't build a DM channel object from a raw MESSAGE_CREATE payload
  // (it lacks the channel type/recipients needed to disambiguate a DM from a
  // group DM), so if the DM channel isn't already in its cache it silently drops
  // the `messageCreate` event entirely — even with the Channel partial enabled.
  // In practice this means the *first* DM in a channel after the bot restarts
  // (before the user has run any slash command, which would cache the channel)
  // never reaches the handler above. See the createChannel path in discord.js.
  //
  // The raw gateway dispatch fires regardless, so we use it as a fallback: for a
  // DM whose channel isn't cached, fetch the channel (which caches it) and the
  // message, then run the same handler. A cached channel means `messageCreate`
  // already handled it, so we skip — this only pays the fetch cost on the cold
  // first hit, and every later DM flows through the normal path above.
  const dmRecoveryClient = client;
  dmRecoveryClient.ws.on(
    GatewayDispatchEvents.MessageCreate,
    (data: GatewayMessageCreateDispatchData) => {
      if (data.guild_id) return; // DMs only
      if (data.author?.bot) return;
      // Cached channel → the normal messageCreate path handled it. This check
      // runs before discord.js processes the packet (raw dispatch fires first),
      // and an uncached DM channel is never cached by that failed processing, so
      // a cache miss here reliably means messageCreate was (or will be) dropped.
      if (dmRecoveryClient.channels.cache.has(data.channel_id)) return;

      void recoverUncachedDirectMessage(dmRecoveryClient, data);
    }
  );

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
      // Diagnostic: the gateway intents actually negotiated by the running
      // process. Confirms whether DirectMessages (required to receive DM
      // messageCreate) is active in the deployed build.
      intents: client?.options.intents.toArray(),
      partials: client?.options.partials?.map((p) => Partials[p]),
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The bot only ever saves articles, and it does so via the saveArticle service
  // (which bypasses the tRPC scope middleware), so gate `/link` on the same scope
  // set `saved.save` requires. Token scopes are immutable, so a link-time check
  // is sufficient — a linked token can always save. Reject anything else here
  // rather than silently accepting a token that can never do anything useful.
  const canSave = SAVE_ARTICLE_SCOPES.some((scope) => tokenData.token.scopes.includes(scope));
  if (!canSave) {
    await interaction.reply({
      content:
        "That API token doesn't have permission to save articles.\n\n" +
        "Create a token with the 'Save articles' scope: Lion Reader → Settings → API Tokens.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Store a durable reference to the token row (not the raw token).
  await linkDiscordApiToken(db, user.id, tokenData.token.id);

  await interaction.reply({
    content:
      `Your Lion Reader account is now linked via API token. ` +
      `React to any message containing a URL with ${DISCORD_SAVE_EMOJI}, ` +
      `or send/forward a link to me in a DM, to save it.`,
    flags: MessageFlags.Ephemeral,
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
  const hadToken = await unlinkDiscordApiToken(db, user.id);

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
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content: hasOAuth
        ? "You don't have an API token linked, but you're connected via Discord OAuth."
        : "You don't have an API token linked. Use `/link` to connect, or sign in with Discord on the Lion Reader website.",
      flags: MessageFlags.Ephemeral,
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
      content: `Your account is linked via ${methodText}. React to messages with ${DISCORD_SAVE_EMOJI}, or send/forward a link to me in a DM, to save articles.`,
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.reply({
      content:
        `Your account is not linked. You can:\n` +
        `• Sign in with Discord at Lion Reader (recommended)\n` +
        `• Use \`/link\` with an API token from Settings > API Tokens`,
      flags: MessageFlags.Ephemeral,
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
  // Paused for maintenance — don't touch the database. Reactions are a
  // low-signal surface, so skip silently rather than DMing the user.
  if (await isUnderMaintenance()) {
    logger.info("Ignoring save reaction: maintenance mode active", { discordId: user.id });
    return;
  }

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
  const urls = extractUrls(gatherMessageText(message));
  if (urls.length === 0) {
    logger.info("Save reaction message contained no URLs", {
      messageId: message.id,
      contentLength: message.content?.length ?? 0,
    });
    return;
  }

  await saveUrlsAndReact(message, urls, resolved, user);
}

/**
 * Handle a direct message to the bot: save any URLs it contains (or that were
 * forwarded to the bot) and react to the DM the same way as a save reaction.
 */
async function handleDirectMessage(message: Message): Promise<void> {
  const urls = extractUrls(gatherMessageText(message));
  if (urls.length === 0) {
    // No URL to save — stay silent rather than replying to every chit-chat DM.
    logger.info("Direct message contained no URLs", {
      messageId: message.id,
      contentLength: message.content?.length ?? 0,
    });
    return;
  }

  // Paused for maintenance — they sent a link, so tell them to retry instead of
  // touching the database.
  if (await isUnderMaintenance()) {
    logger.info("Ignoring direct message: maintenance mode active", {
      discordId: message.author.id,
    });
    try {
      await message.reply(MAINTENANCE_REPLY);
    } catch (error) {
      logger.warn("Failed to reply to DM during maintenance", { error });
    }
    return;
  }

  // Look up Lion Reader user
  const resolved = await resolveUser(message.author.id);
  if (!resolved) {
    logger.info("Ignoring direct message from unlinked Discord user", {
      discordId: message.author.id,
    });
    // They sent a link but we can't save it — tell them how to link, rather
    // than staying silent.
    try {
      await message.reply(
        "Your Discord account isn't linked to Lion Reader yet. " +
          "Sign in with Discord on the Lion Reader website, or use `/link` with an API token."
      );
    } catch (error) {
      logger.warn("Failed to reply to unlinked DM", { error });
    }
    return;
  }

  await saveUrlsAndReact(message, urls, resolved, message.author);
}

/**
 * Recover a DM that discord.js dropped because its channel wasn't cached (see
 * the `ws.on(MESSAGE_CREATE)` registration for why). Fetches the channel (which
 * caches it, so subsequent DMs use the normal `messageCreate` path) and the
 * message, then runs the normal DM handler.
 */
async function recoverUncachedDirectMessage(
  client: Client,
  data: GatewayMessageCreateDispatchData
): Promise<void> {
  try {
    const channel = await client.channels.fetch(data.channel_id);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(data.id);
    logger.info("Recovered DM from uncached channel via raw gateway event", {
      messageId: message.id,
      channelId: channel.id,
    });
    await handleDirectMessage(message);
  } catch (error) {
    // Mirrors the messageCreate handler: never let a rejection crash the bot.
    Sentry.captureException(error);
    logger.error("Failed to recover uncached direct message", {
      messageId: data.id,
      error,
    });
  }
}

/**
 * Save each URL for the resolved user and react to the message with the
 * success/error emoji based on the results. Shared by the save-reaction and
 * direct-message paths so both surfaces behave identically.
 */
async function saveUrlsAndReact(
  message: Message,
  urls: string[],
  resolved: ResolvedUser,
  user: User | PartialUser
): Promise<void> {
  let hasSuccess = false;
  let hasFailure = false;

  for (const url of urls) {
    try {
      // Discord is a non-interactive surface like Wallabag/MCP: use the user's
      // stored Google credentials for private Google Docs when already
      // linked/granted (the failure just surfaces as the error reaction below).
      const saved = await saveArticle(db, resolved.userId, {
        url,
        googleDocsAuth: "non-interactive",
      });
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
