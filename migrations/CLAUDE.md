# Migrations

- **Every migration must work with the previous release.** Fly runs them in `release_command` before the canary deploy, so old code runs against the new schema during rollout, and keeps doing so after a failed or rolled-back deploy (migrations aren't rolled back). Expand in one release (nullable or defaulted columns, new tables, indexes, views alongside old ones); contract across two (ship code that no longer references a column or table, then drop it). A rename is add + dual-write/backfill + drop across releases, never one `ALTER ... RENAME`.
- We use a custom runner (`scripts/migrate.ts`), not drizzle-kit, which isn't installed even though the file format looks like its. Run `pnpm db:migrate` / `pnpm db:migrate:test`.
- Add every migration to `meta/_journal.json`; only journaled migrations run (a unit test checks every `.sql` file is journaled).
- Never `CREATE INDEX CONCURRENTLY` in a migration — each runs in a transaction. If production needs a concurrent build, apply it by hand first, then journal a plain `CREATE INDEX IF NOT EXISTS`. Heavy migrations on production: `docs/fly-postgres-ops.md`.
- Test with `pnpm test:integration`.
- Read @schema.sql and keep it current with `pnpm db:schema`.
