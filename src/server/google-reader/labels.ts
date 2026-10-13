/**
 * Google Reader labels: the user's tags and collections (#1821).
 *
 * Google Reader has one label namespace, `user/-/label/{name}`, and both kinds
 * of Lion Reader grouping are exposed through it. A tag is a folder of feeds
 * (`type: "folder"` in tag/list, on subscriptions' `categories`). A collection
 * is a set of articles, so it's an item label (`type: "tag"`, on items'
 * `categories`), never a feed: clients file each item under its `origin`
 * stream, the source feed, so a collection feed would have no items of its own.
 *
 * Names match ignoring case, as tag and collection names are each unique that
 * way. When a tag and a collection share a name, the tag keeps it and the
 * collection is labeled "{name} (collection)" (numbered if that's taken too,
 * in creation order). Labels are names, so renaming a tag or collection, or a
 * new tag taking a collection's name, shows clients a new label in place of the
 * old one at their next tag/list and item sync.
 */

import { and, asc, eq, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { subscriptions, tags } from "@/server/db/schema";
import { isCollectionSubscription } from "@/server/services/subscriptions";

export type GreaderLabel =
  | { kind: "tag"; tagId: string; name: string; sortid: bigint; unreadCount: number }
  | {
      kind: "collection";
      subscriptionId: string;
      /** The label name, which differs from the collection's name on a clash with a tag. */
      name: string;
      sortid: bigint;
    };

export interface GreaderLabels {
  /** Tags first, then collections in creation order. */
  all: GreaderLabel[];
  /** Label name by collection subscription id. */
  collectionNames: ReadonlyMap<string, string>;
  find(name: string): GreaderLabel | undefined;
}

const labelKey = (name: string): string => name.toLowerCase();

/** Tags and collections as Google Reader names them; see the module doc. */
export function buildGreaderLabels(
  userTags: Array<{ id: string; name: string; sortid: bigint; unreadCount: number }>,
  collections: Array<{ id: string; name: string; sortid: bigint }>
): GreaderLabels {
  const tagKeys = new Set(userTags.map((t) => labelKey(t.name)));
  const taken = new Set([...tagKeys, ...collections.map((c) => labelKey(c.name))]);

  const all: GreaderLabel[] = userTags.map((t) => ({
    kind: "tag",
    tagId: t.id,
    name: t.name,
    sortid: t.sortid,
    unreadCount: t.unreadCount,
  }));
  const collectionNames = new Map<string, string>();
  for (const c of collections) {
    let name = c.name;
    if (tagKeys.has(labelKey(name))) {
      for (let n = 1; ; n++) {
        name = n === 1 ? `${c.name} (collection)` : `${c.name} (collection ${n})`;
        if (!taken.has(labelKey(name))) break;
      }
      taken.add(labelKey(name));
    }
    collectionNames.set(c.id, name);
    all.push({ kind: "collection", subscriptionId: c.id, name, sortid: c.sortid });
  }

  const byKey = new Map(all.map((label) => [labelKey(label.name), label]));
  return { all, collectionNames, find: (name) => byKey.get(labelKey(name)) };
}

export async function listGreaderLabels(db: typeof dbType, userId: string): Promise<GreaderLabels> {
  const [userTags, collections] = await Promise.all([
    db
      .select({
        id: tags.id,
        name: tags.name,
        sortid: tags.greaderSortid,
        unreadCount: tags.unreadCount,
      })
      .from(tags)
      .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)))
      .orderBy(asc(tags.id)),
    db
      .select({
        id: subscriptions.id,
        // An active collection always has its name here.
        name: subscriptions.customTitle,
        sortid: subscriptions.greaderStreamId,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          isCollectionSubscription(),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .orderBy(asc(subscriptions.id)),
  ]);
  return buildGreaderLabels(
    userTags,
    collections.map((c) => ({ ...c, name: c.name ?? "" }))
  );
}

/** The entries-service filter selecting a label's stream. */
export function labelFilter(label: GreaderLabel): { tagId: string } | { subscriptionId: string } {
  return label.kind === "tag" ? { tagId: label.tagId } : { subscriptionId: label.subscriptionId };
}
