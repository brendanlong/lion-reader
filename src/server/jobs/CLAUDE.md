# Background Jobs (`src/server/jobs/`)

This file governs the Postgres-based background job queue and its handlers. See the pipeline diagram `docs/diagrams/feed-fetcher.d2` when working on the job queue or feed-fetch jobs, and `src/server/feed/CLAUDE.md` for the fetching/WebSub rules those jobs enforce.

## Handler layout

`handlers/` holds **one file per job type**, named after the job type (`fetch_feed` ⇒ `handlers/fetch-feed.ts`); `handlers/types.ts` holds the shared `JobHandlerResult`. Adding a job type means adding a file plus its `JOB_DEFINITIONS` (`queue.ts`) entry and a handler in `worker.ts` (`JOB_HANDLERS`, or `FIXED_INTERVAL_JOB_HANDLERS` for one with `intervalMs`) — never appending to an existing handler's file.

A handler is **scheduling glue, not business logic**: it decides `nextRunAt` and maps an outcome to a `JobHandlerResult` (a singleton on a fixed cadence declares `intervalMs` instead and returns only metadata). The work itself belongs in `src/server/services/` so tRPC/MCP/compat callers can reuse it (e.g. `process_opml_import` ⇒ `services/imports.ts`). `fetch-feed.ts` is the exception — the feed-fetch pipeline has no non-worker caller.

**Every handler must be idempotent.** A job still running past `STALE_JOB_THRESHOLD_MS` (`queue.ts`) is claimed again, and nothing stops the first run, so two runs can overlap; don't add leases or fencing to prevent that.
