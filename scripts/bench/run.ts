/**
 * Runs the database benchmarks (`pnpm bench:db`) against a database seeded by
 * `seed.ts`, writes a result file and prints a markdown summary.
 *
 * Every statement runs under `EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF)`,
 * with SERIALIZE on Postgres 17+ so reads pay for detoasting what they
 * return. Per-node timing is off because its overhead swamps plans with many
 * loops; one extra timed iteration supplies trigger times, which EXPLAIN only
 * reports with timing on. EXPLAIN doesn't attribute trigger work to plan
 * nodes, so buffers come from pg_stat_statements when the server loads it
 * (`pnpm services` does): the delta of its top-level totals around each
 * statement covers everything the statement ran, triggers and foreign-key
 * checks included.
 *
 * A write benchmark runs in a transaction with `SET CONSTRAINTS ALL
 * IMMEDIATE`, so deferred checks are measured too, and is rolled back.
 *
 * Each benchmark gets a fresh connection and runs `--warmup` unrecorded
 * iterations before `--iterations` recorded ones. The warm-up matters: a
 * PL/pgSQL statement is planned for its arguments only for its first five
 * executions in a session and may then switch to a generic plan, which is what
 * the triggers run on production's long-lived pooled connections. The default
 * of 5 puts every trigger statement past that switch. Writes are also measured
 * cold: each iteration on a new connection, so the triggers still use custom
 * plans (and catalog caches are empty).
 *
 *   pnpm bench:db [--iterations 5] [--warmup 5] [--filter write.,search] [--out file.json] [--note text]
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Client } from "pg";

import { BENCHMARKS, type Benchmark, type PreparedBenchmark } from "./benchmarks";
import { U0, userEmail } from "./dataset";
import {
  RESULT_VERSION,
  bestBuffers,
  fmtBytes,
  fmtCount,
  fmtMs,
  markdownTable,
  type BenchResult,
  type Buffers,
  type Measurement,
  type RunFile,
  type RunMeta,
  type Spread,
  type StatementResult,
  type TriggerTime,
} from "./results";

interface PlanNode {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Tuples Inserted"?: number;
  "Shared Hit Blocks"?: number;
  "Shared Read Blocks"?: number;
  "Shared Dirtied Blocks"?: number;
  "Shared Written Blocks"?: number;
  Plans?: PlanNode[];
}

interface ExplainDoc {
  Plan: PlanNode;
  "Planning Time": number;
  "Execution Time": number;
  Triggers?: Array<{ "Trigger Name": string; Relation?: string; Time?: number; Calls: number }>;
  Serialization?: {
    "Shared Hit Blocks"?: number;
    "Shared Read Blocks"?: number;
    "Shared Dirtied Blocks"?: number;
    "Shared Written Blocks"?: number;
  };
}

interface RunOptions {
  /** EXPLAIN SERIALIZE is available (Postgres 17+). */
  serialize: boolean;
  /** pg_stat_statements is loaded, so buffers can include trigger work. */
  pgss: boolean;
}

interface Sample {
  ms: number;
  planMs: number;
  triggerMs: number;
  rows: number;
  planBuffers: Buffers;
  buffers: Buffers | null;
  nodes: string[];
  /** `idx:name` for each index scanned, `seq:table` for each sequential scan. */
  access: string[];
  triggers: TriggerTime[];
}

interface Iteration {
  samples: Sample[];
  walBytes: number;
}

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Clears the dead tuples rolled-back writes leave in the tables the write
 * benchmarks touch, so every benchmark and write iteration starts from the
 * seeded state; autovacuum would clear them at some arbitrary point instead.
 * DISABLE_PAGE_SKIPPING makes VACUUM count every page, keeping the row
 * estimates the planner uses exact: a page-skipping VACUUM extrapolates them,
 * and over a few runs they drifted far enough to change plans. No ANALYZE,
 * which would resample statistics.
 */
async function vacuum(client: Client): Promise<void> {
  await client.query(
    `VACUUM (DISABLE_PAGE_SKIPPING) entries, user_entries, subscriptions, subscription_tags,
       collection_entries, feeds, jobs, tags, users`
  );
}

