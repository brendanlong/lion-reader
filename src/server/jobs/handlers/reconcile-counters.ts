/**
 * Handler for `reconcile_counters` jobs (singleton).
 *
 * See src/server/services/reconcile-counters.ts for the reconciliation itself.
 */

import { db } from "../../db";
import { reconcileCounters } from "../../services/reconcile-counters";
import type { JobPayloads } from "../queue";
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
export async function handleReconcileCounters(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["reconcile_counters"]
): Promise<JobHandlerResult> {
  const now = new Date();
  const result = await reconcileCounters(db);

  return {
    success: true,
    nextRunAt: new Date(now.getTime() + RECONCILE_COUNTERS_INTERVAL_MS),
    metadata: { ...result },
  };
}
