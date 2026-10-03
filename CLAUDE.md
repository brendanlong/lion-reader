# Lion Reader Development Guidelines

## Documentation Map

Per-directory `CLAUDE.md` files hold each subsystem's rules and load automatically when you work there (`src/`, `src/components/`, `src/server/` and its `auth/`, `oauth/`, `html/`, `http/`, `feed/`, `jobs/`, `plugins/`, plus `tests/`, `migrations/`, `kmp/`). Read these on demand:

- `SECURITY.md` - the **security-critical** code (XSS/SSRF/auth/cross-user isolation) and the invariant each area must uphold. **Read it first when reviewing, or when touching auth, sanitization, outbound fetches, the compat/OAuth/MCP APIs, or cross-user data paths.**
- `docs/DESIGN.md` - architecture and design decisions. Read it before design/architecture work.
- `src/FRONTEND_STATE.md` - the contract for queries, mutations, and cache/SSE updates.
- `docs/diagrams/` - D2 flow diagrams of the major systems.
- `docs/references/` - reference docs for external tools; consult before editing related configs.
- `docs/DEPLOYMENT.md`, `docs/fly-postgres-ops.md` - Fly.io deployment and Postgres operations. **Read the latter before any DB region move, failover, machine destroy, restore, or heavy production migration.**
- `terraform/` - all third-party infrastructure `fly.toml` doesn't own. **It changes there, never in a dashboard.**

## Documentation Guidelines

Docs (this file, per-directory `CLAUDE.md`s, `docs/`) explain **why and where**; the code explains **how**. Apply these rules when writing docs, and check for violations when reviewing doc changes (reviewer subagents included):

- **Say each thing once**, in the doc closest to the code it governs; link from elsewhere instead of restating.
- **Document decisions and required patterns** ("we use X", "always do Y") — not mechanics the reader can get from the code, and not exhaustive lists (tables, routers, events) the code already is the source of truth for. When a doc restates code, move any fact the code doesn't say into a doc comment on that code and delete the paragraph.
- **No history** unless it prevents repeating a mistake ("don't do X, it caused bug Y"). Describe the current state, never the change that got us here ("the old A is gone", "B replaced A").
- **No non-decisions**: don't document things we haven't done or have merely deferred — that reads as a commitment to never do them.
- Keep docs current **both ways**: when you change code whose docs are stale, or notice bloat/duplication, fix the docs in the same change — pruning is as valuable as adding.
- **No machine provisioning** (installing SDKs system-wide, shared caches, `$HOME`/prefs overrides): that lives with the machine. Docs say only what the build reads (e.g. "`ANDROID_HOME` or `sdk.dir`").
- When you rename or remove a doc section, grep for references to it (code comments and other docs).

### `CLAUDE.md` files

Every `CLAUDE.md` is loaded into context whenever an agent works in its directory, so each line costs every future session. Keep them to rules:

- A rule goes in the deepest directory's `CLAUDE.md` covering all the code it governs; this root file holds only what applies everywhere. Long runbooks needed rarely (ops, scaling) go in `docs/` with a pointer, not in a file that loads on every edit.
- Write each rule as an instruction, with its reason only when the reason stops a mistake ("no `INSERT OR REPLACE`: it deletes the row"). No architecture tours or command output.
- Before adding a line, check whether code, lint, knip or a test already enforces it; write it down only if the check's failure doesn't tell you the fix. Prefer adding a check over adding a line.

## Toolchain

- **Node 26** (`.nvmrc` is the source of truth). pnpm only warns on a mismatch, and on an older Node everything passes until Playwright dies at collection with `TypeError: Cannot read properties of undefined (reading 'exports')` inside `@sentry/nextjs` — check `node --version` before debugging that. With no version manager available, unpack a toolchain into the worktree rather than touching system or `$HOME` config:

  ```bash
  mkdir -p .node26 && curl -sL https://nodejs.org/dist/v26.7.0/node-v26.7.0-linux-x64.tar.xz \
    | tar -xJ -C .node26 --strip-components=1
  export PATH="$PWD/.node26/bin:$PATH"
  ```

- **Rust** is pinned to the rustc Alpine ships in the Dockerfile's `rust-base` stage (`rust-toolchain.toml` says why). Bump the two together.

## Commands

