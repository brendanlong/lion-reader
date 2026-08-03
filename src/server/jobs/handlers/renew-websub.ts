/**
 * Handler for `renew_websub` jobs (singleton).
 *
 * See src/server/feed/websub.ts for the WebSub protocol details.
 */

import { renewExpiringSubscriptions } from "../../feed/websub";
import { trackWebsubRenewal } from "../../metrics/metrics";
import type { JobPayloads } from "../queue";
import { logger } from "@/lib/logger";
import type { JobHandlerResult } from "./types";

/**
 * How often the WebSub renewal job runs.
 *
 * This must be short relative to the shortest lease we want to keep alive: a
 * lease can only be renewed on a run that falls within its renewal window, so a
 * daily cadence silently lets sub-24h leases lapse until the next run. Running
 * hourly keeps any lease down to ~1h alive.
 */
const WEBSUB_RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * How far ahead of expiry we renew, in hours.
 *
 * Kept just above the run interval so every lease is renewed on the run before
 * it would expire, while long leases are left untouched until near their own
 * expiry (no per-run re-subscribe spam).
 */
const WEBSUB_RENEWAL_THRESHOLD_HOURS = 2;

/**
 * Handler for renew_websub jobs.
 * Renews WebSub subscriptions that are expiring soon.
 *
 * Runs hourly (see WEBSUB_RENEWAL_INTERVAL_MS) and renews active subscriptions
 * expiring within WEBSUB_RENEWAL_THRESHOLD_HOURS. The frequent cadence + short
 * threshold keeps short leases alive without re-subscribing long leases every
 * run.
 *
 * @param _payload - The job payload (empty for this job type)
 * @returns Job handler result with next run time
 */
export async function handleRenewWebsub(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["renew_websub"]
): Promise<JobHandlerResult> {
  logger.info("Starting WebSub subscription renewal check");

  const result = await renewExpiringSubscriptions(WEBSUB_RENEWAL_THRESHOLD_HOURS);

  // Track renewal metrics
  for (let i = 0; i < result.renewed; i++) {
    trackWebsubRenewal(true);
  }
  for (let i = 0; i < result.failed; i++) {
    trackWebsubRenewal(false);
  }

  if (result.failed > 0) {
    logger.warn("Some WebSub renewals failed", {
      errors: result.errors,
    });
  }

  // Schedule the next check one interval out.
  const nextRunAt = new Date(Date.now() + WEBSUB_RENEWAL_INTERVAL_MS);

  logger.debug("Scheduled next WebSub renewal check", {
    scheduledFor: nextRunAt.toISOString(),
  });

  return {
    success: true,
    nextRunAt,
    metadata: {
      checked: result.checked,
      renewed: result.renewed,
      failed: result.failed,
      errors: result.errors.length > 0 ? result.errors : undefined,
    },
  };
}
