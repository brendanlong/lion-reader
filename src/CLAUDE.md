# Source Code Guidelines

- Choose between Suspense and inline loading by the criterion below, not by default. Keep components well-factored with small boundaries either way.
- Never use `next/link` directly, and never hand-roll a raw `<a>` for an internal href. The prefetching Next's `<Link>` does by default is the thing we're avoiding — an app full of unbounded `?_rsc=` prefetches. Pick a link by whether the target is inside the SPA:
  - **Inside the SPA shell** (the `(app)` routes, the demo's own views): `<ClientLink>` from `@/components/ui/client-link` — client-only `pushState` nav, no server fetch at all (renders from the client cache).
  - **Standalone routes outside the SPA** (auth pages, public legal pages, demo → sign-in/up): `<PageLink>` from `@/components/ui/page-link`. This is the **one** sanctioned wrapper around `next/link`, always with `prefetch={false}` — a soft RSC nav on click, but no viewport/hover prefetch (App Router `prefetch={false}` disables both). `pushState` can't cross a route-group boundary, so entering/leaving the SPA needs this RSC nav rather than `ClientLink`.
- Avoid `useRouter` for navigation for the same reason; it's fine for post-mutation redirects (e.g. into the app after login) where a real router transition is intended. `router.push`/`replace` are soft navs with no prefetch, so they're also fine for programmatic redirects to standalone pages (the OAuth flows redirect to `/login`/`/complete-signup` this way).
- **Logout is the one deliberate hard navigation.** `AppLayoutContent`'s logout does `window.location.href = "/login"` (a full document load), because the reload is what wipes the module-level per-user singletons (the browser `QueryClient`, the subscription lookup map) so the next account on the tab can't be served the previous user's data. Don't turn it into a soft nav.

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
