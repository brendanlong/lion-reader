/**
 * Scenario type definition shared by all benchmark scenarios.
 */

import type { BenchmarkClient } from "./http";

export interface ScenarioConfig {
  /** Display name for the scenario */
  name: string;
  /** Number of concurrent workers */
  concurrency: number;
  /** Duration in milliseconds */
  durationMs: number;
  /**
   * Set up any per-scenario state. Called once before the load test.
   * Can return data used by the run function.
   */
  setup?: (client: BenchmarkClient) => Promise<void>;
  /** The function to execute for each request */
  run: (client: BenchmarkClient) => Promise<void>;
}
