/**
 * Handler for `delete_full_content_archives` jobs.
 *
 * See src/server/services/full-content-archive.ts for the deletion itself.
 */

import { deleteFullContentArchives } from "../../services/full-content-archive";
import type { JobPayloads } from "../queue";
import type { OneTimeJobHandlerResult } from "./types";

export async function handleDeleteFullContentArchives(
  payload: JobPayloads["delete_full_content_archives"]
): Promise<OneTimeJobHandlerResult> {
  const deleted = await deleteFullContentArchives(payload.entryIds);
  return { success: true, metadata: { entries: payload.entryIds.length, deleted } };
}