/**
 * ANALYZEs every table without statistics or with rows changed since its last
 * ANALYZE (a migration's new or backfilled table, say), so plans don't depend
 * on when autovacuum gets to it. The seed analyzes everything and rolled-back
 * benchmark writes don't count as changes, so this is normally a no-op.
 */
async function analyzeStale(client: Client): Promise<string[]> {
  const stale = await client.query<{ relname: string }>(
    `SELECT relname FROM pg_stat_user_tables
     WHERE schemaname = 'public'
       AND (n_mod_since_analyze > 0 OR (last_analyze IS NULL AND last_autoanalyze IS NULL))
     ORDER BY relname`
  );
  for (const { relname } of stale.rows) {
    await client.query(`ANALYZE public.${client.escapeIdentifier(relname)}`);
  }
  return stale.rows.map((r) => r.relname);
}

/**
 * Runs every write benchmark once and rolls it back. The tables grow to hold
 * the rows a write writes, and keep that space after the rollback; doing it
 * here first means every run, including the first after a seed, measures the
 * same physical layout and row estimates.
 */
async function settle(client: Client): Promise<void> {
  for (const bench of BENCHMARKS.filter((b) => b.kind === "write")) {
    const prepared = await bench.prepare(client);
    await client.query("BEGIN");
    try {
      for (const sql of prepared.setup ?? []) await client.query(sql);
      for (const statement of prepared.statements) await client.query(statement.sql);
    } finally {
      await client.query("ROLLBACK");
    }
  }
  await vacuum(client);
}

/** Whether pg_stat_statements is usable, creating the extension if needed. */
async function enablePgStatStatements(client: Client): Promise<boolean> {
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    await client.query("SELECT 1 FROM pg_stat_statements(false) LIMIT 1");
    return true;
  } catch {
    return false;
  }
}

