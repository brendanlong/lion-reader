/**
 * DOCX_WORKER_MAX_HEAP_MB is the only thing bounding a .docx conversion's
 * memory, so a value that can't be a heap cap (NaN would mean no cap, zero or
 * negative an OOM on every conversion) must stop the process at startup.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

const original = process.env.DOCX_WORKER_MAX_HEAP_MB;

async function loadHeapMb(value: string | undefined): Promise<number> {
  if (value === undefined) {
    delete process.env.DOCX_WORKER_MAX_HEAP_MB;
  } else {
    process.env.DOCX_WORKER_MAX_HEAP_MB = value;
  }
  vi.resetModules();
  const { usageLimitsConfig } = await import("@/server/config/env");
  return usageLimitsConfig.docxWorkerMaxHeapMb;
}

afterEach(() => {
  if (original === undefined) {
    delete process.env.DOCX_WORKER_MAX_HEAP_MB;
  } else {
    process.env.DOCX_WORKER_MAX_HEAP_MB = original;
  }
  vi.resetModules();
});

describe("DOCX_WORKER_MAX_HEAP_MB", () => {
  it("defaults to 64", async () => {
    expect(await loadHeapMb(undefined)).toBe(64);
  });

  it("accepts a positive integer", async () => {
    expect(await loadHeapMb("48")).toBe(48);
  });

  it.each(["abc", "0", "-16", "12.5", "64MB"])("rejects %j", async (value) => {
    await expect(loadHeapMb(value)).rejects.toThrow(/DOCX_WORKER_MAX_HEAP_MB/);
  });
});
