/**
 * The result file `run.ts` writes and `compare.ts` reads, and the formatting
 * both use. Bump `RESULT_VERSION` when a field changes meaning.
 */

export const RESULT_VERSION = 2;

/** Over the recorded iterations (5 by default, too few for a meaningful p90). */
export interface Spread {
  median: number;
  min: number;
  max: number;
}

export interface Buffers {
  /** Shared buffers found in cache. */
  hit: number;
  /** Shared buffers read from the OS (cache misses). */
  read: number;
  dirtied: number;
  written: number;
}

export interface TriggerTime {
  name: string;
  relation: string;
  calls: number;
  ms: number;
}

export interface StatementResult {
  label: string;
  /** Planning + execution, median over iterations. */
  ms: number;
  /** From the one timed iteration (see `BenchResult.triggerMs`). */
  triggerMs: number;
  rows: number;
  /** All buffers, triggers included; null without pg_stat_statements. */
  buffers: Buffers | null;
  planBuffers: Buffers;
  /** Plan nodes in pre-order, with the index or relation each scan reads. */
  nodes: string[];
  triggers: TriggerTime[];
}

/** One way of running a benchmark: warm (the default) or cold. */
export interface Measurement {
  /** Sum over the benchmark's statements of planning + execution time. */
  ms: Spread;
  /**
   * Every buffer the statements used, triggers and foreign-key checks
   * included (from pg_stat_statements), median; null when the server doesn't
   * load pg_stat_statements.
   */
  buffers: Buffers | null;
  /** WAL generated, triggers included, median. */
  walBytes: number;
}

export interface BenchResult extends Measurement {
  name: string;
  kind: "read" | "write";
  source: string;
  planMs: number;
  /**
   * Time spent in triggers, from one extra iteration with per-node timing on
   * (the recorded iterations run with TIMING OFF, which drops trigger times).
   */
  triggerMs: number;
  /** Buffers attributed to plan nodes, median: excludes work inside triggers. */
  planBuffers: Buffers;
  /** Rows returned (reads) or written by the statements themselves (writes), median. */
  rows: number;
  /**
   * Writes only: each iteration on a fresh connection, first call, so
   * PL/pgSQL statements in triggers still use custom plans (and caches are
   * cold).
   */
  cold?: Measurement;
  /** Every index scanned (`idx:name`) and table sequentially scanned (`seq:table`) in any iteration. */
  access: string[];
  statements: StatementResult[];
}

export interface RunMeta {
  version: number;
  startedAt: string;
  git: { sha: string; branch: string; dirty: boolean };
  machine: { cpu: string; cores: number; memoryGb: number; platform: string };
  postgres: { version: string; settings: Record<string, string>; pgStatStatements: boolean };
  iterations: number;
  warmup: number;
  /** Tables ANALYZEd before the run because they had no or stale statistics. */
  analyzed: string[];
  /** Row counts and size of the seeded database, to spot comparing different seeds. */
  dataset: Record<string, number | string>;
  note?: string;
}

export interface RunFile {
  meta: RunMeta;
  results: BenchResult[];
}

export const totalBuffers = (b: Buffers): number => b.hit + b.read;

/** The best buffer count a result has: all buffers when known, else the plans'. */
export const bestBuffers = (r: BenchResult): number => totalBuffers(r.buffers ?? r.planBuffers);

export function fmtMs(ms: number): string {
  if (ms >= 100) return ms.toFixed(0);
  if (ms >= 10) return ms.toFixed(1);
  return ms.toFixed(2);
}

export function fmtCount(n: number): string {
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  if (n >= 10 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${n} B`;
}

export function markdownTable(header: string[], rows: string[][]): string {
  const align = header.map((_, i) => (i === 0 ? ":--" : "--:"));
  return [header, align, ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}
