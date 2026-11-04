/**
 * Server-side check of a Cloudflare Turnstile token from the signup form.
 */

import { z } from "zod";

import { readTurnstileKeys } from "@/server/config/env";
import { errors } from "@/server/errors";
import { USER_AGENT } from "@/server/http/user-agent";
import { TURNSTILE_ORIGIN } from "@/lib/turnstile";

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
  const response = await fetch(`${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body,
  });
  if (!response.ok) {
    throw new Error(`Turnstile siteverify failed: ${response.status}`);
  }
  const result = siteverifyResponseSchema.parse(await response.json());
  if (!result.success) {
    throw errors.validation("The CAPTCHA check failed. Please try again.");
  }
}
