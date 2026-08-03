/**
 * Handler for `cleanup` jobs (singleton).
 *
 * See src/server/services/retention.ts for what gets deleted.
 */

import { db } from "../../db";
import { runRetentionCleanup } from "../../services/retention";
import type { JobPayloads } from "../queue";
import { logger } from "@/lib/logger";
import type { JobHandlerResult } from "./types";

/** How often the retention cleanup runs. */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Handler for cleanup jobs (singleton, runs daily).
 *
 * Deletes rows that expire but were never deleted anywhere (issue #953):
 * expired sessions, expired OAuth authorization codes / access tokens /
 * refresh tokens, long-revoked credentials, orphaned Dynamic Client
 * Registration clients (issue #975), parked one-time process_opml_import
 * jobs, and subscriber-less fetch_feed jobs (issue #1085). See
 * src/server/services/retention.ts.
 */
export async function handleCleanup(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["cleanup"]
): Promise<JobHandlerResult> {
  const now = new Date();
  const deleted = await runRetentionCleanup(db);

  logger.info("Retention cleanup completed", { ...deleted });

  return {
    success: true,
    nextRunAt: new Date(now.getTime() + CLEANUP_INTERVAL_MS),
    metadata: { ...deleted },
  };
}
