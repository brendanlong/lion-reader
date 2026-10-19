import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthCheckResult } from "@/server/metrics/server";
import { superviseProcess, type ProcessRuntime } from "@/server/process";

const DRAIN_TIMEOUT_MS = 100;

type Start = Parameters<typeof superviseProcess>[0]["start"];

function supervise(start: Start) {
  let signal: (reason: string) => void = () => {};
  const runtime = {
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    deadlineMs: 1_000,
    exit: vi.fn<ProcessRuntime["exit"]>(),
    handleSignals: (shutdown: (reason: string) => void) => {
      signal = shutdown;
    },
    setHealthChecker: vi.fn<ProcessRuntime["setHealthChecker"]>(),
    startHeartbeat: vi.fn<ProcessRuntime["startHeartbeat"]>(() => () => {}),
    reportStartupError: vi.fn<ProcessRuntime["reportStartupError"]>(),
    closeSharedResources: vi.fn<ProcessRuntime["closeSharedResources"]>(async () => {}),
    flushSentry: vi.fn<ProcessRuntime["flushSentry"]>(async () => {}),
  } satisfies ProcessRuntime;
  superviseProcess(
    {
      name: "test process",
      heartbeat: { url: "https://hc.example/ping", intervalMs: 60_000 },
      start,
    },
    runtime
  );
  return { runtime, sigterm: () => signal("SIGTERM") };
}

const healthy = (): HealthCheckResult => ({ status: "healthy" });

describe("superviseProcess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("idles without a heartbeat when start reports the process disabled", async () => {
    const { runtime, sigterm } = supervise(async () => null);
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.startHeartbeat).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();

    sigterm();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.closeSharedResources).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("reports a startup failure and exits 1 without a heartbeat", async () => {
    const error = new Error("bad config");
    const { runtime } = supervise(async () => {
      throw error;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.reportStartupError).toHaveBeenCalledWith(error);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.startHeartbeat).not.toHaveBeenCalled();
  });

  it("leaves the DB pool and Redis open when the drain times out", async () => {
    const { runtime, sigterm } = supervise(async () => ({
      stop: () => new Promise<void>(() => {}),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.startHeartbeat).toHaveBeenCalled();

    sigterm();
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS);

    expect(runtime.closeSharedResources).not.toHaveBeenCalled();
    expect(runtime.flushSentry).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(0);
  });

  it("never reports itself alive when a signal arrives before start resolves", async () => {
    let started: (service: Awaited<ReturnType<Start>>) => void = () => {};
    const { runtime, sigterm } = supervise(() => new Promise((resolve) => (started = resolve)));

    sigterm();
    started({ stop: async () => {}, checkHealth: healthy });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.startHeartbeat).not.toHaveBeenCalled();
    expect(runtime.setHealthChecker).not.toHaveBeenCalled();
  });
});
