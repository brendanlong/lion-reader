# Source Code Guidelines

- **Two root layouts** (issue #1359): `src/app/(spa)/` (authenticated app + auth/OAuth/utility routes; dynamic, per-request CSP nonce) and `src/app/(public)/` (demo, login, register, terms, privacy; statically prerendered, relaxed static CSP, must render zero user-supplied HTML — see SECURITY.md). Shared document shell: `src/app/root-document.tsx`. Pages in `(public)` must not read `headers()`/`cookies()`/`searchParams` or anything per-request — that silently makes them dynamic again (check `next build` output stays `○`/`●` for them). Deploy-static config CAN be SSR'd there via `createStaticHydrationHelpers` (request-free prefetch): the custom server re-renders those pages once per process startup with runtime env (the revalidate-public hook — see `scripts/server.ts`). Session-aware behavior (the signed-in redirect off `/`, `/login`, `/register`) lives in `src/proxy.ts`, not in the pages. Navigating between the groups is a full page load; within a group, soft nav works as usual.
- Choose between Suspense and inline loading by the criterion below, not by default. Keep components well-factored with small boundaries either way.
- For internal navigation use our link components, never `next/link` or a raw `<a>` (which prefetch aggressively): `<ClientLink>` (`@/components/ui/client-link`) for targets **inside the SPA** (`pushState`, no fetch); `<PageLink>` (`@/components/ui/page-link`) for **standalone routes outside the SPA** (auth/legal pages, demo → sign-in) — the one sanctioned `next/link` wrapper, always `prefetch={false}`. `router.push`/`replace` are fine for programmatic post-mutation redirects. `useParams()` doesn't update on `pushState` — parse dynamic params from the pathname by regex instead.
- **The SPA is mounted twice** — at the root for the app and under `/demo` for the public demo — so its routing/state code is written against **app-relative** paths: read the location through `useAppPathname()` / `useAppSearchParams()` (`@/lib/hooks/useAppLocation`, which also owns the prerendered-location rule), and give `ClientLink`/`clientPush` SPA-relative hrefs (`ClientLink` prefixes the route base itself; `useAppHref()` does it for programmatic pushes). Hooks that only watch the pathname for changes may use `usePathname()` directly.
- **The demo is the real reader tree over canned data**, not a copy of it: `src/app/(public)/demo/DemoApp.tsx` renders `Sidebar` + `UnifiedEntriesContent` with `TRPCProvider links={[createHandlerLink(store)]}` (`@/lib/trpc/handler-link`, the same link the component tests use) resolving every procedure from the in-memory `store.ts`. Anything the demo needs that the app doesn't goes through a generic seam, not a demo branch in a shared component: `EntryContentOptions` (reader slots, hide narration, SSR date zone), `AppLocationProvider` (route base + prerendered location), `PrerenderedCacheProvider` (lets the cache-gated components render seeded data during SSR). The static-rendering constraints (`force-static`, the `?entry=` rewrite) are explained in `src/app/(public)/demo/layout.tsx`.
- **localStorage-backed preferences read through `useSyncExternalStore`** with a `getServerSnapshot` that returns the default (see `useSidebarUnreadOnly`). Pages are SSR'd, so reading storage in a `useState` initializer or an effect makes the server HTML and the hydration render disagree for every user who changed the setting (#1552). The default is the value until hydration finishes — don't add an `isLoading`/"mounted" flag to paper over it.
- Crossing an auth boundary is the intentional hard nav (`window.location.href` on logout, account deletion, the session-rejected/signup-confirmation redirects, and the sign-in round-trip back into `/save`): the full reload wipes the per-user in-memory caches — don't make it a soft nav. Those sites carry an inline disable for `@next/next/no-location-assign-relative-destination`, which is only a partial tripwire — it sees `location.href =` and `location.assign()` but not `location.replace()`, so justify one of those yourself. (Why we don't hard-nav more broadly / CDN-cache HTML: `docs/DEPLOYMENT.md`.)

## Suspense vs. inline loading

Suspense's 300ms `FALLBACK_THROTTLE_MS` makes interaction-triggered swaps on a warm cache feel laggy (the committed fallback is held even when data is ready).

- **Page-load / persistent-shell data** (route first render, sidebar counts, `fallback={null}`): `useSuspenseQuery` + `<Suspense>`.
- **Interaction-triggered swaps usually served from cache** (open entry, switch list view, route titles): `useQuery` + an inline `if (isLoading) return <Fallback/>`, with `throwOnError: true` to keep the `ErrorBoundary`, and keep the server prefetch. A hand-written cache-reading "smart fallback" means use this, not Suspense. See `EntryContent` / `EntryListContainer`.

## Frontend State Management

When working on queries, mutations, or cache invalidation, read and update **`src/FRONTEND_STATE.md`** (deliberately not `@`-inlined — read it when relevant).

This document lists all tRPC queries and mutations, their invalidation patterns, and how they interact across components. It must be kept in sync when:

- Adding new queries or mutations
- Changing cache invalidation patterns
- Adding optimistic updates or direct cache updates
- Modifying SSE event handling

The goal is to maintain cache consistency across the app. All mutations should properly invalidate related queries so the UI stays in sync with the server.
