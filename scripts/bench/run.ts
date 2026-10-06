/**
 * Runs the database benchmarks (`pnpm bench:db`) against a database seeded by
 * `seed.ts`, writes a result file and prints a markdown summary.
 *
 * Every statement runs under EXPLAIN ANALYZE (with SERIALIZE on Postgres 17+,
 * so reads pay for detoasting what they return). A write benchmark runs in a
 * transaction with `SET CONSTRAINTS ALL IMMEDIATE`, so deferred checks are
 * measured too, and is rolled back.
 *
 * Each benchmark gets a fresh connection and runs `--warmup` unrecorded
 * iterations before `--iterations` recorded ones. The warm-up matters: a
 * PL/pgSQL statement is planned for its arguments only for its first five
 * executions in a session and may then switch to a generic plan, which is what
 * the triggers run on production's long-lived pooled connections. The default
 * of 5 puts every trigger statement past that switch, and the fresh connection
 * keeps one benchmark's calls from changing the next one's plans.
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
  fmtBytes,
  fmtCount,
  fmtMs,
  markdownTable,
  totalBuffers,
  type BenchResult,
  type Buffers,
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

interface Sample {
  ms: number;
  planMs: number;
  triggerMs: number;
  rows: number;
  buffers: Buffers;
  nodes: string[];
  /** `idx:name` for each index scanned, `seq:table` for each sequential scan. */
  access: string[];
  triggers: TriggerTime[];
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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile. */
function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

function spread(values: number[]): Spread {
  return {
    median: median(values),
    p90: percentile(values, 90),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function medianBuffers(all: Buffers[]): Buffers {
  return {
    hit: median(all.map((b) => b.hit)),
    read: median(all.map((b) => b.read)),
    dirtied: median(all.map((b) => b.dirtied)),
    written: median(all.map((b) => b.written)),
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

async function explain(client: Client, sql: string, serialize: boolean): Promise<Sample> {
  const options = `ANALYZE, BUFFERS, ${serialize ? "SERIALIZE TEXT, " : ""}FORMAT JSON`;
  const res = await client.query<{ "QUERY PLAN": ExplainDoc[] }>(`EXPLAIN (${options}) ${sql}`);
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
    buffers: {
      hit: (plan["Shared Hit Blocks"] ?? 0) + (ser["Shared Hit Blocks"] ?? 0),
      read: (plan["Shared Read Blocks"] ?? 0) + (ser["Shared Read Blocks"] ?? 0),
      dirtied: (plan["Shared Dirtied Blocks"] ?? 0) + (ser["Shared Dirtied Blocks"] ?? 0),
      written: (plan["Shared Written Blocks"] ?? 0) + (ser["Shared Written Blocks"] ?? 0),
    },
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
  serialize: boolean
): Promise<{ samples: Sample[]; walBytes: number }> {
  const write = bench.kind === "write";
  if (write) {
    // The previous iteration's rolled-back rows are dead tuples the next one
    // would otherwise scan past.
    await vacuum(client);
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const sql of prepared.setup ?? []) await client.query(sql);
  }
  try {
    const before = await walLsn(client);
    const samples: Sample[] = [];
    for (const statement of prepared.statements) {
      try {
        samples.push(await explain(client, statement.sql, serialize));
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

async function runBenchmark(
  client: Client,
  bench: Benchmark,
  iterations: number,
  warmup: number,
  serialize: boolean
): Promise<BenchResult> {
  const prepared = await bench.prepare(client);
  for (let i = 0; i < warmup; i++) await iterate(client, bench, prepared, serialize);
  const runs: Array<{ samples: Sample[]; walBytes: number }> = [];
  for (let i = 0; i < iterations; i++) runs.push(await iterate(client, bench, prepared, serialize));

  const statements: StatementResult[] = prepared.statements.map((s, k) => {
    const samples = runs.map((r) => r.samples[k]);
    const last = samples[samples.length - 1];
    return {
      label: s.label,
      ms: median(samples.map((x) => x.ms)),
      triggerMs: median(samples.map((x) => x.triggerMs)),
      rows: median(samples.map((x) => x.rows)),
      buffers: medianBuffers(samples.map((x) => x.buffers)),
      nodes: last.nodes,
      triggers: last.triggers,
    };
  });
  const sum = (r: { samples: Sample[] }, f: (s: Sample) => number) =>
    r.samples.reduce((a, s) => a + f(s), 0);
  const access = new Set(runs.flatMap((r) => r.samples.flatMap((s) => s.access)));
  return {
    name: bench.name,
    kind: bench.kind,
    source: bench.source,
    ms: spread(runs.map((r) => sum(r, (s) => s.ms))),
    planMs: median(runs.map((r) => sum(r, (s) => s.planMs))),
    triggerMs: median(runs.map((r) => sum(r, (s) => s.triggerMs))),
    buffers: medianBuffers(
      runs.map((r) => ({
        hit: sum(r, (s) => s.buffers.hit),
        read: sum(r, (s) => s.buffers.read),
        dirtied: sum(r, (s) => s.buffers.dirtied),
        written: sum(r, (s) => s.buffers.written),
      }))
    ),
    rows: median(runs.map((r) => sum(r, (s) => s.rows))),
    walBytes: median(runs.map((r) => r.walBytes)),
    access: [...access].sort(),
    statements,
  };
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
  iterations: number,
  warmup: number,
  note: string | undefined
): Promise<RunMeta> {
  const version = (await client.query<{ v: string }>("SELECT version() AS v")).rows[0].v;
  const settings = await client.query<{ name: string; setting: string; unit: string | null }>(
    `SELECT name, setting, unit FROM pg_settings
     WHERE name IN ('shared_buffers', 'work_mem', 'effective_cache_size', 'random_page_cost',
                    'jit', 'max_parallel_workers_per_gather', 'effective_io_concurrency')
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
    },
    iterations,
    warmup,
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
    ["benchmark", "p50 ms", "p90 ms", "trigger ms", "buffers", "rows", "WAL", "access"],
    results.map((r) => [
      r.name,
      fmtMs(r.ms.median),
      fmtMs(r.ms.p90),
      r.triggerMs > 0 ? fmtMs(r.triggerMs) : "",
      fmtCount(totalBuffers(r.buffers)),
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
  const serialize = versionNum >= 170000;
  const meta = await collectMeta(admin, iterations, warmup, values.note);
  await settle(admin);
  await admin.end();

  const results: BenchResult[] = [];
  for (const bench of selected) {
    const started = Date.now();
    const client = await connect();
    try {
      await vacuum(client);
      results.push(await runBenchmark(client, bench, iterations, warmup, serialize));
    } finally {
      await client.end();
    }
    const r = results[results.length - 1];
    console.error(
      `${bench.name.padEnd(32)} p50 ${fmtMs(r.ms.median).padStart(7)} ms  (${((Date.now() - started) / 1000).toFixed(1)} s)`
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
      `${meta.postgres.version.split(" on ")[0]}, ${iterations} iterations\n`
  );
  console.log(summaryTable(results));
  console.log(`\nWrote ${out}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
