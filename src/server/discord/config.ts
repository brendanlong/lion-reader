/**
 * Discord Bot Configuration
 *
 * Shared configuration for the Discord bot, used by both the bot itself
 * and the API endpoint that exposes bot settings to the frontend.
 */

// ============================================================================
// Environment Variables
// ============================================================================

export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
export const DISCORD_SAVE_EMOJI = process.env.DISCORD_SAVE_EMOJI || "🦁";
export const DISCORD_SUCCESS_EMOJI = process.env.DISCORD_SUCCESS_EMOJI || "salutinglionreader";
export const DISCORD_ERROR_EMOJI = process.env.DISCORD_ERROR_EMOJI || "😿";

// ============================================================================
// Derived Configuration
// ============================================================================

/**
 * Whether the Discord bot is enabled.
 * Requires both bot token and client ID to be set.
 */
export const DISCORD_BOT_ENABLED = !!(DISCORD_BOT_TOKEN && DISCORD_CLIENT_ID);

/**
 * Bot invite URL with required permissions.
 * Permissions: VIEW_CHANNEL (1024) + SEND_MESSAGES (2048) + ADD_REACTIONS (64)
 *            + READ_MESSAGE_HISTORY (65536) + USE_EXTERNAL_EMOJIS (262144) = 330816
 */
export const DISCORD_BOT_INVITE_URL = DISCORD_BOT_ENABLED
  ? `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=330816&integration_type=0&scope=bot+applications.commands`
  : null;
