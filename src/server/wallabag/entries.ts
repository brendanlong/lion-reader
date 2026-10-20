/**
 * Wallabag's entry list (`GET /api/wallabag/api/entries`): one page of the
 * user's saved articles, formatted, and the total for its page metadata.
 */

import type { db as dbType } from "@/server/db";
import { countTotalEntries, listEntries } from "@/server/services/entries";
import { getEntries } from "@/server/services/entry-reads";
import { entryIdsToWallabagIds } from "@/server/wallabag/id";
import { collectionIdGroupsForLabels, listEntryTags } from "@/server/wallabag/tags";
import { formatEntryFull, formatEntryListItem, type WallabagEntry } from "@/server/wallabag/format";
import type { parseEntryListParams } from "@/server/wallabag/parse";

export async function listWallabagEntries(
  db: typeof dbType,
  userId: string,
  params: ReturnType<typeof parseEntryListParams>
): Promise<{ items: WallabagEntry[]; total: number }> {
  // `domain_name` is deliberately unsupported, answered with an empty result rather
  // than a silently-unfiltered list (issue #1062): matching a domain means a per-row
  // regex over the entry URL with no index — a potential per-user table scan (DB CPU
  // is expensive), and not worth it for a rarely-used compat knob (issue #1070).
  if (params.domainName) {
    return { items: [], total: 0 };
  }

  const collectionIdGroups =
    params.tags.length > 0 ? await collectionIdGroupsForLabels(db, userId, params.tags) : undefined;
  if (collectionIdGroups === null) {
    return { items: [], total: 0 };
  }

  // Scope to saved articles only — the Wallabag API is a read-it-later interface.
  // The read/starred/since filters are shared by the page query and the count so
  // the two can't drift.
  const filter = {
    type: "saved" as const,
    showSpam: false,
    unreadOnly: params.archive === false ? true : undefined,
    readOnly: params.archive === true ? true : undefined,
    starredOnly: params.starred === true ? true : undefined,
    unstarredOnly: params.starred === false ? true : undefined,
    // Wallabag `since` (unix seconds) means "entries *updated* since" — clients
    // use it to pull new saves AND archive/star state changes for delta sync.
    // updatedAfter filters on user_entries.changed_at, which captures all three,
    // so this is correct (not a lossy save-time proxy).
    updatedAfter: params.since ? new Date(params.since * 1000) : undefined,
    collectionIdGroups,
  };

  // Wallabag `sort` field → listEntries sort column. `created` (default) is our
  // publish/fetch-time sort; `archived` sorts by when read state last changed
  // (our closest analogue to Wallabag's archived_at). `updated` (last-modified)
  // is approximated as the default `created` sort.
  const sortBy = params.sort === "archived" ? "archived" : "published";

  // Serve the requested page with a single indexed query via LIMIT/OFFSET, and
  // fetch the total count in parallel (Wallabag needs it for page metadata).
  const [result, total] = await Promise.all([
    listEntries(db, {
      ...filter,
      userId,
      limit: params.perPage,
      offset: (params.page - 1) * params.perPage,
      sortOrder: params.order === "asc" ? "oldest" : "newest",
      sortBy,
    }),
    countTotalEntries(db, userId, filter),
  ]);

  // If detail is "full", fetch full content in a single bulk query
  const entryIds = result.items.map((e) => e.id);
  const [fullEntries, tagsByEntry, wallabagIds] = await Promise.all([
    params.detail === "full" ? getEntries(db, userId, entryIds) : [],
    listEntryTags(db, userId, entryIds),
    entryIdsToWallabagIds(db, userId, entryIds),
  ]);
  const fullMap = new Map(fullEntries.map((e) => [e.id, e]));
  const items = result.items.flatMap((entry) => {
    const wallabagId = wallabagIds.get(entry.id);
    // Deleted since the page was listed.
    if (wallabagId === undefined) return [];
    const full = fullMap.get(entry.id);
    const tags = tagsByEntry.get(entry.id) ?? [];
    return full
      ? formatEntryFull(full, wallabagId, tags)
      : formatEntryListItem(entry, wallabagId, tags);
  });
  return { items, total };
}
