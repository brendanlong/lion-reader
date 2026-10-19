/**
 * Discord bot process.
 *
 * This script runs the Discord bot that allows users to save articles
 * by reacting to messages with a configured emoji.
 *
 * Usage:
 *   pnpm discord-bot
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN - Bot token from Discord Developer Portal
 *   DISCORD_CLIENT_ID - Application client ID (same as OAuth)
 *   DISCORD_SAVE_EMOJI - Emoji to trigger saving (default: 🦁)
 *   DISCORD_BOT_HEARTBEAT_URL - Optional healthchecks.io check pinged while the
 *     bot is running; the monitor alerts if pings stop (dead/crash-looping bot)
 */

import { startDiscordBot } from "../src/server/discord/bot";
import { DISCORD_SAVE_EMOJI } from "../src/server/discord/config";
import { runProcess } from "../src/server/process";

runProcess({
  name: "Discord bot",
  metricsPort: 9093,
  details: { saveEmoji: DISCORD_SAVE_EMOJI },
  heartbeat: { url: process.env.DISCORD_BOT_HEARTBEAT_URL, intervalMs: 5 * 60 * 1000 },
  start: startDiscordBot,
});
