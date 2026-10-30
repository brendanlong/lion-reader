/**
 * Handler for `renew_websub` jobs (fixed-interval singleton).
 *
 * See src/server/feed/websub.ts for the WebSub protocol details.
 */

import { renewExpiringSubscriptions } from "../../feed/websub";
import { trackWebsubRenewal } from "../../metrics/metrics";
import { logger } from "@/lib/logger";
import { getJobIntervalMs } from "../queue";
import type { JobMetadata } from "./types";

const HOUR_MS = 60 * 60 * 1000;

/**
 * How far ahead of expiry we renew: two runs, so every lease is renewed on the
 * run before it would expire, while long leases are left untouched until near
 * their own expiry (no per-run re-subscribe spam).
 */
const WEBSUB_RENEWAL_THRESHOLD_HOURS = (2 * getJobIntervalMs("renew_websub")) / HOUR_MS;

/** Renews active WebSub subscriptions expiring within WEBSUB_RENEWAL_THRESHOLD_HOURS. */
export async function handleRenewWebsub(): Promise<JobMetadata> {
  logger.info("Starting WebSub subscription renewal check");

  const result = await renewExpiringSubscriptions(WEBSUB_RENEWAL_THRESHOLD_HOURS);

  for (let i = 0; i < result.renewed + result.failed; i++) {
    trackWebsubRenewal(i < result.renewed);
  }

  if (result.failed > 0) {
    logger.warn("Some WebSub renewals failed", {
      errors: result.errors,
    });
  }

  return {
    checked: result.checked,
    deactivated: result.deactivated,
    renewed: result.renewed,
    failed: result.failed,
    errors: result.errors.length > 0 ? result.errors : undefined,
  };
}
