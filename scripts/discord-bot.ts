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

import * as Sentry from "@sentry/nextjs";
import { startDiscordBot } from "../src/server/discord/bot";
import { startMetricsServer } from "../src/server/metrics/server";
import { startHeartbeat } from "../src/server/notifications/healthchecks";
import { initSentry } from "../src/server/sentry";
import { logger } from "../src/lib/logger";

// Initialize Sentry before any work starts. Next.js instrumentation only runs
// in the app server, so this process must init explicitly (this also installs
// Sentry's global uncaught-exception / unhandled-rejection handlers).
initSentry();

/** How often to ping the liveness heartbeat while the bot is running. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

const heartbeatUrl = process.env.DISCORD_BOT_HEARTBEAT_URL;
let stopHeartbeat: (() => void) | undefined;

logger.info("Starting Discord bot", {
  pid: process.pid,
  saveEmoji: process.env.DISCORD_SAVE_EMOJI || "🦁",
});

// Start internal metrics server on port 9093 (separate from Next.js/worker)
startMetricsServer(9093);

// Handle graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down Discord bot...`);
  stopHeartbeat?.();
  // Flush buffered Sentry events before exiting (no-op if never initialized).
  await Sentry.close(2000);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startDiscordBot()
  .then(() => {
    logger.info("Discord bot started successfully");

    // Start the liveness heartbeat only after the bot connects, so a bot that
    // fails to start doesn't report itself alive. healthchecks.io alerts if
    // these pings stop, which catches a dead or crash-looping bot process.
    if (heartbeatUrl) {
      const region = process.env.FLY_REGION || "unknown";
      const machine = process.env.FLY_MACHINE_ID || process.env.HOSTNAME || "unknown";
      const body = `discord-bot alive (machine=${machine} region=${region} pid=${process.pid})`;
      stopHeartbeat = startHeartbeat(heartbeatUrl, HEARTBEAT_INTERVAL_MS, () => ({ body }));
    }
  })
  .catch((error) => {
    logger.error("Failed to start Discord bot", { error });
    process.exit(1);
  });
