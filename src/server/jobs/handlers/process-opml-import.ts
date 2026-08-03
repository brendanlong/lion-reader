/**
 * Handler for `process_opml_import` jobs.
 *
 * See src/server/services/imports.ts for the import itself.
 */

import { db } from "../../db";
import { processOpmlImport } from "../../services/imports";
import type { JobPayloads } from "../queue";
import type { JobHandlerResult } from "./types";

/**
 * This is a one-time job: whatever the outcome, it must not run again, so it
 * parks itself a year out. The parked row is swept by the retention cleanup
 * (see src/server/services/retention.ts).
 */
const NEVER_AGAIN_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Handler for process_opml_import jobs.
 * Processes an OPML import in the background, publishing progress events
 * as each feed is processed.
 *
 * @param payload - The job payload containing the importId
 * @returns Job handler result
 */
export async function handleProcessOpmlImport(
  payload: JobPayloads["process_opml_import"]
): Promise<JobHandlerResult> {
  const { importId } = payload;

  const result = await processOpmlImport(db, importId);
  const nextRunAt = new Date(Date.now() + NEVER_AGAIN_MS);

  switch (result.status) {
    case "not_found":
      return {
        success: false,
        nextRunAt,
        error: `Import record not found: ${importId}`,
      };

    case "already_finished":
      return { success: true, nextRunAt };

    case "completed":
      return {
        success: true,
        nextRunAt,
        metadata: {
          ...(result.recovered ? { recovered: true } : {}),
          ...result.counts,
        },
      };

    case "failed":
      return { success: false, nextRunAt, error: result.error };

    default:
      return result satisfies never;
  }
}
