# Frontend Guidelines

- **Two root layouts** (#1359), sharing `src/app/root-document.tsx`; moving between them is a full page load.
  - `src/app/(spa)/`: the authenticated app plus auth/OAuth/utility routes. Dynamic, with a per-request CSP nonce.
  - `src/app/(public)/`: demo, login, register, terms, privacy. Statically prerendered with a relaxed CSP, so it **must render zero user-supplied HTML** (SECURITY.md §1), and its pages must not read `headers()`/`cookies()`/`searchParams` or anything per-request, which silently makes them dynamic again (check `next build` still shows `○`/`●`). Deploy-time config can still be SSR'd via `createStaticHydrationHelpers` (`scripts/server.ts` re-renders these pages at startup). The signed-in redirect off `/`, `/login`, `/register` lives in `src/proxy.ts`, not the pages.
- **Internal links**: never `next/link` or a raw `<a>` (they prefetch aggressively). Use `<ClientLink>` for targets inside the SPA (`pushState`, no fetch) and `<PageLink>` (always `prefetch={false}`) for standalone routes outside it. `router.push`/`replace` are fine for post-mutation redirects. `useParams()` doesn't update on `pushState` — parse params from the pathname.
- **The SPA is mounted twice** — at the root and under `/demo` — so routing/state code uses **app-relative** paths: read the location with `useAppPathname()` / `useAppSearchParams()` (`@/lib/hooks/useAppLocation`) and give `ClientLink`/`clientPush` SPA-relative hrefs (`useAppHref()` for programmatic pushes). Hooks that only watch for pathname changes may use `usePathname()`.
- **The demo is the real reader tree over canned data** (`src/app/(public)/demo/DemoApp.tsx`, procedures resolved from the in-memory `store.ts` through the handler link). Anything the demo needs goes through a generic seam (`EntryContentOptions`, `AppLocationProvider`, `PrerenderedCacheProvider`), never a demo branch in a shared component.
- **localStorage-backed preferences read through `useSyncExternalStore`** whose `getServerSnapshot` returns the default (`createStoredBoolean` for booleans). Reading storage in a `useState` initializer or effect makes SSR and hydration disagree (#1552). Don't add a "mounted" flag to paper over it.
- **Crossing an auth boundary is a deliberate hard navigation** (logout, account deletion, the session-rejected/signup-confirmation redirects, the sign-in round-trip into `/save`) so the reload wipes per-user in-memory caches — don't make it a soft nav. Those sites disable `@next/next/no-location-assign-relative-destination` inline; that rule doesn't see `location.replace()`, so justify one of those yourself.
- **Queries, mutations, cache updates, SSE**: `src/FRONTEND_STATE.md` is the contract — read and update it. This code must be tested, not just reviewed (`tests/CLAUDE.md`).

## Suspense vs. inline loading

Suspense holds a committed fallback for at least 300ms (`FALLBACK_THROTTLE_MS`) even when data is ready, which makes interaction-triggered swaps on a warm cache feel laggy.

- **Page-load / persistent-shell data** (route first render, sidebar counts, `fallback={null}`): `useSuspenseQuery` + `<Suspense>`.
- **Interaction-triggered swaps usually served from cache** (open entry, switch list view, route titles): `useQuery` + inline `if (isLoading) return <Fallback/>`, with `throwOnError: true` to keep the `ErrorBoundary`, and keep the server prefetch. A hand-written cache-reading fallback means this pattern. See `EntryContent` / `EntryListContainer`.
