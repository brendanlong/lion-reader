/**
 * Handler for `cleanup` jobs (fixed-interval singleton).
 *
 * See src/server/services/retention.ts for what gets deleted.
 */

import { db } from "../../db";
import { runRetentionCleanup } from "../../services/retention";
import { logger } from "@/lib/logger";
import type { JobMetadata } from "./types";

/**
 * Deletes rows that expire but were never deleted anywhere (issue #953):
 * expired sessions, expired OAuth authorization codes / access tokens /
 * refresh tokens, long-revoked credentials, orphaned Dynamic Client
 * Registration clients (issue #975), and
 * subscriber-less fetch_feed jobs (issue #1085). See
 * src/server/services/retention.ts.
 */
export async function handleCleanup(): Promise<JobMetadata> {
  const deleted = await runRetentionCleanup(db);

  logger.info("Retention cleanup completed", { ...deleted });

  return { ...deleted };
}
