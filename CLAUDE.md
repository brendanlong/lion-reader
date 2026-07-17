# Lion Reader Development Guidelines

## Documentation Map

Deep subsystem knowledge lives in per-directory `CLAUDE.md` files (loaded automatically when you work on files there) — aggressively keep them, this file, and `docs/DESIGN.md` up-to-date if you notice anything outdated:

- `SECURITY.md` - Map of the **security-critical** code (XSS/SSRF/auth/cross-user isolation) and the invariant each area must uphold. **Reviewers and anyone touching auth, sanitization, outbound fetches, the compat/OAuth/MCP APIs, or cross-user data paths must read it first.**
- `docs/DESIGN.md` - High-level architecture and design decisions. **Read it before design/architecture work** (deliberately not `@`-inlined).
- `docs/diagrams/` - D2 flow diagrams for the major systems; great for orienting quickly.
- `docs/references/` - Reference docs for external tools. Consult before editing related configs.
- `docs/DEPLOYMENT.md` - Fly.io deployment/provisioning guide.
- Per-directory guides: `src/server/CLAUDE.md` (data model, services, compat-API ids), `src/server/html/CLAUDE.md` (sanitization), `src/server/feed/CLAUDE.md` (fetching/WebSub), `src/server/auth/CLAUDE.md` (sessions/scopes), `src/server/oauth/CLAUDE.md` (OAuth server/MCP auth), `src/server/http/CLAUDE.md` (SSRF-safe fetching), `src/CLAUDE.md` + `src/components/CLAUDE.md` (frontend), `tests/CLAUDE.md` (testing).

ALWAYS read the relevant documentation before working.

## Commands

- `pnpm build:native` - Build the native Rust modules (sanitizer, readability, feed-parser). **Required once per checkout before tests or the app** — if tests fail with "Failed to load the native …", run this. Needs the Rust toolchain (`cargo` — if missing from PATH, try `~/.cargo/bin`). The SessionStart hook starts it in the background, so it may already be done or in flight (log: `/tmp/lion-reader-build-native.log`).
- `pnpm typecheck` - Run before committing (no `any`, no `@ts-ignore`)
- `pnpm test:unit` - Pure logic tests (fast, no DB)
- `pnpm test:integration` - Backend tests against real Postgres/Redis (docker-compose)
- `pnpm test:e2e` - Playwright browser tests against a real app server (docker-compose)

## Local Services (no Docker)

If you can't run `docker compose` or reach the shared dev databases (common in
sandboxed agent environments), **don't hand-roll Postgres**. Use `pnpm services`,
which starts a throwaway Postgres + Redis from the native binaries on **random
free ports**, runs migrations, and writes two gitignored env files
(`.env.local-services`, `.env.local-services.test`). See `scripts/local-services.sh`.

Run it as a **background task** so it's torn down when your session ends — on exit
it stops both servers and deletes its temp dir + env files:

```bash
pnpm services            # run in the BACKGROUND; leave it running
```

Then, in the foreground, use the `*:local` variants (they layer the generated env
file over `.env.test` so it wins, via `dotenv -o`):

```bash
pnpm test:integration:local      # integration tests against the local DBs
pnpm test:e2e:local              # e2e tests against the local DBs
pnpm db:migrate:local            # re-run migrations (e.g. after adding one)
PORT=<random> pnpm dev:local     # dev app (web + worker) — open http://<host>:<PORT>
```

Notes:

- `pnpm services` prints the chosen ports and a ready-to-copy `dev:local` command
  with a random `PORT`. Pick a random port for the app too — this is a shared host.
- `dev:local` runs only the web server + worker (no Discord bot). Unit tests
  (`pnpm test:unit`) need no DB and are unaffected.
- These env files are throwaway and auto-removed; never commit them.

## Code Quality

- **Types**: Explicit types everywhere; use Zod for runtime validation
- **Queries**: Avoid N+1 queries; use joins or batch fetching
- **UI**: Use optimistic updates for responsive UX
- **DRY**: Deduplicate logic that must stay in sync; don't merge code that merely looks similar but serves independent purposes
- Always write tests for the intended behavior of functions, not the actual behavior. If the actual behavior is wrong and the issue is pre-existing, write the test correctly, mark it skipped, and file a GitHub issue on brendanlong/lion-reader (labels: `bug`, `reported-by-claude`)
- Don't create barrel files, prefer direct imports within our code

## Testing

See `tests/CLAUDE.md` for the testing playbook — especially before touching the realtime SSE/cache-update code, which must be tested, not reviewed. `src/FRONTEND_STATE.md` is the contract for queries/mutations/cache updates.

## UI Components

See `src/components/CLAUDE.md` for UI component guidelines, available components, and icons.

## Git

- Break work into commit-sized chunks; commit when finished
- Use amend commits when it makes sense (ALWAYS check the current commit before amending)
- Main branch: `master`
- Commit `migrations/schema.sql` changes separately if unrelated to current work

