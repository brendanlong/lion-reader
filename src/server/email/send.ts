/**
 * Outbound email through Mailgun's messages API. Plain text only, so nothing
 * we send can carry markup.
 */

import { outboundEmailConfig } from "@/server/config/env";
import { USER_AGENT } from "@/server/http/user-agent";
import { logger } from "@/lib/logger";

const MAILGUN_TIMEOUT_MS = 10_000;

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends `email`. Without Mailgun configured it throws in production and logs
 * the email elsewhere, so a dev server's verification links stay usable.
 */
export async function sendEmail(email: OutgoingEmail): Promise<void> {
  const domain = outboundEmailConfig.mailgunDomain;
  const key = outboundEmailConfig.mailgunSendingKey;
  if (!domain || !key) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Outbound email is not configured (MAILGUN_DOMAIN, MAILGUN_SENDING_KEY)");
    }
    logger.info("Outbound email not configured; not sending", { ...email });
    return;
  }

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${key}`).toString("base64")}`,
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      from: `Lion Reader <noreply@${domain}>`,
      to: email.to,
      subject: email.subject,
      text: email.text,
    }),
    signal: AbortSignal.timeout(MAILGUN_TIMEOUT_MS),
  });
  if (!response.ok) {
    logger.error("Mailgun rejected an email", {
      status: response.status,
      body: await response.text(),
    });
    throw new Error("We couldn't send the email. Please try again later.");
  }
}
