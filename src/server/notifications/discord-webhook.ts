/**
 * Discord Webhook Notifications
 *
 * Sends alerts to a Discord channel via webhook for critical system events.
 * This is separate from the Discord bot - webhooks are fire-and-forget HTTP requests.
 *
 * To set up:
 * 1. Create a webhook in Discord: Server Settings -> Integrations -> Webhooks
 * 2. Copy the webhook URL
 * 3. Set DISCORD_ALERT_WEBHOOK_URL environment variable
 */

import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";

const WEBHOOK_URL = process.env.DISCORD_ALERT_WEBHOOK_URL;

interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  timestamp?: string;
}

interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Color codes for Discord embeds
 */
const COLORS = {
  info: 0x3498db, // Blue
  warning: 0xf39c12, // Orange
  error: 0xe74c3c, // Red
  success: 0x2ecc71, // Green
};

/**
 * Sends a message to the configured Discord webhook.
 * Fails silently if webhook is not configured or request fails.
 */
async function sendWebhook(payload: DiscordWebhookPayload): Promise<void> {
  if (!WEBHOOK_URL) {
    return;
  }

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.warn("Discord webhook failed", {
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (error) {
    // Don't let webhook failures affect the main process
    logger.warn("Discord webhook error", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Sends an alert about a worker restart.
 * Called at worker startup to notify about potential crash loops.
 */
export async function notifyWorkerStarted(context: {
  processType: "worker" | "discord";
  reason?: string;
}): Promise<void> {
  const hostname = process.env.FLY_MACHINE_ID || process.env.HOSTNAME || "unknown";
  const region = process.env.FLY_REGION || "unknown";

  await sendWebhook({
    username: "Lion Reader Alerts",
    embeds: [
      {
        title: `🔄 ${context.processType === "worker" ? "Worker" : "Discord Bot"} Started`,
        description: context.reason || "Process started (may be a restart after crash)",
        color: COLORS.warning,
        fields: [
          { name: "Machine", value: hostname, inline: true },
          { name: "Region", value: region, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });
}
