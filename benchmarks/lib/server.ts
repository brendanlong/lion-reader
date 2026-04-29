/**
 * Start/stop the Next.js server as a child process for benchmarking.
 *
 * Spawns `tsx scripts/server.ts` wrapped with `/usr/bin/time -v` to capture
 * peak RSS. Polls a health endpoint until the server is ready.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const BENCHMARK_PORT = 3456;
export const BASE_URL = `http://localhost:${BENCHMARK_PORT}`;

interface ServerHandle {
  process: ChildProcess;
  pid: number;
  /** Resolves to peak RSS in KB from /usr/bin/time -v, or null if unavailable. */
  peakRssPromise: Promise<number | null>;
}

export async function startServer(): Promise<ServerHandle> {
  let peakRssResolve: (val: number | null) => void;
  const peakRssPromise = new Promise<number | null>((resolve) => {
    peakRssResolve = resolve;
  });

  let stderr = "";

  // Try to use /usr/bin/time -v for peak RSS measurement
  const hasGnuTime = await checkGnuTime();

  const args = hasGnuTime ? ["-v", "tsx", "scripts/server.ts"] : [];
  const command = hasGnuTime ? "/usr/bin/time" : "tsx";
  const commandArgs = hasGnuTime ? args : ["scripts/server.ts"];

  const child = spawn(command, commandArgs, {
    env: {
      ...process.env,
      PORT: String(BENCHMARK_PORT),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.on("close", () => {
    // Parse peak RSS from GNU time output
    const match = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
    peakRssResolve!(match ? parseInt(match[1], 10) : null);
  });

  if (!child.pid) {
    throw new Error("Failed to spawn server process");
  }

  // Wait for the server to become ready
  await waitForServer();

  return {
    process: child,
    pid: child.pid,
    peakRssPromise,
  };
}

export async function stopServer(handle: ServerHandle): Promise<void> {
  handle.process.kill("SIGTERM");

  // Wait for graceful shutdown (up to 10s)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      handle.process.kill("SIGKILL");
      resolve();
    }, 10_000);

    handle.process.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForServer(maxAttempts = 120, intervalMs = 1000): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${BASE_URL}/api/trpc/auth.providers`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await delay(intervalMs);
  }
  throw new Error(`Server failed to start after ${maxAttempts * intervalMs}ms`);
}

async function checkGnuTime(): Promise<boolean> {
  try {
    const proc = spawn("/usr/bin/time", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise((resolve) => {
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
}
