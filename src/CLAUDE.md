# Source Code Guidelines

- **Two root layouts** (issue #1359): `src/app/(spa)/` (authenticated app + auth/OAuth/utility routes; dynamic, per-request CSP nonce) and `src/app/(public)/` (demo, login, register, terms, privacy; statically prerendered at build time, relaxed static CSP, must render zero user-supplied HTML — see SECURITY.md). Shared document shell: `src/app/root-document.tsx`. Pages in `(public)` must not read `headers()`/`cookies()`/`searchParams` or anything per-request — that silently makes them dynamic again (check `next build` output stays `○`/`●` for them). Navigating between the groups is a full page load; within a group, soft nav works as usual.
- Choose between Suspense and inline loading by the criterion below, not by default. Keep components well-factored with small boundaries either way.
- For internal navigation use our link components, never `next/link` or a raw `<a>` (which prefetch aggressively): `<ClientLink>` (`@/components/ui/client-link`) for targets **inside the SPA** (`pushState`, no fetch); `<PageLink>` (`@/components/ui/page-link`) for **standalone routes outside the SPA** (auth/legal pages, demo → sign-in) — the one sanctioned `next/link` wrapper, always `prefetch={false}`. `router.push`/`replace` are fine for programmatic post-mutation redirects.
- Logout is the one intentional hard nav (`window.location.href` in `AppLayoutContent`): the full reload wipes the per-user in-memory caches — don't make it a soft nav. (Why we don't hard-nav more broadly / CDN-cache HTML: `docs/DEPLOYMENT.md`.)

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
