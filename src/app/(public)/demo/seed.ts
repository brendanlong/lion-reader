/**
 * Pre-seeds the React Query cache for a demo location so the prerendered HTML
 * carries the real list/article content.
 *
 * Mirrors what `EntryListPage` and the app layout prefetch for a route
 * (sidebar counts + tags, the route's entry list, the open entry, the
 * subscription title), resolved synchronously from the demo store instead of
 * streamed from the server. The result is a dehydrated state for
 * `<HydrationBoundary>`; because the store is deterministic, the server render
 * and the client's hydration render hydrate identical data (the contract behind
 * `PrerenderedCacheProvider`). Seeding also applies the open entry's
 * auto-mark-read to the store, so call it once per store, before rendering.
 */

"use client";

import { QueryClient, dehydrate, type DehydratedState } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import superjson from "superjson";
import { trpc } from "@/lib/trpc/client";
import type { AppLocation } from "@/lib/hooks/useAppLocation";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";
import {
  buildEntriesListInput,
  getDefaultViewPreferences,
  getFiltersFromPathname,
} from "@/lib/queries/entries-list-input";
import type { DemoStore } from "./store";

export function buildDemoDehydratedState(store: DemoStore, location: AppLocation): DehydratedState {
  const { procedures } = store;
  // Serialize with superjson so the browser QueryClient (configured to
  // deserialize hydrated data with it) gets Dates back as Dates.
  const queryClient = new QueryClient({
    defaultOptions: { dehydrate: { serializeData: superjson.serialize } },
  });

  // Same input derivation as the server prefetch, so the key matches the
  // client's useInfiniteQuery exactly.
  const searchParams = new URLSearchParams(location.search);
  const filters = getFiltersFromPathname(location.pathname);
  const defaults = getDefaultViewPreferences(location.pathname);
  const { unreadOnly, sortOrder, searchQuery } = parseViewPreferencesFromParams(searchParams, {
    unreadOnly: defaults.unreadOnly,
  });
  const listInput = buildEntriesListInput(filters, { unreadOnly, sortOrder, searchQuery });
  const listPage = procedures["entries.list"](listInput);

  // An open entry is seeded the way the reader leaves it after mounting: the
  // list was fetched with the entry unread (so unread-only views include it),
  // then the auto-mark-read mutation ran — marking it read in the store and
  // patching the cached list row in place. Seeding that end state means the
  // read toggle and the counts don't flip after hydration.
  const entryId = searchParams.get("entry");
  if (entryId) {
    procedures["entries.markRead"]({ entries: [{ id: entryId }], read: true });
    queryClient.setQueryData(
      getQueryKey(trpc.entries.get, { id: entryId }, "query"),
      procedures["entries.get"]({ id: entryId })
    );
  }
  queryClient.setQueryData(getQueryKey(trpc.entries.list, listInput, "infinite"), {
    pages: [
      {
        ...listPage,
        items: listPage.items.map((item) => (item.id === entryId ? { ...item, read: true } : item)),
      },
    ],
    pageParams: [null],
  });

  if (filters.subscriptionId) {
    queryClient.setQueryData(
      getQueryKey(trpc.subscriptions.get, { id: filters.subscriptionId }, "query"),
      procedures["subscriptions.get"]({ id: filters.subscriptionId })
    );
  }

  // Sidebar data, after the mark-read above so the counts match.
  queryClient.setQueryData(
    getQueryKey(trpc.tags.list, undefined, "query"),
    procedures["tags.list"]()
  );
  for (const input of [{}, { starredOnly: true }, { type: "saved" as const }]) {
    queryClient.setQueryData(
      getQueryKey(trpc.entries.count, input, "query"),
      procedures["entries.count"](input)
    );
  }
  queryClient.setQueryData(
    getQueryKey(trpc.summarization.isAvailable, undefined, "query"),
    procedures["summarization.isAvailable"]()
  );

  return dehydrate(queryClient);
}
