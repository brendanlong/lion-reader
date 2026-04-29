/**
 * Concurrent load runner with latency collection.
 *
 * Runs a workload function at a specified concurrency level for a given
 * duration, collecting per-request latency measurements.
 */

export interface LoadConfig {
  /** Number of concurrent workers */
  concurrency: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Async function to execute for each request */
  fn: () => Promise<void>;
}

export interface LoadResult {
  latencies: number[];
  errors: number;
  durationMs: number;
}

/**
 * Run a load test with the given configuration.
 *
 * Spawns `concurrency` workers that continuously call `fn()` until
 * `durationMs` has elapsed. Returns all latency measurements.
 */
export async function runLoad(config: LoadConfig): Promise<LoadResult> {
  const { concurrency, durationMs, fn } = config;
  const latencies: number[] = [];
  let errors = 0;
  const startTime = Date.now();
  const endTime = startTime + durationMs;

  const workers = Array.from({ length: concurrency }, async () => {
    while (Date.now() < endTime) {
      const reqStart = performance.now();
      try {
        await fn();
        const elapsed = Math.round(performance.now() - reqStart);
        latencies.push(elapsed);
      } catch {
        errors++;
      }
    }
  });

  await Promise.all(workers);

  return {
    latencies,
    errors,
    durationMs: Date.now() - startTime,
  };
}
