/**
 * Handler for `reconcile_counters` jobs (singleton).
 *
 * See src/server/services/reconcile-counters.ts for the reconciliation itself.
 * Until #1846 phase 7 it also checks the subscription_entries mirror
 * (src/server/services/subscription-entries.ts).
 */

import { db } from "../../db";
import { reconcileCounters } from "../../services/reconcile-counters";
import { checkSubscriptionEntries } from "../../services/subscription-entries";
import type { JobHandlerResult } from "./types";

/**
 * How often the denormalized unread counters are reconciled against ground
 * truth. Daily: the counter triggers should keep them exact, so this is a
 * drift detector (any fix logs at error level) that doubles as self-healing.
 */
const RECONCILE_COUNTERS_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Handler for reconcile_counters jobs (singleton, stateless, runs daily).
 * See src/server/services/reconcile-counters.ts.
 */
export async function handleReconcileCounters(): Promise<JobHandlerResult> {
  const now = new Date();
  const result = await reconcileCounters(db);
  const memberships = await checkSubscriptionEntries(db);

  return {
    success: true,
    nextRunAt: new Date(now.getTime() + RECONCILE_COUNTERS_INTERVAL_MS),
    metadata: { ...result, memberships },
  };
}
