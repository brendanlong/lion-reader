/**
 * Handler for `process_opml_import` jobs.
 *
 * See src/server/services/imports.ts for the import itself.
 */

import { db } from "../../db";
import { processOpmlImport } from "../../services/imports";
import { ONE_TIME_JOB_PARK_MS, type JobPayloads } from "../queue";
import type { JobHandlerResult } from "./types";

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
  // A one-time job: park it whatever the outcome (see ONE_TIME_JOB_TYPES).
  const nextRunAt = new Date(Date.now() + ONE_TIME_JOB_PARK_MS);

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
