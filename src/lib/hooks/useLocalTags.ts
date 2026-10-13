/**
 * Hooks that render tags and unread counts from the local store
 * (`src/lib/local-db/tags.ts`, `counts.ts`).
 */

"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { eq } from "@tanstack/db";
import { getLocalDb } from "@/lib/local-db/local-db";
import { countKey, type CountedList } from "@/lib/local-db/counts";
import type { TagRow } from "@/lib/local-db/tags";

/** Every stored tag, by name. */
export function useLocalTags(): TagRow[] {
  const db = getLocalDb(useQueryClient());
  const { data } = useLiveQuery({
    query: (q) => q.from({ tag: db.tags.rows.collection }),
  });
  return useMemo(() => [...data].sort((a, b) => a.name.localeCompare(b.name)), [data]);
}

/** A list's unread count, or undefined until one has loaded. */
export function useUnreadCount(list: CountedList): number | undefined {
  const db = getLocalDb(useQueryClient());
  const key = countKey(list);
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ count: db.counts.rows.collection })
        .where(({ count }) => eq(count.key, key))
        .findOne(),
  });
  return data?.unread;
}

/** Every stored unread count, by `countKey`. */
export function useUnreadCounts(): ReadonlyMap<string, number> {
  const db = getLocalDb(useQueryClient());
  const { data } = useLiveQuery({
    query: (q) => q.from({ count: db.counts.rows.collection }),
  });
  return useMemo(() => new Map(data.map((row) => [row.key, row.unread])), [data]);
}

/** One stored tag, or undefined when the store doesn't hold it. */
export function useLocalTag(tagId: string | undefined): TagRow | undefined {
  const db = getLocalDb(useQueryClient());
  const { data } = useLiveQuery({
    query: (q) =>
      tagId === undefined
        ? undefined
        : q
            .from({ tag: db.tags.rows.collection })
            .where(({ tag }) => eq(tag.id, tagId))
            .findOne(),
  });
  return data;
}