- `pnpm build:native` - builds the native Rust modules (`native/`). **Required once per checkout before tests or the app** ("Failed to load the native …" means it hasn't run). Needs `cargo` (try `~/.cargo/bin`) and a C++ compiler. The SessionStart hook starts it in the background (log: `/tmp/lion-reader-build-native.log`).
- `pnpm typecheck` - run before committing (no `any`, no `@ts-ignore`)
- `pnpm test:unit` / `pnpm test:integration` / `pnpm test:e2e` - see `tests/CLAUDE.md`
- `pnpm test:native` / `pnpm lint:native` / `pnpm format:native` - cargo test / clippy / fmt across the native crates
- `pnpm knip` and `pnpm knip:production` - unused files/exports/deps. The production sweep starts only from shipped entry points, so it also catches code kept alive solely by its own tests (#1551): delete what it reports, or tag an export that must stay for tests `@testonly`.

## Local Services (no Docker)

Without `docker compose` or the shared dev databases, **don't hand-roll Postgres**: run `pnpm services` as a **background task** (it starts Postgres + Redis on random ports, migrates, writes gitignored `.env.local-services*` files, and tears everything down on exit). Then use the `*:local` variants: `pnpm test:integration:local`, `pnpm test:e2e:local`, `pnpm db:migrate:local`, and `PORT=<random> pnpm dev:local` (web + worker, no Discord bot). This is a shared host — pick a random app port.

## Code Quality

- **Types**: Explicit types everywhere; use Zod for runtime validation
- **Queries**: Avoid N+1 queries; use joins or batch fetching
- **UI**: Use optimistic updates for responsive UX
- **DRY**: Deduplicate logic that must stay in sync; don't merge code that merely looks similar but serves independent purposes. A value that must agree in several places (a lifetime, a length cap, a cookie-and-Redis TTL) is one named constant every use imports, not repeated literals like `30 * 24 * 60 * 60`; where the uses share a language, share the constant instead of testing that copies match.
- Don't create barrel files, prefer direct imports within our code

## Tests (all languages)

- Always write tests for the intended behavior of functions, not the actual behavior. If the actual behavior is wrong and the issue is pre-existing, write the test correctly, mark it skipped, and file a GitHub issue on brendanlong/lion-reader (labels: `bug`, `reported-by-claude`)
- **Don't pin tunable constants.** A test that fails only because someone deliberately retuned a value is noise: import the constant (export it if needed) and assert relative to it — the boundary is at `MAX_X`/`MAX_X + 1` — and keep the assertion exact, not weakened to "is positive". Do hardcode values something outside our code depends on (wire/protocol formats, storage/cookie key names, CSP hosts) and policy (privacy defaults, security budgets, the 44px touch target), and do test required relationships between constants (e.g. a floor below its cap).
- **Each test must be able to catch a bug no other test catches.** No duplicates of a code path and input class already covered (at another level, or input-for-input in a native crate's own tests: keep the Rust copy, and test only what the binding/wrapper adds); collapse trivial variants into one case. No circular tests that write data and read it back without calling app code.
- Keep security tests (sanitizer, SSRF, auth/scopes, cross-user) and issue-referenced regression tests, dropping only exact duplicates; move the issue reference to the surviving copy.
- Concurrent tests assert only what every interleaving guarantees (e.g. "exactly one row", not "both requests missed the cache").

## Git

- Break work into commit-sized chunks; commit when finished
- Use amend commits when it makes sense (ALWAYS check the current commit before amending)
- Main branch: `master`
- Commit `migrations/schema.sql` changes separately if unrelated to current work
- Reference GitHub issues by number in commit messages (e.g. "Fix: prevent over-fetching slow feeds (#175)"), and read an issue's discussion before working on it

## Database Conventions

- **IDs**: UUIDv7 via `generateUuidv7()` from `@/lib/uuidv7` (`gen_uuidv7()` isn't available in our Postgres)
- **Timestamps**: `timestamptz` in UTC, read as JS `Date` (milliseconds). Keyset cursors need microseconds — see "Ordering & Pagination" in `src/server/CLAUDE.md`.
- **Soft deletes**: `deleted_at`/`unsubscribed_at`
- **Upserts**: Prefer `onConflictDoNothing()`/`onConflictDoUpdate()` over check-then-act
- **Migrations** must be backward-compatible with the previous release — see `migrations/CLAUDE.md`. That includes app code: drop references to a column a release before dropping it.
- **Views**: use `user_feeds` / `visible_entries` for frontend queries instead of manual joins (`src/server/CLAUDE.md`)

## API Conventions

- **Pagination**: Always cursor-based (never offset)
- **tRPC naming**: `noun.verb` (e.g., `entries.list`, `entries.markRead`)
- **Authorization**: tRPC procedures are session-only by default; token access is explicit opt-in (`src/server/auth/CLAUDE.md`)

## Untrusted Content

- **HTML**: entry HTML is sanitized server-side in the services layer on every read; never add a client-side sanitizer, and never render feed-controlled text as HTML. Rules: `src/server/html/CLAUDE.md`.
- **Outgoing HTTP**: send our User-Agent (`USER_AGENT`/`buildUserAgent` from `@/server/http/user-agent`), and fetch user-influenced URLs only through `fetchWithSsrfProtection` (`src/server/http/CLAUDE.md`).

## Third-Party Providers

When you add, remove, or change a third-party service that receives or stores user data (e.g. an LLM/AI provider, auth provider, email, object storage, hosting, error tracking), **update the privacy policy** (`src/app/(public)/privacy/page.tsx`) to keep its "Third-Party Services" section accurate, and bump the "Last updated" date. Note whether the feature is opt-in and what data is sent.

## Parsing

Prefer SAX-style parsing unless the algorithm requires a DOM. Parse once and pass the parsed structure through.

- Feeds (RSS/Atom/OPML): the native `@lion-reader/feed-parser` behind `src/server/feed/streaming/`; request paths use the `*Async` forms, background jobs the sync ones.
- XML generation (OPML export): `fast-xml-parser`
- HTML extraction: `htmlparser2` (streaming)
- DOM required: `linkedom`. Article extraction is the native `@lion-reader/readability`.
- A DOM that must number elements exactly as the browser does: `src/lib/narration/parse-html.ts` (parse5 first; it says why). Nothing else needs it.
- Markdown: **always** `markdownToHtmlAsync`/`processMarkdown` from `src/server/markdown`, so every source shares one dialect and the renderer's size budgets. A lint rule forbids importing `@lion-reader/markdown` directly.

## Module System (ESM)

Author source as ESM. Two things are CommonJS on purpose — don't "simplify" them: the esbuild bundles in `dist/` (`scripts/build-bundle.mjs` says why) and the native loaders `native/*/index.js` (their headers explain the bundler-proof binary resolution, the lexable re-exports, and the drift guard). tsx-run scripts use ESM idioms: `process.argv[1] === fileURLToPath(import.meta.url)`, not `require.main`; no bare `require()`/`__dirname`.
