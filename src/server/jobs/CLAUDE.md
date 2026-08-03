# Background Jobs (`src/server/jobs/`)

This file governs the Postgres-based background job queue and its handlers. See the pipeline diagram `docs/diagrams/feed-fetcher.d2` when working on the job queue or feed-fetch jobs, and `src/server/feed/CLAUDE.md` for the fetching/WebSub rules those jobs enforce.

## Handler layout

`handlers/` holds **one file per job type**, named after the job type (`fetch_feed` ⇒ `handlers/fetch-feed.ts`); `handlers/types.ts` holds the shared `JobHandlerResult`. Adding a job type means adding a file and a `worker.ts` dispatch arm — never appending to an existing handler's file.

A handler is **scheduling glue, not business logic**: it decides `nextRunAt` and maps an outcome to a `JobHandlerResult`. The work itself belongs in `src/server/services/` so tRPC/MCP/compat callers can reuse it (e.g. `process_opml_import` ⇒ `services/imports.ts`). `fetch-feed.ts` is the exception — the feed-fetch pipeline has no non-worker caller.
