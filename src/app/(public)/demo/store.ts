/**
 * The demo's backend: an in-memory implementation of the tRPC procedures the
 * reader tree issues, over the static article fixtures in ./data.
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

import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/root";
import { procedureError, type ProcedureHandlers } from "@/lib/trpc/handler-link";
import {
  DEMO_ENTRIES,
  DEMO_SUBSCRIPTIONS,
  DEMO_TAGS,
  heroFigureHtml,
  type DemoEntry,
} from "./data";

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;

type ListItem = Outputs["entries"]["list"]["items"][number];
type FullEntry = Outputs["entries"]["get"]["entry"];
type Subscription = Outputs["subscriptions"]["get"];
type BulkUnreadCounts = NonNullable<Outputs["entries"]["markRead"]["counts"]>;
type UnreadCounts = NonNullable<Outputs["entries"]["setStarred"]["counts"]>;
type EntryType = ListItem["type"];

/** A single-tRPC-procedure handler typed from the router. */
type Handler<TInput, TOutput> = (input: TInput) => TOutput;

/** The procedures the demo implements. Adding one here is the whole change. */
export type DemoProcedures = {
  "entries.list": Handler<Inputs["entries"]["list"], Outputs["entries"]["list"]>;
  "entries.get": Handler<Inputs["entries"]["get"], Outputs["entries"]["get"]>;
  "entries.count": Handler<Inputs["entries"]["count"], Outputs["entries"]["count"]>;
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
  title: string;
  originalTitle: string;
  description: string;
  tagIds: string[];
  fetchFullContent: boolean;
  deleted: boolean;
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

function encodeCursor(position: { key: number; id: string }): string {
  return `${position.key}:${position.id}`;
}

function decodeCursor(cursor: string | undefined): { key: number; id: string } | null {
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

export function createDemoStore(): DemoStore {
  const tags = new Map(DEMO_TAGS.map((tag) => [tag.id, tag]));

  const subscriptions = new Map<string, SubscriptionState>(
    DEMO_SUBSCRIPTIONS.map((sub) => [
      sub.id,
      {
        id: sub.id,
        title: sub.title,
        originalTitle: sub.title,
        description: sub.description,
        tagIds: [sub.tagId],
        fetchFullContent: false,
        deleted: false,
      },
    ])
  );

  const entries = new Map<string, EntryState>(
    DEMO_ENTRIES.map((entry) => [
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

  /** Starred entries stay visible after unsubscribing, like the app. */
  function isVisible(state: EntryState): boolean {
    return subscriptionOf(state) !== undefined || state.starred;
  }

  function matches(state: EntryState, filter: EntryFilter): boolean {
    if (!isVisible(state)) return false;
    const sub = subscriptionOf(state);
    if (filter.subscriptionId !== undefined && sub?.id !== filter.subscriptionId) return false;
    if (filter.tagId !== undefined && !sub?.tagIds.includes(filter.tagId)) return false;
    if (filter.uncategorized && (!sub || sub.tagIds.length > 0)) return false;
    if (filter.type !== undefined && state.entry.type !== filter.type) return false;
    if (filter.excludeTypes?.includes(state.entry.type)) return false;
    if (filter.unreadOnly && state.read) return false;
    if (filter.starredOnly && !state.starred) return false;
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
      subscriptionId: sub?.id ?? null,
      feedId: entry.feedId,
      type: entry.type,
      url: entry.url,
      title: entry.title,
      author: entry.author,
      summary: entry.summary,
      publishedAt: entry.publishedAt,
      fetchedAt: entry.fetchedAt,
      read: state.read,
      starred: state.starred,
      updatedAt: state.updatedAt,
      feedTitle: sub?.title ?? entry.feedTitle,
      siteName: entry.siteName,
    };
  }

  function toFullEntry(state: EntryState): FullEntry {
    const contentCleaned = heroFigureHtml(state.entry) + state.entry.contentHtml;
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
      fetchFullContent: subscriptionOf(state)?.fetchFullContent ?? false,
    };
  }

  function toSubscription(sub: SubscriptionState): Subscription {
    return {
      id: sub.id,
      type: "web",
      url: null,
      title: sub.title,
      originalTitle: sub.originalTitle,
      description: sub.description,
      siteUrl: null,
      subscribedAt: SUBSCRIBED_AT,
      unreadCount: unread({ subscriptionId: sub.id }),
      tags: sub.tagIds.flatMap((id) => {
        const tag = tags.get(id);
        return tag ? [{ id: tag.id, name: tag.name, color: tag.color }] : [];
      }),
      fetchFullContent: sub.fetchFullContent,
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
      subscriptions: subs.map((sub) => ({
        id: sub.id,
        unread: unread({ subscriptionId: sub.id }),
      })),
      tags: tagIds.map((id) => ({ id, unread: unread({ tagId: id }) })),
      uncategorized: subs.some((sub) => sub.tagIds.length === 0)
        ? { unread: unread({ uncategorized: true }) }
        : undefined,
    };
  }

  /** Absolute counts for every list one entry (or one subscription) belongs to. */
  function countsForSubscription(
    sub: SubscriptionState | undefined,
    type: EntryType | undefined
  ): UnreadCounts {
    const { all, starred, saved } = globalCounts();
    return {
      all,
      starred,
      saved: type === "saved" || type === undefined ? saved : undefined,
      subscription: sub ? { id: sub.id, unread: unread({ subscriptionId: sub.id }) } : undefined,
      tags: sub ? sub.tagIds.map((id) => ({ id, unread: unread({ tagId: id }) })) : undefined,
      uncategorized:
        sub && sub.tagIds.length === 0 ? { unread: unread({ uncategorized: true }) } : undefined,
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

  // ---------------------------------------------------------------------------
  // Procedures
  // ---------------------------------------------------------------------------

  const procedures: DemoProcedures = {
    "entries.list": (input) => {
      const sortBy = input.sortBy ?? "published";
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
      const sortKey = (state: EntryState): number =>
        sortBy === "readChanged"
          ? (state.readChangedAt?.getTime() ?? 0)
          : (state.entry.publishedAt ?? state.entry.fetchedAt).getTime();
      const direction = input.sortOrder === "oldest" ? 1 : -1;
      const compare = (a: { key: number; id: string }, b: { key: number; id: string }) =>
        direction * (a.key - b.key) || a.id.localeCompare(b.id);
      const position = (state: EntryState) => ({ key: sortKey(state), id: state.entry.id });

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
      };
    },

    "entries.get": (input) => ({ entry: toFullEntry(requireEntry(input.id)) }),

    "entries.count": (input) => ({
      unread: unread({
        subscriptionId: input?.subscriptionId,
        tagId: input?.tagId,
        uncategorized: bool(input?.uncategorized),
        type: input?.type,
        excludeTypes: input?.excludeTypes,
        starredOnly: bool(input?.starredOnly),
      }),
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
          const sub = subscriptionOf(state);
          if (sub) affected.set(sub.id, sub);
        }
        state.readChangedAt = writtenAt;
        results.push({
          id,
          subscriptionId: subscriptionOf(state)?.id ?? null,
          read: state.read,
          starred: state.starred,
          type: state.entry.type,
          updatedAt: state.updatedAt,
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
      for (const state of targets) {
        state.read = true;
        state.readChangedAt = toDate(input.changedAt, now);
        state.updatedAt = now;
      }
      return { count: targets.length };
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
        counts: flipped
          ? countsForSubscription(subscriptionOf(state), state.entry.type)
          : undefined,
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
    }),

    "subscriptions.list": (input) => {
      const needle = input?.query?.trim().toLowerCase();
      const matching = liveSubscriptions()
        .filter((sub) => input?.tagId === undefined || sub.tagIds.includes(input.tagId))
        .filter((sub) => !input?.uncategorized || sub.tagIds.length === 0)
        .filter((sub) => !input?.unreadOnly || unread({ subscriptionId: sub.id }) > 0)
        .filter((sub) => !needle || sub.title.toLowerCase().includes(needle));
      const after = input?.cursor ? matching.findIndex((s) => s.id === input.cursor) : -1;
      // A cursor that no longer matches (unsubscribed meanwhile) ends the list.
      const start = input?.cursor ? (after === -1 ? matching.length : after + 1) : 0;
      const limit = input?.limit ?? 50;
      const page = matching.slice(start, start + limit);
      return {
        items: page.map(toSubscription),
        nextCursor: start + limit < matching.length ? page[page.length - 1].id : undefined,
      };
    },

    "subscriptions.get": (input) => toSubscription(requireSubscription(input.id)),

    "subscriptions.update": (input) => {
      const sub = requireSubscription(input.id);
      if (input.customTitle !== undefined) {
        sub.title = input.customTitle ?? sub.originalTitle;
      }
      if (input.fetchFullContent !== undefined) {
        sub.fetchFullContent = input.fetchFullContent;
      }
      return toSubscription(sub);
    },

    "subscriptions.setTags": (input) => {
      const sub = requireSubscription(input.id);
      sub.tagIds = input.tagIds.filter((id) => tags.has(id));
      return {};
    },

    "subscriptions.delete": (input) => {
      const sub = requireSubscription(input.id);
      sub.deleted = true;
      return { success: true, counts: countsForSubscriptions([sub]) };
    },

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
