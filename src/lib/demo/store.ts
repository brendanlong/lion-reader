/**
 * The demo's backend: an in-memory implementation of the tRPC procedures the
 * reader tree issues, over the static article fixtures in `@/lib/demo/data`.
 *
 * The demo renders the app's real routing/state layer (`UnifiedEntriesContent`,
 * `Sidebar`, `useEntryMutations`, …) through a `createHandlerLink` built from
 * these handlers, so every cache write, optimistic update and invalidation runs
 * the same code as the app — only the network is replaced. Each handler is
 * typed from the router's inferred input/output, so a change to a procedure's
 * shape fails typecheck here instead of drifting.
 *
 * State (read/starred, subscription edits) lives for one page load; a reload
 * starts fresh. Handlers always return new objects — React Query keeps what it
 * is given, so mutating a returned object would change the cache behind its back.
 */

import { ENTRY_SORT_DIRECTIONS, sortFieldOf } from "@/lib/entry-sort";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/root";
import { procedureError, type ProcedureHandlers } from "@/lib/trpc/handler-link";
import { SAVED_ARTICLES_TITLE } from "@/lib/entry-types";
import { compareListEntries, entryMatchesList } from "@/lib/local-db/entry-lists";
import type { TagLists } from "@/lib/events/schemas";
import {
  DEMO_ENTRIES,
  DEMO_SUBSCRIPTIONS,
  DEMO_TAGS,
  type DemoEntry,
  type DemoSubscription,
  type DemoTag,
} from "@/lib/demo/data";

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;

type ListItem = Outputs["entries"]["list"]["items"][number];
type FullEntry = Outputs["entries"]["get"]["entry"];
type Subscription = Outputs["subscriptions"]["get"];
type BulkUnreadCounts = NonNullable<Outputs["entries"]["markRead"]["counts"]>;
type EntryType = ListItem["type"];

/** A single-tRPC-procedure handler typed from the router. */
type Handler<TInput, TOutput> = (input: TInput) => TOutput;

/** The procedures the demo implements. Adding one here is the whole change. */
export type DemoProcedures = {
  "entries.list": Handler<Inputs["entries"]["list"], Outputs["entries"]["list"]>;
  "entries.get": Handler<Inputs["entries"]["get"], Outputs["entries"]["get"]>;
  "entries.countLists": Handler<void, Outputs["entries"]["countLists"]>;
  "entries.markRead": Handler<Inputs["entries"]["markRead"], Outputs["entries"]["markRead"]>;
  "entries.markAllRead": Handler<
    Inputs["entries"]["markAllRead"],
    Outputs["entries"]["markAllRead"]
  >;
  "entries.setStarred": Handler<Inputs["entries"]["setStarred"], Outputs["entries"]["setStarred"]>;
  "entries.fetchFullContent": Handler<
    Inputs["entries"]["fetchFullContent"],
    Outputs["entries"]["fetchFullContent"]
  >;
  "tags.list": Handler<Inputs["tags"]["list"], Outputs["tags"]["list"]>;
  "subscriptions.list": Handler<Inputs["subscriptions"]["list"], Outputs["subscriptions"]["list"]>;
  "subscriptions.get": Handler<Inputs["subscriptions"]["get"], Outputs["subscriptions"]["get"]>;
  "subscriptions.update": Handler<
    Inputs["subscriptions"]["update"],
    Outputs["subscriptions"]["update"]
  >;
  "subscriptions.setTags": Handler<
    Inputs["subscriptions"]["setTags"],
    Outputs["subscriptions"]["setTags"]
  >;
  "subscriptions.delete": Handler<
    Inputs["subscriptions"]["delete"],
    Outputs["subscriptions"]["delete"]
  >;
  "collections.create": Handler<Inputs["collections"]["create"], Outputs["collections"]["create"]>;
  "collections.addEntries": Handler<
    Inputs["collections"]["addEntries"],
    Outputs["collections"]["addEntries"]
  >;
  "collections.removeEntries": Handler<
    Inputs["collections"]["removeEntries"],
    Outputs["collections"]["removeEntries"]
  >;
  "summarization.isAvailable": Handler<
    Inputs["summarization"]["isAvailable"],
    Outputs["summarization"]["isAvailable"]
  >;
  "summarization.generate": Handler<
    Inputs["summarization"]["generate"],
    Outputs["summarization"]["generate"]
  >;
};

