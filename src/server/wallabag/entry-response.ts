import type { db as dbType } from "@/server/db";
import * as entriesService from "@/server/services/entries";
import { getAppErrorCode } from "@/server/trpc/errors";
import { formatEntryFull } from "./format";
import { errorResponse, jsonResponse } from "./parse";
import { listEntryTags } from "./tags";

/** The single-entry response most entry routes return. */
export async function formatEntryResponse(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<Response> {
  const [entry, tags] = await Promise.all([
    entriesService.getEntry(db, userId, entryId).catch((error: unknown) => {
      if (getAppErrorCode(error) === "ENTRY_NOT_FOUND") return null;
      throw error;
    }),
    listEntryTags(db, userId, [entryId]),
  ]);
  if (!entry) {
    return errorResponse("not_found", "Entry not found", 404);
  }
  return jsonResponse(formatEntryFull(entry, tags.get(entryId) ?? []));
}
