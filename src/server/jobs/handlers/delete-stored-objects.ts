/**
 * Handler for `delete_stored_objects` jobs.
 *
 * See src/server/services/stored-objects.ts. A failure throws, so the worker
 * retries it with backoff.
 */

import { deleteStoredObjects } from "../../services/stored-objects";
import type { JobPayloads } from "../queue";
import type { OneTimeJobHandlerResult } from "./types";

export async function handleDeleteStoredObjects(
  payload: JobPayloads["delete_stored_objects"]
): Promise<OneTimeJobHandlerResult> {
  const deleted = await deleteStoredObjects(payload.prefix);
  return { success: true, metadata: { prefix: payload.prefix, deleted } };
}
