/**
 * Server-side check of a Cloudflare Turnstile token from the signup form.
 */

import { z } from "zod";

import { readTurnstileKeys } from "@/server/config/env";
import { errors } from "@/server/errors";
import { USER_AGENT } from "@/server/http/user-agent";
import { TURNSTILE_ORIGIN } from "@/lib/turnstile";
import { logger } from "@/lib/logger";

const SITEVERIFY_TIMEOUT_MS = 10_000;

const siteverifyResponseSchema = z.object({ success: z.boolean() });

/**
 * Throws unless `token` is a fresh Turnstile pass. Does nothing when Turnstile
 * isn't configured.
 */
export async function verifyCaptcha(
  token: string | undefined,
  remoteIp: string | undefined
): Promise<void> {
  const secret = readTurnstileKeys()?.secretKey;
  if (!secret) {
    return;
  }
  if (!token) {
    throw errors.validation("Please complete the CAPTCHA.");
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }
  let result: z.infer<typeof siteverifyResponseSchema>;
  try {
    const response = await fetch(`${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`siteverify returned ${response.status}`);
    }
    result = siteverifyResponseSchema.parse(await response.json());
  } catch (err) {
    logger.error("Turnstile siteverify failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw errors.internal("We couldn't check the CAPTCHA. Please try again.");
  }
  if (!result.success) {
    throw errors.validation("The CAPTCHA check failed. Please try again.");
  }
}