/** Totals over pg_stat_statements' top-level entries (reading them uses no buffers). */
async function pgssTotals(client: Client): Promise<Buffers> {
  const res = await client.query<Record<keyof Buffers, string>>(
    `SELECT coalesce(sum(shared_blks_hit), 0)::text AS hit,
            coalesce(sum(shared_blks_read), 0)::text AS read,
            coalesce(sum(shared_blks_dirtied), 0)::text AS dirtied,
            coalesce(sum(shared_blks_written), 0)::text AS written
     FROM pg_stat_statements(false) WHERE toplevel`
  );
  const row = res.rows[0];
  return {
    hit: Number(row.hit),
    read: Number(row.read),
    dirtied: Number(row.dirtied),
    written: Number(row.written),
  };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function spread(values: number[]): Spread {
  return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
}

function medianBuffers(all: Buffers[]): Buffers {
  return {
    hit: median(all.map((b) => b.hit)),
    read: median(all.map((b) => b.read)),
    dirtied: median(all.map((b) => b.dirtied)),
    written: median(all.map((b) => b.written)),
  };
}

function sumBuffers(all: Buffers[]): Buffers {
  return {
    hit: all.reduce((a, b) => a + b.hit, 0),
    read: all.reduce((a, b) => a + b.read, 0),
    dirtied: all.reduce((a, b) => a + b.dirtied, 0),
    written: all.reduce((a, b) => a + b.written, 0),
  };
}

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

function nodeLabel(n: PlanNode): string {
  const target = n["Index Name"] ?? n["Relation Name"];
  return target ? `${n["Node Type"]} ${target}` : n["Node Type"];
}

/** Rows a statement returned, or for a write the rows it wrote. */
function statementRows(plan: PlanNode): number {
  if (plan["Node Type"] !== "ModifyTable") return plan["Actual Rows"] ?? 0;
  if (plan["Tuples Inserted"] !== undefined) return plan["Tuples Inserted"];
  const children = plan.Plans ?? [];
  const source = children.find((c) => c["Parent Relationship"] === "Outer") ?? children[0];
  return source ? (source["Actual Rows"] ?? 0) * (source["Actual Loops"] ?? 1) : 0;
}

async function explain(
  client: Client,
  sql: string,
  opts: RunOptions,
  timing: boolean
): Promise<Sample> {
  const options = [
    "ANALYZE",
    "BUFFERS",
    "WAL",
    `TIMING ${timing ? "ON" : "OFF"}`,
    ...(opts.serialize ? ["SERIALIZE TEXT"] : []),
    "FORMAT JSON",
  ].join(", ");
  const before = opts.pgss ? await pgssTotals(client) : null;
  const res = await client.query<{ "QUERY PLAN": ExplainDoc[] }>(`EXPLAIN (${options}) ${sql}`);
  const after = opts.pgss ? await pgssTotals(client) : null;
  const doc = res.rows[0]["QUERY PLAN"][0];
  const plan = doc.Plan;
  const ser = doc.Serialization ?? {};
  const triggers = (doc.Triggers ?? []).map((t) => ({
    name: t["Trigger Name"],
    relation: t.Relation ?? "",
    calls: t.Calls,
    ms: t.Time ?? 0,
  }));
  const nodes: string[] = [];
  const access: string[] = [];
  walk(plan, (n) => {
    nodes.push(nodeLabel(n));
    if (n["Index Name"]) access.push(`idx:${n["Index Name"]}`);
    else if (n["Node Type"] === "Seq Scan") access.push(`seq:${n["Relation Name"]}`);
  });
  return {
    ms: doc["Planning Time"] + doc["Execution Time"],
    planMs: doc["Planning Time"],
    triggerMs: triggers.reduce((a, t) => a + t.ms, 0),
    rows: statementRows(plan),
    planBuffers: {
      hit: (plan["Shared Hit Blocks"] ?? 0) + (ser["Shared Hit Blocks"] ?? 0),
      read: (plan["Shared Read Blocks"] ?? 0) + (ser["Shared Read Blocks"] ?? 0),
      dirtied: (plan["Shared Dirtied Blocks"] ?? 0) + (ser["Shared Dirtied Blocks"] ?? 0),
      written: (plan["Shared Written Blocks"] ?? 0) + (ser["Shared Written Blocks"] ?? 0),
    },
    buffers:
      before && after
        ? {
            hit: after.hit - before.hit,
            read: after.read - before.read,
            dirtied: after.dirtied - before.dirtied,
            written: after.written - before.written,
          }
        : null,
    nodes,
    access,
    triggers,
  };
}

async function walLsn(client: Client): Promise<string> {
  return (await client.query<{ lsn: string }>("SELECT pg_current_wal_insert_lsn()::text AS lsn"))
    .rows[0].lsn;
}

/** One iteration: every statement's sample, plus the WAL it generated. */
async function iterate(
  client: Client,
  bench: Benchmark,
  prepared: PreparedBenchmark,
  opts: RunOptions,
  timing = false
): Promise<Iteration> {
  const write = bench.kind === "write";
  if (write) {
    // The previous iteration's rolled-back rows are dead tuples the next one
    // would otherwise scan past.
    await vacuum(client);
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    // Except the memberships' foreign keys to user_entries: the user_entries
    // delete trigger removes the rows they check only after the delete that
    // runs an immediate check, so they hold only at commit (migration 0133).
    await client.query(
      "SET CONSTRAINTS subscription_entries_user_id_entry_id_fkey, collection_entries_user_id_entry_id_fkey DEFERRED"
    );
    for (const sql of prepared.setup ?? []) await client.query(sql);
  }
  try {
    const before = await walLsn(client);
    const samples: Sample[] = [];
    for (const statement of prepared.statements) {
      try {
        samples.push(await explain(client, statement.sql, opts, timing));
      } catch (err) {
        throw new Error(`${bench.name} / ${statement.label}: ${(err as Error).message}`);
      }
    }
    const after = await walLsn(client);
    const wal = await client.query<{ bytes: string }>(
      "SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint::text AS bytes",
      [after, before]
    );
    return { samples, walBytes: Number(wal.rows[0].bytes) };
  } finally {
    if (write) await client.query("ROLLBACK");
  }
}

function measurement(runs: Iteration[]): Measurement {
  const buffers = runs.map((r) =>
    r.samples.every((s) => s.buffers) ? sumBuffers(r.samples.map((s) => s.buffers!)) : null
  );
  return {
    ms: spread(runs.map((r) => r.samples.reduce((a, s) => a + s.ms, 0))),
    buffers: buffers.every((b) => b) ? medianBuffers(buffers.map((b) => b!)) : null,
    walBytes: median(runs.map((r) => r.walBytes)),
  };
}

async function runBenchmark(
  connect: () => Promise<Client>,
  bench: Benchmark,
  iterations: number,
  warmup: number,
  opts: RunOptions
): Promise<BenchResult> {
  const client = await connect();
  try {
    await vacuum(client);
    const prepared = await bench.prepare(client);

    let cold: Measurement | undefined;
    if (bench.kind === "write") {
      const coldRuns: Iteration[] = [];
      for (let i = 0; i < iterations; i++) {
        const fresh = await connect();
        try {
          coldRuns.push(await iterate(fresh, bench, prepared, opts));
        } finally {
          await fresh.end();
        }
      }
      cold = measurement(coldRuns);
    }

    for (let i = 0; i < warmup; i++) await iterate(client, bench, prepared, opts);
    const runs: Iteration[] = [];
    for (let i = 0; i < iterations; i++) runs.push(await iterate(client, bench, prepared, opts));
    const timed = await iterate(client, bench, prepared, opts, true);

    const statements: StatementResult[] = prepared.statements.map((s, k) => {
      const samples = runs.map((r) => r.samples[k]);
      const all = samples.map((x) => x.buffers);
      return {
        label: s.label,
        ms: median(samples.map((x) => x.ms)),
        triggerMs: timed.samples[k].triggerMs,
        rows: median(samples.map((x) => x.rows)),
        buffers: all.every((b) => b) ? medianBuffers(all.map((b) => b!)) : null,
        planBuffers: medianBuffers(samples.map((x) => x.planBuffers)),
        nodes: samples[samples.length - 1].nodes,
        triggers: timed.samples[k].triggers,
      };
    });
    const sum = (r: Iteration, f: (s: Sample) => number) => r.samples.reduce((a, s) => a + f(s), 0);
    const access = new Set(runs.flatMap((r) => r.samples.flatMap((s) => s.access)));
    return {
      name: bench.name,
      kind: bench.kind,
      source: bench.source,
      ...measurement(runs),
      planMs: median(runs.map((r) => sum(r, (s) => s.planMs))),
      triggerMs: sum(timed, (s) => s.triggerMs),
      planBuffers: medianBuffers(runs.map((r) => sumBuffers(r.samples.map((s) => s.planBuffers)))),
      rows: median(runs.map((r) => sum(r, (s) => s.rows))),
      ...(cold ? { cold } : {}),
      access: [...access].sort(),
      statements,
    };
  } finally {
    await client.end();
  }
}

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: BENCH_DIR, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function collectMeta(
  client: Client,
  options: { iterations: number; warmup: number; pgss: boolean; analyzed: string[] },
  note: string | undefined
): Promise<RunMeta> {
  const version = (await client.query<{ v: string }>("SELECT version() AS v")).rows[0].v;
  const settings = await client.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings
     WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost',
                    'jit', 'max_parallel_workers_per_gather', 'effective_io_concurrency',
                    'plan_cache_mode')
     ORDER BY name`
  );
  const counts = await client.query<{ what: string; n: string }>(
    `SELECT 'users' AS what, count(*)::text AS n FROM users
     UNION ALL SELECT 'feeds', count(*)::text FROM feeds
     UNION ALL SELECT 'subscriptions', count(*)::text FROM subscriptions
     UNION ALL SELECT 'entries', count(*)::text FROM entries
     UNION ALL SELECT 'user_entries', count(*)::text FROM user_entries
     UNION ALL SELECT 'collection_entries', count(*)::text FROM collection_entries
     UNION ALL SELECT 'u0_user_entries', count(*)::text FROM user_entries WHERE user_id = $1
     UNION ALL SELECT 'u0_unread', count(*)::text FROM user_entries WHERE user_id = $1 AND NOT read`,
    [U0]
  );
  const size = await client.query<{ size: string }>(
    "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
  );
  const dataset: Record<string, number | string> = { size: size.rows[0].size };
  for (const row of counts.rows) dataset[row.what] = Number(row.n);
  return {
    version: RESULT_VERSION,
    startedAt: new Date().toISOString(),
    git: {
      sha: git("rev-parse HEAD"),
      branch: git("rev-parse --abbrev-ref HEAD"),
      dirty: git("status --porcelain") !== "",
    },
    machine: {
      cpu: os.cpus()[0]?.model ?? "unknown",
      cores: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.platform()} ${os.release()}`,
    },
    postgres: {
      version,
      settings: Object.fromEntries(
        settings.rows.map((r) => [r.name, r.unit ? `${r.setting} ${r.unit}` : r.setting])
      ),
      pgStatStatements: options.pgss,
    },
    iterations: options.iterations,
    warmup: options.warmup,
    analyzed: options.analyzed,
    dataset,
    ...(note ? { note } : {}),
  };
}

