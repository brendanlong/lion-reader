/**
 * Handler for `delete_stored_objects` jobs (see
 * src/server/services/stored-objects.ts). A failure throws, so the worker
 * retries it with backoff, and so does storage not being configured: the job
 * exists because it was.
 */

import { deleteObjectsWithPrefix } from "../../storage/s3";
import type { JobPayloads } from "../queue";
import type { OneTimeJobHandlerResult } from "./types";

export async function handleDeleteStoredObjects(
  payload: JobPayloads["delete_stored_objects"]
): Promise<OneTimeJobHandlerResult> {
  const deleted = await deleteObjectsWithPrefix(payload.prefix);
  return { success: true, metadata: { prefix: payload.prefix, deleted } };
}
