/**
 * Benchmark results I/O - read/write JSON result files.
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LatencyStats } from "./stats";

export interface ScenarioResult {
  name: string;
  latency: LatencyStats;
  qps: number;
  errors: number;
  durationMs: number;
}

export interface MemorySample {
  timestampMs: number;
  rssKb: number;
}

export interface BenchmarkResult {
  commitSha: string;
  commitDate: string;
  runDate: string;
  scenarios: ScenarioResult[];
  peakRssKb: number | null;
  memoryTimeSeries: MemorySample[];
}

const RESULTS_DIR = join(process.cwd(), "benchmarks", "results");

export async function writeResults(result: BenchmarkResult): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const filename = `${result.commitSha}-${Date.now()}.json`;
  const filepath = join(RESULTS_DIR, filename);
  await writeFile(filepath, JSON.stringify(result, null, 2));
  return filepath;
}

export async function readResults(filepath: string): Promise<BenchmarkResult> {
  const content = await readFile(filepath, "utf-8");
  return JSON.parse(content) as BenchmarkResult;
}
