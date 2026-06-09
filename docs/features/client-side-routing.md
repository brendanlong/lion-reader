# Client-Side Routing Architecture

## Overview

Lion Reader uses Next.js App Router for initial page loads only. After hydration, all
in-app navigation is **shallow routing**: `window.history.pushState`/`replaceState` update
the URL, and a single client component tree re-derives what to render from `usePathname()`
and `useSearchParams()`. No server request of any kind is made on navigation; data comes
from the React Query cache, which is kept fresh by SSE delta sync.

This document records the investigation requested in
[issue #872](https://github.com/brendanlong/lion-reader/issues/872) ("custom SPA router
bolted on top of Next App Router"): what the pattern is, what constraints it satisfies,
whether native App Router navigation could satisfy them, and the resulting decision.

**Decision: keep the current architecture.** It is Next.js's documented
[SPA / shallow-routing pattern](https://nextjs.org/docs/app/guides/single-page-applications),
not a fork of the framework's router, and native navigation cannot meet the
zero-roundtrip-navigation constraint that motivated it.

## How It Works

### Components

| Piece                                              | Location                                           | Role                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientPush` / `clientReplace` / `handleClientNav` | `src/lib/navigation.ts`                            | Thin wrappers over `history.pushState`/`replaceState`                                                                                                    |
| `ClientLink`                                       | `src/components/ui/client-link.tsx`                | Real `<a href>` (middle-click, cmd-click, crawlers work) that intercepts plain clicks and calls `clientPush`                                             |
| `AppRouter`                                        | `src/components/app/AppRouter.tsx`                 | Switches on `usePathname()` between three sections: `UnifiedEntriesContent`, `UnifiedSettingsContent`, `SubscribeContent`                                |
| `UnifiedEntriesContent`                            | `src/components/entries/UnifiedEntriesContent.tsx` | Derives route info (view, filters, titles) from the pathname; renders all entry-list views                                                               |
| `useEntryUrlState`                                 | `src/lib/hooks/useEntryUrlState.ts`                | Open/close entries via `?entry=<id>` search param, with push-on-open / `history.back()`-on-close semantics                                               |
| `page.tsx` files                                   | `src/app/(app)/**/page.tsx`                        | **Initial-load prefetch only.** Their rendered output is hidden by the layout (`<div className="hidden">{children}</div>` in `src/app/(app)/layout.tsx`) |

### Initial load vs. navigation

- **Initial load** (full page request): the server layout authenticates, prefetches common
  queries (sidebar counts, tags, preferences) via tRPC hydration helpers, and the
  route-specific `page.tsx` prefetches route-specific data (e.g. `entries.list` for the
  current filters). Dehydrated queries stream to the client, so first paint still benefits
  from streaming SSR + Suspense.
- **Navigation** (after hydration): `clientPush` updates the URL. Next.js's router
  integrates with `pushState` — `usePathname()`/`useSearchParams()` update — so
  `AppRouter`/`UnifiedEntriesContent` re-render with new filters. React Query serves data
  from cache (`staleTime: Infinity`; SSE events update the cache). **Zero HTTP requests**
  in the common case; at most one tRPC call for data not yet cached.

### Known sharp edges

- `useParams()` does **not** update on `pushState` (it is tied to Next's route-tree
  reconciliation, which shallow routing intentionally skips). Dynamic params are therefore
  parsed by regex: `extractParamsFromPathname` in `UnifiedEntriesContent.tsx`, with a
  parallel copy in `src/app/demo/DemoRouter.tsx`.
- Using Next's `<Link>` or `router.push()` anywhere in the app shell would silently
  reintroduce per-navigation RSC fetches. This is why `src/CLAUDE.md` mandates
  `ClientLink` for internal navigation.
- The hidden-`{children}` trick in the app layout is surprising on first read; the
  `page.tsx` files look like dead code but are load-bearing for initial-load prefetch.
- `src/app/demo/*` reimplements the pattern (`DemoRouter`) with in-memory state instead of
  tRPC. This duplication is deliberate — the demo is unauthenticated and must not share
  the real data layer — but it doubles the routing surface.

## Constraints the Pattern Satisfies

1. **Zero-latency view/article switching.** The original motivation: switching between
   views or articles should cost at most one tRPC request — usually zero, served from the
   React Query cache. There is no RSC payload fetch, no server roundtrip, no remount of
   the section component (it re-renders with new props).
2. **A fully client-owned data layer.** All data flows through React Query, kept
   consistent by SSE delta sync (`RealtimeProvider`) and the invalidation rules in
   `src/FRONTEND_STATE.md`. A second server-driven cache (Next's router cache) would
   duplicate this with no integration: SSE events can invalidate React Query but cannot
   invalidate Next's per-URL RSC cache.
3. **Persistent shell state.** Scroll container, sidebar state, keyboard-shortcut context,
   SSE connection, and the query cache all live above `AppRouter` in
   `AppLayoutContent.tsx` and survive navigation.
4. **Offline navigation.** The app ships as a PWA with offline support. Shallow routing
   works offline because navigation never requires the network; per-navigation RSC
   fetches would not.

Note: the narration player is _not_ a constraint — it mounts inside the entry content and
remounts per entry, so it would behave the same under native routing.

## Evaluation: Could Native App Router Navigation Meet These?

| Concern              | Native App Router behavior                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation latency   | `router.push` fetches the target page's RSC payload from the server. All `(app)` routes are dynamic (auth-gated), and Next 15+ defaults the client router cache to `staleTimes.dynamic = 0`, so effectively **every navigation is a server roundtrip** — exactly the cost this design exists to avoid. The payload carries no useful data: the page output is the hidden prefetch shell. |
| Router cache tuning  | `experimental.staleTimes` can re-enable client caching, but the cache is keyed per URL (each subscription/tag/entry-param combination is a separate entry), and it cannot be invalidated by our SSE events — so it would serve stale shells or be useless, while React Query remains the actual source of truth.                                                                         |
| Prefetching          | `<Link>` prefetches RSC payloads for every link entering the viewport. The sidebar can contain hundreds of subscription/tag links; this is pure server load for payloads we'd never use. (`prefetch={false}` avoids it but then every click pays full latency.)                                                                                                                          |
| State preservation   | Layout-held state would survive (layouts persist across native navigation), but page components remount per navigation, losing list/component state that currently persists because the same component re-renders in place.                                                                                                                                                              |
| Params / conventions | `useParams()`, `error.tsx`, `loading.tsx`, per-route metadata would work natively. This is the main thing we give up — and it is reimplemented today in ~100 lines (regex params, `ErrorBoundary`, Suspense fallbacks).                                                                                                                                                                  |
| Code splitting       | Native routing would code-split entries/settings/subscribe per route. Today all three unified sections ship in one client bundle. If bundle size becomes a problem, `next/dynamic` on `UnifiedSettingsContent`/`SubscribeContent` recovers most of the win without changing routing.                                                                                                     |
| Streaming SSR        | Not actually forfeited where it matters: initial loads (the only full-page renders) stream dehydrated queries through Suspense boundaries today. Native navigation would add streaming for _transitions_, but a cache-served client render is faster than any streamed response.                                                                                                         |

### Verdict

The pattern is not "fighting the framework" — `pushState` + `usePathname` is the approach
Next.js's own SPA guide prescribes, and the `useParams` limitation is a documented
property of shallow routing. The one constraint native routing cannot satisfy is the core
one: **navigation without a server roundtrip, backed by a client cache that SSE can keep
consistent.** Migrating would trade ~100 lines of hand-rolled routing for a per-navigation
RTT (50–200ms+ to a single-region Fly.io deployment), redundant RSC payloads, an
unmanageable second cache layer, and broken offline navigation.

### Accepted costs

- No per-route code splitting between the three unified sections (mitigable with
  `next/dynamic` if measured to matter).
- Hand-rolled error/loading/params handling instead of Next file conventions.
- The non-obvious hidden-`{children}` prefetch indirection (now documented here).
- The demo's parallel `DemoRouter` implementation.
- Discipline requirement: internal navigation must use `ClientLink`, never `<Link>`/
  `router.push` (enforced by convention in `src/CLAUDE.md`).

### Possible incremental improvements (optional, no urgency)

- Share `extractParamsFromPathname` between `UnifiedEntriesContent` and `DemoRouter`.
- Lazy-load `UnifiedSettingsContent` and `SubscribeContent` via `next/dynamic` to recover
  code splitting for the rarely-used sections.

## Revisit Triggers

Reconsider this decision if any of these change:

- Next.js ships router-cache invalidation hooks that could integrate with SSE/React Query
  (making the RSC cache coherent with our data layer).
- The app moves to multi-region or edge rendering, making RSC roundtrips cheap enough to
  not matter (~<20ms).
- The client bundle grows enough that per-route code splitting becomes necessary and
  `next/dynamic` proves insufficient.
