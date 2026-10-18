/**
 * Google Reader stream requests → entries-service filters.
 *
 * stream/contents, stream/items/ids and mark-all-as-read all name a stream
 * (`s`, or the path); the two reads also narrow it with `ot`/`nt`/`xt`/`it`.
 * Both translations live here so the three endpoints select the same entries.
 */

import type { db as dbType } from "@/server/db";
import type { ListEntriesParams } from "@/server/services/entries";
import { isState, parseStreamId, type StreamId } from "./streams";
import { resolveFeedStreamFilter } from "./subscriptions";
import { resolveTagByName } from "./tags";

/** The part of a `listEntries` query a stream id decides. */
type StreamFilter = Pick<
  ListEntriesParams,
  "subscriptionId" | "type" | "tagId" | "starredOnly" | "readOnly"
>;

/**
 * Why a stream id selects nothing: 400 for one we can't parse or don't serve,
 * 404 for a feed or label the user doesn't have.
 */
export interface StreamError {
  status: 400 | 404;
  message: string;
}

/** Resolves a stream id to the entries it selects, scoped to `userId`. */
export async function resolveStreamFilter(
  db: typeof dbType,
  userId: string,
  streamId: string
): Promise<StreamFilter | StreamError> {
  let parsed: StreamId;
  try {
    parsed = parseStreamId(streamId);
  } catch {
    return { status: 400, message: `Invalid stream ID: ${streamId}` };
  }

  switch (parsed.type) {
    case "feed": {
      const filter = await resolveFeedStreamFilter(db, userId, parsed.subscriptionInt64);
      return filter ?? { status: 404, message: "Subscription not found" };
    }
    case "label": {
      const tag = await resolveTagByName(db, userId, parsed.name);
      return tag ? { tagId: tag.id } : { status: 404, message: `Tag not found: ${parsed.name}` };
    }
    case "state":
      switch (parsed.state) {
        case "reading-list":
          return {};
        case "starred":
          return { starredOnly: true };
        case "read":
          return { readOnly: true };
        default:
          return { status: 400, message: `Unsupported state: ${parsed.state}` };
      }
  }
}

export function isStreamError<T extends object>(result: T | StreamError): result is StreamError {
  return "status" in result;
}

/** A unix-seconds timestamp parameter as a Date, or undefined if absent or not a number. */
function unixSecondsParam(value: string | null): Date | undefined {
  const seconds = value === null ? NaN : parseInt(value, 10);
  return isNaN(seconds) ? undefined : new Date(seconds * 1000);
}

/**
 * The narrowing a read request adds to its stream:
 * - `ot` (oldest time): only items published after it
 * - `nt` (newest time): only items published before it
 * - `xt` (exclude target): `read` leaves out read items
 * - `it` (include target): `read` or `starred` keeps only those items
 */
function streamQueryFilter(
  query: URLSearchParams
): Pick<
  ListEntriesParams,
  "publishedAfter" | "publishedBefore" | "unreadOnly" | "readOnly" | "starredOnly"
> {
  const filter: ReturnType<typeof streamQueryFilter> = {
    publishedAfter: unixSecondsParam(query.get("ot")),
    publishedBefore: unixSecondsParam(query.get("nt")),
  };
  const exclude = query.get("xt");
  if (exclude && isState(exclude, "read")) filter.unreadOnly = true;
  const include = query.get("it");
  if (include && isState(include, "read")) filter.readOnly = true;
  if (include && isState(include, "starred")) filter.starredOnly = true;
  return filter;
}

/**
 * The `listEntries` query for a stream read: the stream's filter, the request's
 * narrowing, and its page (`n`, capped at `maxCount`; `c`; `r=o` for oldest
 * first).
 */
export async function resolveStreamListParams(
  db: typeof dbType,
  user: { id: string; showSpam: boolean },
  streamId: string,
  query: URLSearchParams,
  page: { defaultCount: number; maxCount: number }
): Promise<ListEntriesParams | StreamError> {
  const streamFilter = await resolveStreamFilter(db, user.id, streamId);
  if (isStreamError(streamFilter)) return streamFilter;

  const queryFilter = streamQueryFilter(query);
  return {
    userId: user.id,
    showSpam: user.showSpam,
    limit: Math.min(parseInt(query.get("n") ?? "", 10) || page.defaultCount, page.maxCount),
    maxLimit: page.maxCount,
    cursor: query.get("c") ?? undefined,
    sortOrder: query.get("r") === "o" ? "oldest" : "newest",
    ...streamFilter,
    ...queryFilter,
    // Both the stream and `it` may narrow to read or starred items.
    readOnly: streamFilter.readOnly || queryFilter.readOnly,
    starredOnly: streamFilter.starredOnly || queryFilter.starredOnly,
  };
}