export interface DemoStore {
  handlers: ProcedureHandlers;
  /** Direct access for tests and the SSR seeder. */
  procedures: DemoProcedures;
}

interface EntryState {
  entry: DemoEntry;
  read: boolean;
  starred: boolean;
  readChangedAt: Date | null;
  updatedAt: Date;
  fullContentFetchedAt: Date | null;
}

interface SubscriptionState {
  id: string;
  /** A collection's entries are its `members`; a feed's are those it published. */
  type: "web" | "collection";
  title: string;
  originalTitle: string;
  description: string | null;
  tagIds: string[];
  fetchFullContent: boolean;
  deleted: boolean;
  members: Set<string>;
}

/** All demo subscriptions predate every article. */
const SUBSCRIBED_AT = new Date("2025-01-01T00:00:00Z");

/** Query-param booleans arrive as strings over HTTP; the router coerces them. */
function bool(value: boolean | "true" | "false" | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

/** `z.coerce.date()` inputs are typed loosely; in-process they are Dates or absent. */
function toDate(value: unknown, fallback: Date): Date {
  return value instanceof Date ? value : fallback;
}

/** A list item's place for paging: its read time (Recently Read's key) and id. */
interface Place {
  key: number;
  id: string;
}

function encodeCursor(position: Place): string {
  return `${position.key}:${position.id}`;
}

function decodeCursor(cursor: string | undefined): Place | null {
  if (!cursor) return null;
  const separator = cursor.indexOf(":");
  const key = Number(cursor.slice(0, separator));
  return separator > 0 && Number.isFinite(key) ? { key, id: cursor.slice(separator + 1) } : null;
}

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

interface EntryFilter {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: EntryType;
  excludeTypes?: EntryType[];
  unreadOnly?: boolean;
  starredOnly?: boolean;
  query?: string;
}

/** The demo user's saved subscription: saved articles' origin, in no tag or Uncategorized. */
const DEMO_SAVED_SUBSCRIPTION_ID = "demo-saved";

let lastAsOfMicros = 0;

/**
 * A count stamp (`countsAsOfSchema`) for a count read now: strictly
 * increasing, as the server's are for counts read in turn. The only output
 * that isn't deterministic, and never rendered.
 */
function nextCountsAsOf(): string {
  lastAsOfMicros = Math.max(Date.now() * 1000, lastAsOfMicros + 1);
  const iso = new Date(Math.floor(lastAsOfMicros / 1000)).toISOString();
  return iso.replace("Z", `${String(lastAsOfMicros % 1000).padStart(3, "0")}Z`);
}

export interface DemoFixtures {
  tags: DemoTag[];
  subscriptions: DemoSubscription[];
  entries: DemoEntry[];
}

const DEMO_FIXTURES: DemoFixtures = {
  tags: DEMO_TAGS,
  subscriptions: DEMO_SUBSCRIPTIONS,
  entries: DEMO_ENTRIES,
};

export function createDemoStore(fixtures: DemoFixtures = DEMO_FIXTURES): DemoStore {
  const tags = new Map(fixtures.tags.map((tag) => [tag.id, tag]));

  const subscriptions = new Map<string, SubscriptionState>(
    fixtures.subscriptions.map((sub) => [
      sub.id,
      {
        id: sub.id,
        type: "web",
        title: sub.title,
        originalTitle: sub.title,
        description: sub.description,
        tagIds: [sub.tagId],
        fetchFullContent: false,
        deleted: false,
        members: new Set(),
      },
    ])
  );

  const entries = new Map<string, EntryState>(
    fixtures.entries.map((entry) => [
      entry.id,
      {
        entry,
        read: false,
        starred: entry.starred,
        readChangedAt: null,
        updatedAt: entry.publishedAt ?? entry.fetchedAt,
        fullContentFetchedAt: null,
      },
    ])
  );

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  /** The entry's live subscription, or undefined once unsubscribed (an orphan). */
  function subscriptionOf(state: EntryState): SubscriptionState | undefined {
    const sub = subscriptions.get(state.entry.subscriptionId ?? "");
    return sub && !sub.deleted ? sub : undefined;
  }

  /**
   * The live subscriptions containing the entry: its feed and any collections
   * holding it. A saved article's origin is the saved subscription instead,
   * which isn't one of these (#1846).
   */
  function containersOf(state: EntryState): SubscriptionState[] {
    const feed = state.entry.type === "saved" ? undefined : subscriptionOf(state);
    const collections = liveSubscriptions().filter((sub) => sub.members.has(state.entry.id));
    return feed ? [feed, ...collections] : collections;
  }

  /**
   * The entry's origin as the API reports it: for a saved article the saved
   * subscription (#1846), which nothing can update.
   */
  function originOf(state: EntryState): string | null {
    if (state.entry.type === "saved") return DEMO_SAVED_SUBSCRIPTION_ID;
    return subscriptionOf(state)?.id ?? null;
  }

  /** The active subscriptions holding the entry, like the API's `subscriptionIds`. */
  function subscriptionIdsOf(state: EntryState): string[] {
    const ids = containersOf(state).map((sub) => sub.id);
    return state.entry.type === "saved" ? [DEMO_SAVED_SUBSCRIPTION_ID, ...ids].sort() : ids.sort();
  }

  /** The tag lists holding the entry, like the API's `tagLists`. */
  function tagListsOf(state: EntryState): TagLists {
    const containers = containersOf(state);
    return {
      tagIds: [...new Set(containers.flatMap((sub) => sub.tagIds))],
      uncategorized: containers.some((sub) => sub.tagIds.length === 0),
    };
  }

  /**
   * Saved articles (in the saved subscription), starred ones and collected
   * ones stay visible after unsubscribing, like the app.
   */
  function isVisible(state: EntryState): boolean {
    return state.entry.type === "saved" || containersOf(state).length > 0 || state.starred;
  }

  function matches(state: EntryState, filter: EntryFilter): boolean {
    if (!isVisible(state)) return false;
    const row = {
      ...state,
      type: state.entry.type,
      subscriptionIds: subscriptionIdsOf(state),
      tagLists: tagListsOf(state),
    };
    if (!entryMatchesList(filter, row, DEMO_SAVED_SUBSCRIPTION_ID)) return false;
    if (filter.excludeTypes?.includes(state.entry.type)) return false;
    if (filter.query) {
      const needle = filter.query.trim().toLowerCase();
      const haystack = [state.entry.title, state.entry.summary, plainText(state.entry.contentHtml)]
        .filter((s): s is string => Boolean(s))
        .join(" ")
        .toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
    }
    return true;
  }

  function select(filter: EntryFilter): EntryState[] {
    return [...entries.values()].filter((state) => matches(state, filter));
  }

  function unread(filter: EntryFilter): number {
    return select({ ...filter, unreadOnly: true }).length;
  }

  function liveSubscriptions(): SubscriptionState[] {
    return [...subscriptions.values()].filter((sub) => !sub.deleted);
  }

  // ---------------------------------------------------------------------------
  // Output shapes
  // ---------------------------------------------------------------------------

  function toListItem(state: EntryState): ListItem {
    const { entry } = state;
    const sub = subscriptionOf(state);
    return {
      id: entry.id,
      subscriptionId: originOf(state),
      subscriptionIds: subscriptionIdsOf(state),
      tagLists: tagListsOf(state),
      positions: {},
      type: entry.type,
      url: entry.url,
      title: entry.title,
      author: entry.author,
      summary: entry.summary,
      publishedAt: entry.publishedAt,
      fetchedAt: entry.fetchedAt,
      read: state.read,
      starred: state.starred,
      readChangedAt: state.readChangedAt,
      score: entry.score,
      updatedAt: state.updatedAt,
      // Demo entries never change, only their state does.
      entryUpdatedAt: entry.publishedAt ?? entry.fetchedAt,
      feedTitle: entry.type === "saved" ? SAVED_ARTICLES_TITLE : (sub?.title ?? entry.feedTitle),
      siteName: entry.siteName,
    };
  }

  function toFullEntry(state: EntryState): FullEntry {
    const contentCleaned = state.entry.contentHtml;
    return {
      ...toListItem(state),
      contentOriginal: null,
      contentCleaned,
      feedUrl: null,
      unsubscribeUrl: null,
      fullContentOriginal: null,
      // "Full content" of a self-contained demo article is the article itself.
      fullContentCleaned: state.fullContentFetchedAt ? contentCleaned : null,
      fullContentFetchedAt: state.fullContentFetchedAt,
      fullContentError: null,
      // The saved subscription has no settings.
      fetchFullContent:
        originOf(state) === DEMO_SAVED_SUBSCRIPTION_ID
          ? false
          : (subscriptionOf(state)?.fetchFullContent ?? false),
    };
  }

  function toSubscription(sub: SubscriptionState): Subscription {
    return {
      id: sub.id,
      type: sub.type,
      url: null,
      title: sub.title,
      originalTitle: sub.originalTitle,
      description: sub.description,
      siteUrl: null,
      subscribedAt: SUBSCRIBED_AT,
      unreadCount: unread({ subscriptionId: sub.id }),
      unreadCountAsOf: nextCountsAsOf(),
      tags: sub.tagIds.flatMap((id) => {
        const tag = tags.get(id);
        return tag ? [{ id: tag.id, name: tag.name, color: tag.color }] : [];
      }),
      fetchFullContent: sub.fetchFullContent,
    };
  }

  /** The saved subscription as the API lists it (#1846). */
  function toSavedSubscription(): Subscription {
    return {
      id: DEMO_SAVED_SUBSCRIPTION_ID,
      type: "saved",
      url: null,
      title: "Saved",
      originalTitle: "Saved",
      description: null,
      siteUrl: null,
      subscribedAt: SUBSCRIBED_AT,
      unreadCount: unread({ type: "saved" }),
      unreadCountAsOf: nextCountsAsOf(),
      tags: [],
      fetchFullContent: false,
    };
  }

  function globalCounts() {
    return {
      all: { unread: unread({}) },
      starred: { unread: unread({ starredOnly: true }) },
      saved: { unread: unread({ type: "saved" }) },
    };
  }

  /** Absolute counts for every list a set of subscriptions feeds into. */
  function countsForSubscriptions(subs: SubscriptionState[]): BulkUnreadCounts {
    const tagIds = [...new Set(subs.flatMap((sub) => sub.tagIds))];
    return {
      ...globalCounts(),
      asOf: nextCountsAsOf(),
      // A deleted subscription has no count to show, as on the server.
      subscriptions: subs
        .filter((sub) => !sub.deleted)
        .map((sub) => ({
          id: sub.id,
          unread: unread({ subscriptionId: sub.id }),
          tagIds: sub.tagIds,
        })),
      tags: tagIds.map((id) => ({ id, unread: unread({ tagId: id }) })),
      uncategorized: subs.some((sub) => sub.tagIds.length === 0)
        ? { unread: unread({ uncategorized: true }) }
        : undefined,
    };
  }

  /** What a list orders an entry by; a cursor's entry may have left the list since. */
  function sortFields(id: string) {
    const state = entries.get(id);
    if (!state) throw procedureError("BAD_REQUEST", "Invalid cursor");
    const { entry } = state;
    return {
      id,
      publishedAt: entry.publishedAt,
      fetchedAt: entry.fetchedAt,
      score: entry.score,
      positions: {},
    };
  }

  function requireEntry(id: string): EntryState {
    const state = entries.get(id);
    if (!state || !isVisible(state)) throw procedureError("NOT_FOUND", "Entry not found");
    return state;
  }

  function requireSubscription(id: string): SubscriptionState {
    const sub = subscriptions.get(id);
    if (!sub || sub.deleted) throw procedureError("NOT_FOUND", "Subscription not found");
    return sub;
  }

  function requireCollection(id: string): SubscriptionState {
    const sub = requireSubscription(id);
    if (sub.type !== "collection") throw procedureError("NOT_FOUND", "Subscription not found");
    return sub;
  }

  function changeMembership(
    collectionId: string,
    entryIds: string[],
    added: boolean
  ): Outputs["collections"]["addEntries"] {
    const collection = requireCollection(collectionId);
    const updatedAt = new Date();
    const changed = entryIds.filter((id) => {
      const state = entries.get(id);
      if (!state || !isVisible(state) || collection.members.has(id) === added) return false;
      if (added) collection.members.add(id);
      else collection.members.delete(id);
      state.updatedAt = updatedAt;
      return true;
    });
    if (changed.length === 0) return { entryIds: [], tagLists: [] };
    return {
      entryIds: changed,
      counts: countsForSubscriptions([collection]),
      tagLists: changed.map((entryId) => ({ entryId, ...tagListsOf(entries.get(entryId)!) })),
      updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Procedures
  // ---------------------------------------------------------------------------

  const procedures: DemoProcedures = {
    "entries.list": (input) => {
      // Every demo article has a score (its rank in the tour), so lists open
      // sorted by it, as a real list does once the user picks that sort.
      const sortBy = input.sortBy ?? (input.sortOrder ? sortFieldOf(input.sortOrder) : "score");
      const filter: EntryFilter = {
        subscriptionId: input.subscriptionId,
        tagId: input.tagId,
        uncategorized: bool(input.uncategorized),
        type: input.type,
        excludeTypes: input.excludeTypes,
        unreadOnly: bool(input.unreadOnly),
        starredOnly: bool(input.starredOnly),
        query: input.query,
      };
      const sortOrder = input.sortOrder ?? ENTRY_SORT_DIRECTIONS[sortBy][0];
      // Recently Read orders by a field entries don't carry, so the client
      // keeps the server's order; every other list is ordered as the client
      // orders it. A cursor names its entry's place, which for a read time
      // must travel with it (marking it read again moves the entry).
      const listOrder = compareListEntries({
        subscriptionId: input.subscriptionId,
        sortBy,
        sortOrder,
      });
      const readOrder = sortOrder === "oldest" ? 1 : -1;
      const compare = (a: Place, b: Place) =>
        sortBy === "readChanged"
          ? readOrder * (a.key - b.key) || a.id.localeCompare(b.id)
          : listOrder(sortFields(a.id), sortFields(b.id));
      const position = (state: EntryState): Place => ({
        key: state.readChangedAt?.getTime() ?? 0,
        id: state.entry.id,
      });

      const sorted = select(filter)
        // The recently-read view lists only entries whose read state has changed.
        .filter((state) => sortBy !== "readChanged" || state.readChangedAt !== null)
        .sort((a, b) => compare(position(a), position(b)));

      // Keyset cursor (sort key + id of the last item served), like the real
      // service: the page continues after that position even if the cursor
      // entry itself has since dropped out of the filter (e.g. marked read in
      // an unread-only view), so nothing is repeated.
      const cursor = decodeCursor(input.cursor);
      const start = cursor ? sorted.findIndex((s) => compare(position(s), cursor) > 0) : 0;
      const limit = Math.min(input.limit ?? 50, 100);
      const page = start === -1 ? [] : sorted.slice(start, start + limit);
      const hasMore = start !== -1 && start + limit < sorted.length;
      const last = page[page.length - 1];
      return {
        items: page.map(toListItem),
        nextCursor: hasMore && last ? encodeCursor(position(last)) : undefined,
        ...(!input.cursor &&
          sortBy !== "readChanged" && {
            sortable: { score: sorted.length > 0, position: false },
          }),
        ...(!input.cursor && { sort: { sortBy, sortOrder } }),
      };
    },

    "entries.get": (input) => ({ entry: toFullEntry(requireEntry(input.id)) }),

    "entries.countLists": () => ({
      all: unread({}),
      starred: unread({ starredOnly: true }),
      saved: unread({ type: "saved" }),
      uncategorized: unread({ uncategorized: true }),
      asOf: nextCountsAsOf(),
    }),

    "entries.markRead": (input) => {
      const now = new Date();
      const affected = new Map<string, SubscriptionState>();
      const results: Outputs["entries"]["markRead"]["entries"] = [];
      let flipped = false;
      for (const { id, changedAt } of input.entries) {
        const state = entries.get(id);
        if (!state || !isVisible(state)) continue;
        // In-process there is no separate server clock: the caller's timestamp
        // is the write time (the seed relies on this to stay deterministic).
        const writtenAt = toDate(changedAt, now);
        // Same-value re-asserts advance the read-changed watermark (so the entry
        // surfaces in Recently Read) without counting as a change (#1118).
        if (state.read !== input.read) {
          state.read = input.read;
          state.updatedAt = writtenAt;
          flipped = true;
          for (const sub of containersOf(state)) affected.set(sub.id, sub);
        }
        state.readChangedAt = writtenAt;
        results.push({
          id,
          subscriptionId: originOf(state),
          subscriptionIds: subscriptionIdsOf(state),
          tagLists: tagListsOf(state),
          read: state.read,
          starred: state.starred,
          type: state.entry.type,
          updatedAt: state.updatedAt,
          readChangedAt: state.readChangedAt,
          score: state.entry.score,
          positions: {},
        });
      }
      return {
        success: true,
        count: results.length,
        entries: results,
        counts: flipped ? countsForSubscriptions([...affected.values()]) : undefined,
      };
    },

    "entries.markAllRead": (input) => {
      const now = new Date();
      const targets = select({
        subscriptionId: input.subscriptionId,
        tagId: input.tagId,
        uncategorized: input.uncategorized,
        starredOnly: input.starredOnly,
        type: input.type,
        unreadOnly: true,
      }).filter(
        (state) =>
          !(input.before instanceof Date) ||
          (state.entry.publishedAt ?? state.entry.fetchedAt) < input.before
      );
      const affected = new Map<string, SubscriptionState>();
      for (const state of targets) {
        state.read = true;
        state.readChangedAt = toDate(input.changedAt, now);
        state.updatedAt = now;
        for (const sub of containersOf(state)) affected.set(sub.id, sub);
      }
      return {
        count: targets.length,
        counts: targets.length > 0 ? countsForSubscriptions([...affected.values()]) : undefined,
      };
    },

    "entries.setStarred": (input) => {
      const state = requireEntry(input.id);
      const flipped = state.starred !== input.starred;
      if (flipped) {
        state.starred = input.starred;
        state.updatedAt = new Date();
      }
      return {
        entry: {
          id: state.entry.id,
          read: state.read,
          starred: state.starred,
          updatedAt: state.updatedAt,
        },
        counts: flipped ? countsForSubscriptions(containersOf(state)) : undefined,
      };
    },

    "entries.fetchFullContent": (input) => {
      const state = requireEntry(input.id);
      state.fullContentFetchedAt = new Date();
      return { success: true, entry: toFullEntry(state) };
    },

    "tags.list": () => ({
      items: [...tags.values()].map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        feedCount: liveSubscriptions().filter((sub) => sub.tagIds.includes(tag.id)).length,
        unreadCount: unread({ tagId: tag.id }),
        createdAt: SUBSCRIBED_AT,
      })),
      uncategorized: {
        feedCount: liveSubscriptions().filter((sub) => sub.tagIds.length === 0).length,
        unreadCount: unread({ uncategorized: true }),
      },
      asOf: nextCountsAsOf(),
    }),

    "subscriptions.list": (input) => {
      const needle = input?.query?.trim().toLowerCase();
      // Saved is listed too, but is in no tag or Uncategorized (#1846).
      const saved = input?.tagId === undefined && !input?.uncategorized;
      const matching = [
        ...liveSubscriptions()
          .filter((sub) => input?.tagId === undefined || sub.tagIds.includes(input.tagId))
          .filter((sub) => !input?.uncategorized || sub.tagIds.length === 0)
          .map(toSubscription),
        ...(saved ? [toSavedSubscription()] : []),
      ]
        .filter((sub) => !input?.unreadOnly || sub.unreadCount > 0)
        .filter((sub) => input?.type === undefined || sub.type === input.type)
        .filter((sub) => !needle || sub.title?.toLowerCase().includes(needle));
      const after = input?.cursor ? matching.findIndex((s) => s.id === input.cursor) : -1;
      // A cursor that no longer matches (unsubscribed meanwhile) ends the list.
      const start = input?.cursor ? (after === -1 ? matching.length : after + 1) : 0;
      const limit = input?.limit ?? 50;
      const page = matching.slice(start, start + limit);
      return {
        items: page,
        nextCursor: start + limit < matching.length ? page[page.length - 1].id : undefined,
      };
    },

    "subscriptions.get": (input) =>
      input.id === DEMO_SAVED_SUBSCRIPTION_ID
        ? toSavedSubscription()
        : toSubscription(requireSubscription(input.id)),

    "subscriptions.update": (input) => {
      const sub = requireSubscription(input.id);
      if (input.customTitle !== undefined) {
        const title = input.customTitle?.trim() || null;
        // As on the server (#1846): a collection's name is required and
        // unique among live collections, ignoring case.
        if (sub.type === "collection") {
          if (!title) {
            throw procedureError("BAD_REQUEST", "Collection name is required", "VALIDATION_ERROR");
          }
          const clash = liveSubscriptions().some(
            (other) =>
              other.id !== sub.id &&
              other.type === "collection" &&
              other.title.toLowerCase() === title.toLowerCase()
          );
          if (clash) {
            throw procedureError(
              "CONFLICT",
              "A collection with this name already exists",
              "COLLECTION_NAME_TAKEN"
            );
          }
        }
        sub.title = title ?? sub.originalTitle;
      }
      if (input.fetchFullContent !== undefined) {
        sub.fetchFullContent = input.fetchFullContent;
      }
      return toSubscription(sub);
    },

    "subscriptions.setTags": (input) => {
      const sub = requireSubscription(input.id);
      sub.tagIds = input.tagIds.filter((id) => tags.has(id));
      return toSubscription(sub);
    },

    "subscriptions.delete": (input) => {
      const sub = requireSubscription(input.id);
      if (sub.type === "collection" && bool(input.deleteSavedArticles)) {
        for (const id of sub.members) {
          const inOtherCollection = liveSubscriptions().some(
            (other) => other !== sub && other.members.has(id)
          );
          if (entries.get(id)?.entry.type === "saved" && !inOtherCollection) entries.delete(id);
        }
      }
      sub.deleted = true;
      sub.members.clear();
      return { success: true, counts: countsForSubscriptions([sub]) };
    },

    "collections.create": (input) => {
      const existing = liveSubscriptions().find(
        (s) => s.type === "collection" && s.title.toLowerCase() === input.name.toLowerCase()
      );
      if (existing) {
        return {
          subscription: toSubscription(existing),
          counts: countsForSubscriptions([existing]),
          created: false,
        };
      }
      const sub: SubscriptionState = {
        id: crypto.randomUUID(),
        type: "collection",
        title: input.name,
        originalTitle: input.name,
        description: null,
        tagIds: [],
        fetchFullContent: false,
        deleted: false,
        members: new Set(),
      };
      subscriptions.set(sub.id, sub);
      return {
        subscription: toSubscription(sub),
        counts: countsForSubscriptions([sub]),
        created: true,
      };
    },

    "collections.addEntries": (input) => changeMembership(input.id, input.entryIds, true),

    "collections.removeEntries": (input) => changeMembership(input.id, input.entryIds, false),

    "summarization.isAvailable": () => ({ available: true }),

    "summarization.generate": (input) => {
      const { entry } = requireEntry(input.entryId);
      return {
        summary: entry.summaryHtml,
        cached: true,
        modelId: entry.summaryModelId,
        generatedAt: entry.summaryGeneratedAt,
        settingsChanged: false,
      };
    },
  };

  return { handlers: procedures, procedures };
}
