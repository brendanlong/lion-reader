import type { db as dbType } from "@/server/db";
import * as entriesService from "@/server/services/entries";
import { formatEntryFull } from "./format";
import { errorResponse, jsonResponse } from "./parse";
import { listEntryTags } from "./tags";

/** The single-entry response most entry routes return. */
export async function formatEntryResponse(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<Response> {
  try {
    const [entry, tags] = await Promise.all([
      entriesService.getEntry(db, userId, entryId),
      listEntryTags(db, userId, [entryId]),
    ]);
    return jsonResponse(formatEntryFull(entry, tags.get(entryId) ?? []));
  } catch {
    return errorResponse("not_found", "Entry not found", 404);
  }
}
