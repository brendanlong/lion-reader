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
 */

import { startDiscordBot } from "../src/server/discord";
import { startMetricsServer } from "../src/server/metrics/server";
import { notifyWorkerStarted } from "../src/server/notifications/discord-webhook";
import { logger } from "../src/lib/logger";

logger.info("Starting Discord bot", {
  pid: process.pid,
  saveEmoji: process.env.DISCORD_SAVE_EMOJI || "🦁",
});

// Start internal metrics server on port 9093 (separate from Next.js/worker)
startMetricsServer(9093);

// Notify about discord bot start (helps detect crash loops)
notifyWorkerStarted({ processType: "discord" }).catch((error) => {
  // Don't let notification failures prevent bot from starting
  logger.warn("Failed to send discord bot start notification", { error });
});

// Handle graceful shutdown
process.on("SIGINT", () => {
  logger.info("Received SIGINT, shutting down Discord bot...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM, shutting down Discord bot...");
  process.exit(0);
});

startDiscordBot()
  .then(() => {
    logger.info("Discord bot started successfully");
  })
  .catch((error) => {
    logger.error("Failed to start Discord bot", { error });
    process.exit(1);
  });