## GitHub Issues

When you mention GitHub issues:

1. **Fetch the issues** - Use the GitHub API to list issues: `https://api.github.com/repos/brendanlong/lion-reader/issues`
2. **Read relevant issues** - Fetch detailed issue content via the API to understand requirements and discussion
3. **Reference in commits** - Include issue numbers in commit messages (e.g., "Fix: prevent over-fetching slow feeds (#175)") when applicable

## Project Structure

```
src/server/
  trpc/routers/  # tRPC API endpoints
  services/      # Reusable business logic (shared across APIs)
  db/            # Database schemas and client
  jobs/          # Background job queue
  plugins/       # Content source plugins (LessWrong, Google Docs, ArXiv, GitHub)
  mcp/           # MCP server
src/lib/         # Shared utilities (client and server)
src/components/  # React components
src/app/         # Next.js routes
tests/unit/      # Pure logic tests (no mocks, no DB)
tests/integration/ # Real DB via docker-compose (no mocks)
tests/e2e/       # Playwright browser tests (real server + DB + Redis)
```

## Database Conventions

- **IDs**: UUIDv7, generated in TypeScript via `generateUuidv7()` from `@/lib/uuidv7`. `gen_uuidv7()` is not available in our Postgres version.
- **Timestamps**: `timestamptz`, store UTC. Read as JS `Date` (millisecond precision) by default. Where microseconds matter — keyset cursors built from timestamps — use the `temporalTimestamp` Drizzle column type or `parseTimestamptz` from `src/server/db/temporal.ts` (see "Ordering & Pagination Mechanics" in `src/server/CLAUDE.md`; #680, #683).
- **Soft deletes**: Use `deleted_at`/`unsubscribed_at` patterns
- **Upserts**: Prefer `onConflictDoNothing()`/`onConflictDoUpdate()` over check-then-act
- **Migrations**: Must be backward-compatible with the previous release (expand/contract) — they run in Fly's `release_command` before the canary deploy, so old code runs against the new schema during rollout and on rollback. See "Migration Compatibility" in docs/DESIGN.md.
- **Background jobs**: Postgres-based queue
- **Caching/SSE**: Redis available for caching and coordinating SSE
- **Views**: use `user_feeds` / `visible_entries` for frontend queries instead of manual joins — semantics and gotchas in `src/server/CLAUDE.md`.

## API Conventions

- **Pagination**: Always cursor-based (never offset)
- **tRPC naming**: `noun.verb` (e.g., `entries.list`, `entries.markRead`)
- **Authorization**: tRPC procedures are session-only by default; token access is explicit opt-in (see `src/server/auth/CLAUDE.md`)

## Services Layer

Business logic should be extracted into reusable service functions in `src/server/services/`:

- **Purpose**: Share logic between tRPC routers, MCP server, background jobs, etc.
- **Pattern**: Pure functions that accept `db` and parameters, return plain data objects
- **Location**: `src/server/services/{domain}.ts` (e.g., `entries.ts`, `subscriptions.ts`)
- **Naming**: `verbNoun` (e.g., `listEntries`, `searchSubscriptions`, `markEntriesRead`)

Don't try to invalidate the cache or look things up in the cache. Pass data down as props if needed (and add to the backend API if necessary).

## Outgoing HTTP Requests

Always use our custom user agent (`USER_AGENT`/`buildUserAgent` from `@/server/http/user-agent`), and fetch user-influenced URLs only through `fetchWithSsrfProtection` (see `src/server/http/CLAUDE.md`).

## Parsing

Prefer SAX-style parsing unless the algorithm requires a DOM.

- Feed parsing (RSS/Atom/OPML): the native `@lion-reader/feed-parser` module (`native/feed-parser/`, quick-xml SAX, built by `pnpm build:native`) behind thin TS wrappers in `src/server/feed/streaming/` — date parsing and JSON Feed stay in JS. Request paths use the `*Async` forms (libuv thread pool); background jobs use the sync forms.
- XML generation (OPML export): `fast-xml-parser`
- HTML extraction: `htmlparser2` (streaming)
- DOM required: `linkedom` (but article extraction/Readability is the native `@lion-reader/readability` module — dom_smoothie, built by `pnpm build:native`)
- Parse once, pass parsed structure through code

## Sanitizing Untrusted HTML

Entry HTML sanitization is **security-critical** (entry bodies are rendered via `dangerouslySetInnerHTML`; the sanitizer is the primary XSS defense). It happens **server-side in the services layer** — never add a client-side sanitizer, and never render feed-controlled text as HTML. The sanitizer itself is a native Rust module (`native/sanitizer/`, built with `pnpm build:native` — required before running tests or the app). Read `src/server/html/CLAUDE.md` before touching anything sanitization-related, and bump `SANITIZER_VERSION` (in `native/sanitizer/core/src/lib.rs`) per its rules whenever sanitizer behavior changes.
