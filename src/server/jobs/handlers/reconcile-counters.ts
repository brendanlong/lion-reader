/**
 * Handler for `reconcile_membership_counters` jobs (fixed-interval singleton).
 *
 * See src/server/services/reconcile-counters.ts for the reconciliation itself.
 */

import { db } from "../../db";
import { countUnheldUserEntries, reconcileCounters } from "../../services/reconcile-counters";
import type { JobMetadata } from "./types";

export async function handleReconcileCounters(): Promise<JobMetadata> {
  const result = await reconcileCounters(db);
  const unheldUserEntries = await countUnheldUserEntries(db);

  return { ...result, unheldUserEntries };
}