/** The summary table `pnpm bench:db` prints. */
function summaryTable(results: BenchResult[]): string {
  const access = (a: string[]) => {
    const shown = a.map((x) => (x.startsWith("seq:") ? `SEQ ${x.slice(4)}` : x.slice(4)));
    return shown.length > 5
      ? `${shown.slice(0, 5).join(", ")}, +${shown.length - 5}`
      : shown.join(", ");
  };
  return markdownTable(
    ["benchmark", "ms", "max ms", "cold ms", "trigger ms", "buffers", "rows", "WAL", "access"],
    results.map((r) => [
      r.name,
      fmtMs(r.ms.median),
      fmtMs(r.ms.max),
      r.cold ? fmtMs(r.cold.ms.median) : "",
      r.triggerMs > 0 ? fmtMs(r.triggerMs) : "",
      fmtCount(bestBuffers(r)),
      fmtCount(r.rows),
      r.walBytes > 0 ? fmtBytes(r.walBytes) : "",
      access(r.access),
    ])
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      iterations: { type: "string", default: "5" },
      warmup: { type: "string", default: "5" },
      filter: { type: "string" },
      out: { type: "string" },
      note: { type: "string" },
    },
  });
  const iterations = Number(values.iterations);
  const warmup = Number(values.warmup);
  if (!(iterations >= 1) || !(warmup >= 0))
    throw new Error("--iterations must be ≥ 1, --warmup ≥ 0");
  const filters = values.filter?.split(",").filter(Boolean) ?? [];
  const selected = BENCHMARKS.filter(
    (b) => filters.length === 0 || filters.some((f) => b.name.includes(f))
  );
  if (selected.length === 0) throw new Error(`No benchmark matches --filter ${values.filter}`);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (run `pnpm services` first)");
  const connect = async (): Promise<Client> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    return client;
  };
  const admin = await connect();
  const marker = await admin.query("SELECT 1 FROM users WHERE email = $1", [userEmail(0)]);
  if (marker.rowCount === 0) {
    throw new Error("Not a benchmark database: run `pnpm bench:db:seed` first");
  }
  const versionNum = Number(
    (await admin.query<{ v: string }>("SHOW server_version_num")).rows[0].v
  );
  const opts: RunOptions = {
    serialize: versionNum >= 170000,
    pgss: await enablePgStatStatements(admin),
  };
  if (!opts.pgss) {
    console.error(
      "pg_stat_statements isn't loaded: buffers will exclude trigger work (see scripts/bench/README.md)"
    );
  }
  const analyzed = await analyzeStale(admin);
  const meta = await collectMeta(
    admin,
    { iterations, warmup, pgss: opts.pgss, analyzed },
    values.note
  );
  await settle(admin);
  await admin.end();

  const results: BenchResult[] = [];
  for (const bench of selected) {
    const started = Date.now();
    results.push(await runBenchmark(connect, bench, iterations, warmup, opts));
    const r = results[results.length - 1];
    console.error(
      `${bench.name.padEnd(32)} ${fmtMs(r.ms.median).padStart(7)} ms  (${((Date.now() - started) / 1000).toFixed(1)} s)`
    );
  }

  const file: RunFile = { meta, results };
  const out =
    values.out ??
    path.join(
      BENCH_DIR,
      "results",
      `${meta.startedAt.replace(/[:.]/g, "-")}-${meta.git.sha.slice(0, 8) || "nogit"}.json`
    );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);

  console.log(
    `\n${meta.git.branch}@${meta.git.sha.slice(0, 8)}${meta.git.dirty ? " (dirty)" : ""}, ` +
      `${meta.postgres.version.split(" on ")[0]}, ${iterations} iterations` +
      (analyzed.length > 0 ? `, analyzed ${analyzed.join(", ")}` : "") +
      "\n"
  );
  console.log(summaryTable(results));
  console.log(`\nWrote ${out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
