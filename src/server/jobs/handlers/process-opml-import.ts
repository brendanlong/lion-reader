/**
 * Handler for `process_opml_import` jobs.
 *
 * See src/server/services/imports.ts for the import itself.
 */

import { db } from "../../db";
import { processOpmlImport } from "../../services/imports";
import type { JobPayloads } from "../queue";
import type { OneTimeJobHandlerResult } from "./types";

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
): Promise<OneTimeJobHandlerResult> {
  const { importId } = payload;

  const result = await processOpmlImport(db, importId);

  switch (result.status) {
    case "not_found":
      return {
        success: false,
        error: `Import record not found: ${importId}`,
      };

    case "already_finished":
      return { success: true };

    case "completed":
      return {
        success: true,
        metadata: {
          ...(result.recovered ? { recovered: true } : {}),
          ...result.counts,
        },
      };

    case "failed":
      return { success: false, error: result.error };

    default:
      return result satisfies never;
  }
}
