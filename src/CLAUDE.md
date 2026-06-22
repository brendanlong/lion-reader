# Source Code Guidelines

- Choose between Suspense and inline loading by the criterion below, not by default. Keep components well-factored with small boundaries either way.
- Always use client-only navigation. Don't use Next.js's `<Link>` or `useRouter` - they trigger SSR fetches and prefetching we don't want. Use `<ClientLink>` from `@/components/ui` for internal navigation instead.

## Suspense vs. inline loading

Suspense's 300ms `FALLBACK_THROTTLE_MS` makes interaction-triggered swaps on a warm cache feel laggy (the committed fallback is held even when data is ready).

- **Page-load / persistent-shell data** (route first render, sidebar counts, `fallback={null}`): `useSuspenseQuery` + `<Suspense>`.
- **Interaction-triggered swaps usually served from cache** (open entry, switch list view, route titles): `useQuery` + an inline `if (isLoading) return <Fallback/>`, with `throwOnError: true` to keep the `ErrorBoundary`, and keep the server prefetch. A hand-written cache-reading "smart fallback" means use this, not Suspense. See `EntryContent` / `EntryListContainer`.

## Frontend State Management

When working on queries, mutations, or cache invalidation, read and update:

**@src/FRONTEND_STATE.md**

This document lists all tRPC queries and mutations, their invalidation patterns, and how they interact across components. It must be kept in sync when:

- Adding new queries or mutations
- Changing cache invalidation patterns
- Adding optimistic updates or direct cache updates
- Modifying SSE event handling

The goal is to maintain cache consistency across the app. All mutations should properly invalidate related queries so the UI stays in sync with the server.
