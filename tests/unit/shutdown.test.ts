import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdown } from "@/server/shutdown";

const DRAIN_TIMEOUT_MS = 100;
const DEADLINE_MS = 1_000;

function setup(overrides: {
  drain?: (timeout: AbortSignal) => Promise<void>;
  cleanup?: (result: { drained: boolean }) => Promise<void>;
}) {
  const steps: string[] = [];
  const exit = vi.fn((code: number) => {
    steps.push(`exit ${code}`);
  });
  const shutdown = createShutdown({
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    deadlineMs: DEADLINE_MS,
    exit,
    drain:
      overrides.drain ??
      (async () => {
        steps.push("drain");
      }),
    cleanup:
      overrides.cleanup ??
      (async ({ drained }) => {
        steps.push(`cleanup drained=${drained}`);
      }),
  });
  return { shutdown, exit, steps };
}

describe("createShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains, cleans up, then exits once, ignoring later triggers", async () => {
    const { shutdown, exit, steps } = setup({});

    shutdown("SIGTERM");
    shutdown("SIGINT");
    shutdown("worker run loop exited", 1);
    await vi.runAllTimersAsync();

    expect(steps).toEqual(["drain", "cleanup drained=true", "exit 0"]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits with the requested code after a clean shutdown", async () => {
    const { shutdown, steps } = setup({});

    shutdown("startup failure", 1);
    await vi.runAllTimersAsync();

    expect(steps).toEqual(["drain", "cleanup drained=true", "exit 1"]);
  });

  it("aborts a drain that outlasts the drain timeout and tells cleanup it didn't drain", async () => {
    const { shutdown, steps } = setup({
      // Like a worker whose job never finishes: stop waiting only on abort.
      drain: (timeout) =>
        new Promise((resolve) => timeout.addEventListener("abort", () => resolve())),
    });

    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 1);
    expect(steps).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(steps).toEqual(["cleanup drained=false", "exit 0"]);
  });

  it.each([
    ["drain", { drain: () => Promise.reject(new Error("stop failed")) }, []],
    ["cleanup", { cleanup: () => Promise.reject(new Error("pool.end failed")) }, ["drain"]],
  ] as const)("exits 1 when %s throws", async (_step, overrides, before) => {
    const { shutdown, steps } = setup(overrides);

    shutdown("SIGTERM");
    await vi.runAllTimersAsync();

    expect(steps).toEqual([...before, "exit 1"]);
  });

  it("finishes in production before fly.toml's kill_timeout SIGKILLs the process", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      const { DRAIN_TIMEOUT_MS, SHUTDOWN_DEADLINE_MS } = await import("@/server/shutdown");
      const flyToml = readFileSync(join(process.cwd(), "fly.toml"), "utf8");
      const killTimeoutMs = Number(/^kill_timeout = (\d+)$/m.exec(flyToml)?.[1]) * 1000;

      expect(DRAIN_TIMEOUT_MS).toBeLessThan(SHUTDOWN_DEADLINE_MS);
      expect(SHUTDOWN_DEADLINE_MS).toBeLessThan(killTimeoutMs);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forces exit 1 at the deadline if a step never settles", async () => {
    const { shutdown, steps } = setup({ cleanup: () => new Promise(() => {}) });

    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(steps).toEqual(["drain"]);
    await vi.advanceTimersByTimeAsync(1);

    expect(steps).toEqual(["drain", "exit 1"]);
  });
});
