# Testing (`tests/`)

- `tests/unit/`: pure logic, no DB. `tests/integration/`: real Postgres/Redis. `tests/e2e/`: Playwright against a real app server (port 4983, `E2E_PORT` to override; CI runs it against the production build). Integration and e2e need the docker-compose services, or `pnpm services` + the `:local` scripts.
- **No mocks of internal code** — structure logic to be pure, or refactor until it is.
- **Test the live path, not a lookalike.** A test is not a reason for code in `src/` to exist (`pnpm knip:production` fails on it): assert against what production calls and delete the stray helper. Query helpers that only read rows back for assertions belong in the test file.
- Seed integration rows with the factories in `tests/integration/helpers.ts`; extend one rather than writing a local `db.insert`.
- Assert on Redis pub/sub with `tests/utils/pubsub.ts`. A test whose **setup** mutates through a service or tRPC caller must use `subscribeAndDrain`, never subscribe afterwards — the setup's own event can land inside the window under test (#1427).

## Frontend: test it, don't just review it

The realtime SSE/cache code is the hardest part of the app to verify by reading. **SSE events must update the local store and caches directly, never trigger `entries.*` refetches** (`src/FRONTEND_STATE.md`), and the e2e suite enforces that with `recordTrpcProcedures`.

- **Cache and local store** (`src/lib/cache/`, `src/lib/local-db/`): `tests/unit/frontend/{cache,local-db}/`, against a real `QueryClient` (`createRealTrpcUtils`) and the real store. Assert list contents through the hooks components use (`useEntryListEntries` via `renderHookWithTrpc`), not by re-deriving order.
- **Connection management** (`src/lib/events/`): pure state machines, tested in `tests/unit/frontend/events/`. Change the machines, not the hook glue.
- **Components with queries/mutations**: `renderWithTrpc` (`tests/utils/component-test-helpers.tsx`) swaps the HTTP link for the handler link the demo uses. Provide a handler for **every** procedure the subtree calls; results arrive un-serialized (Dates stay Dates). `DemoReader.test.tsx` exercises the whole reader through the demo store.
- **SSE → cache → UI**: e2e tests seed the DB directly (no UI login: they insert a session and set the cookie), publish through the same `src/server/redis/pubsub.ts` functions the worker uses (after `waitForChannelSubscriber`), and assert the UI updates with zero `entries.*` refetches. Each test creates its own user; the suite runs serially against one server.

For manual checks, the Playwright MCP tools can drive a dev server or https://lionreader.com/demo.
