/**
 * Memory monitoring via /proc/{pid}/status polling.
 *
 * Polls VmRSS from /proc/{pid}/status at regular intervals to build
 * a time-series of memory usage. Linux only.
 */

import { readFile } from "node:fs/promises";
import type { MemorySample } from "./results";

export interface MemoryMonitor {
  stop: () => MemorySample[];
}

/**
 * Start polling memory usage for a given PID.
 * Returns a handle with a stop() method that returns collected samples.
 */
export function startMemoryMonitor(pid: number, intervalMs = 1000): MemoryMonitor {
  const samples: MemorySample[] = [];
  const startTime = Date.now();
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const status = await readFile(`/proc/${pid}/status`, "utf-8");
        const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
        if (match) {
          samples.push({
            timestampMs: Date.now() - startTime,
            rssKb: parseInt(match[1], 10),
          });
        }
      } catch {
        // Process may have exited
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  // Start polling in background (fire and forget)
  poll();

  return {
    stop: () => {
      running = false;
      return samples;
    },
  };
}
