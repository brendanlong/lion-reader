# Testing Guidelines (`tests/`)

This file governs the test suites: `tests/unit/` (pure logic, no mocks, no DB), `tests/integration/` (real Postgres/Redis via docker-compose), and `tests/e2e/` (Playwright against a real app server).

Philosophy: structure code so business logic is pure and unit-testable without mocks. **No mocks of internal code** — refactor if mocking is needed. Integration tests use real databases. (The intended-behavior/skipped-test rule is in the root CLAUDE.md "Code Quality" section.)

## Frontend Testing

The realtime SSE/cache-update code is the hardest part of the app to verify by review — always test it instead:

- **Cache logic** (`src/lib/cache/`): pure functions, unit-tested in `tests/unit/frontend/cache/` against a real `QueryClient` and real tRPC query utils built by `createRealTrpcUtils` in `tests/utils/cache-test-helpers.ts` (no internal mocks). Add cases there when changing cache operations or event handling.
- **Connection management** (`src/lib/events/connection-state.ts`, `cursors.ts`): pure state machine + cursor bookkeeping behind `useRealtimeUpdates`, unit-tested in `tests/unit/frontend/events/` (reconnect backoff, polling fallback on 503, visibility handling). Change the machine, not the hook glue, when adjusting connection behavior.
- **Component ↔ tRPC integration** (components that embed `useQuery`/`useMutation`): rendered in jsdom via `renderWithTrpc` in `tests/utils/component-test-helpers.tsx`, which wraps the component in the real `trpc.Provider` + `QueryClientProvider` but swaps the HTTP link for a terminating **mock link** that resolves each procedure from a `{ "router.procedure": handler }` map (no MSW, no internal mocks). The returned `calls`/`callsFor(path)` let a test assert which procedures ran with which input. See `tests/unit/frontend/components/{EntryContent,EditSubscriptionDialog,Sidebar}.test.tsx`. Because there's no HTTP layer, handler return values reach hooks un-serialized (Dates stay Dates); provide handlers for **every** procedure the subtree issues (unhandled paths error loudly).
- **SSE → cache → UI pipeline**: covered by `tests/e2e/` Playwright tests, which seed the test DB directly, publish real Redis pub/sub events, and assert the UI updates **without** refetching (`recordTrpcProcedures` in `tests/e2e/helpers.ts`). When changing the realtime flow, run `pnpm test:e2e` and add scenarios using those helpers.
- **The minimal-request invariant**: SSE events must patch the React Query cache directly, never trigger `entries.*` refetches. `src/FRONTEND_STATE.md` is the contract for which queries get direct updates vs invalidation — read and update it when changing queries, mutations, or SSE handling.

## End-to-End Tests (Playwright)

`pnpm test:e2e` runs `tests/e2e/` against a real app server started automatically on port 4983 (override with `E2E_PORT`) using the test database from `.env.test`. Requires the docker-compose Postgres and Redis services, like the integration tests (or `pnpm services` + `pnpm test:e2e:local` — see root CLAUDE.md). In CI, e2e tests run against the production build (`next build` + `node dist/server.js`), not the dev server.

Key design points:

- **No UI login flow**: tests seed users/feeds/entries directly in the database (`tests/e2e/helpers.ts`) and authenticate by inserting a session row and setting the `session` cookie.
- **Real event pipeline**: tests publish events through the same `src/server/redis/pubsub.ts` functions the worker uses, exercising Redis → SSE endpoint → EventSource → `handleSyncEvent` → cache → UI. `waitForChannelSubscriber` polls `PUBSUB NUMSUB` to avoid publishing before the SSE handler is listening.
- **Minimal-request assertions**: `recordTrpcProcedures(page)` records every tRPC procedure the page calls. Tests assert that SSE events update the UI with _zero_ `entries.*` refetches — this encodes the delta-update invariant documented in `src/FRONTEND_STATE.md` as a regression test instead of a code-review concern.
- **Isolation**: each test creates its own user and feeds (unique IDs), so tests don't interfere with each other or with leftover data; the suite runs serially against one shared server.

## Manual verification

Use the Playwright MCP browser tools (`mcp__Playwright__browser_*`) if available — navigate, take accessibility snapshots, click, and screenshot interactively against a dev server (or https://lionreader.com/demo for auth-free checks). `pnpm test:e2e` starts the app server on port 4983 against the test database; you can also seed data with the helpers and inspect pages with Playwright directly.
