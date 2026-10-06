/**
 * Compares two `pnpm bench:db` result files (`pnpm bench:db:compare before.json
 * after.json`) and prints a markdown before/after table for a PR description.
 *
 * Time ratios on sub-millisecond benchmarks are mostly noise; buffer ratios are
 * stable across runs, so read those first. "plan" flags a benchmark whose
 * index or sequential-scan set changed, listed under the table.
 */

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import {
  RESULT_VERSION,
  fmtMs,
  fmtCount,
  markdownTable,
  totalBuffers,
  type BenchResult,
  type RunFile,
  type RunMeta,
} from "./results";

function load(file: string): RunFile {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RunFile;
  if (parsed.meta?.version !== RESULT_VERSION) {
    throw new Error(`${file}: result version ${parsed.meta?.version}, expected ${RESULT_VERSION}`);
  }
  return parsed;
}

function ratio(before: number, after: number, threshold: number): string {
  if (before === 0 && after === 0) return "–";
  if (before === 0) return "new";
  const r = after / before;
  const text = `${r.toFixed(2)}×`;
  return r >= threshold ? `**${text}**` : text;
}

function describe(meta: RunMeta): string {
  const sha = meta.git.sha.slice(0, 8);
  return `${meta.git.branch}@${sha}${meta.git.dirty ? " (dirty)" : ""}, ${meta.startedAt}`;
}

/** Differences in machine, Postgres or dataset that make the comparison suspect. */
function metaWarnings(a: RunMeta, b: RunMeta): string[] {
  const out: string[] = [];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  if (!same(a.machine, b.machine)) out.push("different machines");
  if (a.postgres.version !== b.postgres.version) out.push("different Postgres versions");
  if (!same(a.postgres.settings, b.postgres.settings)) out.push("different Postgres settings");
  const keys = new Set([...Object.keys(a.dataset), ...Object.keys(b.dataset)]);
  for (const k of keys) {
    if (k !== "size" && a.dataset[k] !== b.dataset[k]) {
      out.push(`dataset ${k}: ${a.dataset[k]} → ${b.dataset[k]}`);
    }
  }
  return out;
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { threshold: { type: "string", default: "1.2" } },
  });
  if (positionals.length !== 2) {
    throw new Error("usage: pnpm bench:db:compare <before.json> <after.json> [--threshold 1.2]");
  }
  const threshold = Number(values.threshold);
  const [before, after] = positionals.map(load);
  const afterByName = new Map(after.results.map((r) => [r.name, r]));
  const beforeNames = new Set(before.results.map((r) => r.name));

  const rows: string[][] = [];
  const planNotes: string[] = [];
  const pair = (b: BenchResult | undefined, a: BenchResult | undefined, name: string) => {
    if (!b || !a) {
      rows.push([
        name,
        b ? fmtMs(b.ms.median) : "–",
        a ? fmtMs(a.ms.median) : "–",
        "",
        "",
        "",
        "",
        "",
        a ? "added" : "removed",
      ]);
      return;
    }
    const added = a.access.filter((x) => !b.access.includes(x));
    const removed = b.access.filter((x) => !a.access.includes(x));
    const planChanged = added.length > 0 || removed.length > 0;
    if (planChanged) {
      planNotes.push(
        `- \`${name}\`: ${[...added.map((x) => `+${x}`), ...removed.map((x) => `−${x}`)].join(", ")}`
      );
    }
    rows.push([
      name,
      fmtMs(b.ms.median),
      fmtMs(a.ms.median),
      ratio(b.ms.median, a.ms.median, threshold),
      fmtCount(totalBuffers(b.buffers)),
      fmtCount(totalBuffers(a.buffers)),
      ratio(totalBuffers(b.buffers), totalBuffers(a.buffers), threshold),
      b.triggerMs > 0 || a.triggerMs > 0 ? `${fmtMs(b.triggerMs)} → ${fmtMs(a.triggerMs)}` : "",
      planChanged ? "changed" : "",
    ]);
  };
  for (const b of before.results) pair(b, afterByName.get(b.name), b.name);
  for (const a of after.results) if (!beforeNames.has(a.name)) pair(undefined, a, a.name);

  console.log(`Before: ${describe(before.meta)}  \nAfter: ${describe(after.meta)}\n`);
  const warnings = metaWarnings(before.meta, after.meta);
  if (warnings.length > 0) {
    console.log(`**Not comparable as-is:** ${warnings.join("; ")}.\n`);
  }
  console.log(
    markdownTable(
      [
        "benchmark",
        "before ms",
        "after ms",
        "time",
        "before buf",
        "after buf",
        "buffers",
        "trigger ms",
        "plan",
      ],
      rows
    )
  );
  if (planNotes.length > 0) {
    console.log(
      `\nIndexes (idx:) and sequential scans (seq:) that changed:\n\n${planNotes.join("\n")}`
    );
  }
}

main();
