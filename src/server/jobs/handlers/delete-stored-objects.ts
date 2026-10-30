/**
 * Handler for `delete_stored_objects` jobs.
 *
 * See src/server/services/stored-objects.ts for the deletion itself.
 */

import { deleteStoredObjects } from "../../services/stored-objects";
import type { JobPayloads } from "../queue";
import type { OneTimeJobHandlerResult } from "./types";

export async function handleDeleteStoredObjects(
  payload: JobPayloads["delete_stored_objects"]
): Promise<OneTimeJobHandlerResult> {
  const deleted = await deleteStoredObjects(payload.prefixes);
  return { success: true, metadata: { prefixes: payload.prefixes.length, deleted } };
}
