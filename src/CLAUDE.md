# Source Code Guidelines

- Choose between Suspense and inline loading by the criterion below, not by default. Keep components well-factored with small boundaries either way.
- Never use Next.js's `<Link>` for internal navigation (nor a raw `<a>`) — `<Link>` triggers the RSC soft-nav/prefetching we don't want. Pick by whether the target is inside the SPA:
  - **Inside the SPA shell** (the `(app)` routes, the demo's own views): `<ClientLink>` from `@/components/ui/client-link` — client-only pushState nav, no SSR fetch.
  - **Standalone routes outside the SPA** (auth pages, public legal pages, demo → sign-in/up): `<PageLink>` from `@/components/ui/page-link` — a plain full-page `<a>` that loads the target document with no RSC request.
- Avoid `useRouter` for navigation for the same reason; it's fine for post-mutation redirects (e.g. into the app after login) where a real router transition is intended. But a programmatic redirect **to** a CDN-cacheable public page (`/login`, `/register`, `/privacy`, `/terms`, the OAuth pages) must be a hard navigation, not a `router.push` — a soft-nav into a cached page issues an `?_rsc=` request that can hit a newer server build and version-skew. Authenticated routes (the app SPA, and standalone-but-auth-only pages like `/complete-signup`, which is never served cookie-less so never cached) are safe to soft-nav. Use `navigateAfterAuth(router, path)` from `@/lib/navigation` for post-auth redirects whose target may be either kind; it soft-navigates safe paths and hard-navigates the cacheable public ones (`isSpaPath` decides).

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
