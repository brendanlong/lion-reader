import type { db as dbType } from "@/server/db";
import * as entryReadsService from "@/server/services/entry-reads";
import { getAppErrorCode } from "@/server/errors";
import { formatEntryFull } from "./format";
import type { ResolvedWallabagEntry } from "./id";
import { errorResponse, jsonResponse } from "./parse";
import { listEntryTags } from "./tags";

/** The single-entry response most entry routes return. */
export async function formatEntryResponse(
  db: typeof dbType,
  userId: string,
  { id: entryId, wallabagId }: ResolvedWallabagEntry
): Promise<Response> {
  const [entry, tags] = await Promise.all([
    entryReadsService.getEntry(db, userId, entryId).catch((error: unknown) => {
      if (getAppErrorCode(error) === "ENTRY_NOT_FOUND") return null;
      throw error;
    }),
    listEntryTags(db, userId, [entryId]),
  ]);
  if (!entry) {
    return errorResponse("not_found", "Entry not found", 404);
  }
  return jsonResponse(formatEntryFull(entry, wallabagId, tags.get(entryId) ?? []));
}
