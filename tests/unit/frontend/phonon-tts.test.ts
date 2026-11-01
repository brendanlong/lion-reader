/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoadOptions } from "phonon-tts";

const { mockLoad, mockClearCache } = vi.hoisted(() => ({
  mockLoad: vi.fn(),
  mockClearCache: vi.fn(),
}));
vi.mock("phonon-tts", () => ({
  PhononTTS: { load: mockLoad },
  clearCache: mockClearCache,
}));

import { isPhononModelDownloaded, loadPhonon, removePhononModel } from "@/lib/narration/phonon-tts";
import { PHONON_MODEL_SIZE_BYTES } from "@/lib/narration/enhanced-voices";

interface PendingLoad {
  options: LoadOptions;
  resolve: (tts: { dispose: () => void }) => void;
  reject: (error: Error) => void;
}

/** Makes each `PhononTTS.load` wait until the test settles it. */
function deferLoads(): PendingLoad[] {
  const pending: PendingLoad[] = [];
  mockLoad.mockImplementation(
    (options: LoadOptions) =>
      new Promise((resolve, reject) => pending.push({ options, resolve, reject }))
  );
  return pending;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("phonon-tts", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockClearCache.mockResolvedValue(true);
    await removePhononModel();
  });

  it("shares one load between callers and reports its progress to each", async () => {
    const pending = deferLoads();
    const first = vi.fn();
    const second = vi.fn();
    const a = loadPhonon(first);
    const b = loadPhonon(second);
    await flush();
    expect(pending).toHaveLength(1);

    pending[0].options.onProgress?.({
      file: "weights",
      loaded: PHONON_MODEL_SIZE_BYTES / 2,
      total: null,
      cached: false,
    });
    expect(first).toHaveBeenLastCalledWith(0.5);
    expect(second).toHaveBeenLastCalledWith(0.5);

    const tts = { dispose: vi.fn() };
    pending[0].resolve(tts);
    expect(await a).toBe(tts);
    expect(await b).toBe(tts);
    expect(isPhononModelDownloaded()).toBe(true);
  });

  it("starts a fresh load after a failed one", async () => {
    const pending = deferLoads();
    const failed = loadPhonon();
    await flush();
    pending[0].reject(new Error("network"));
    await expect(failed).rejects.toThrow("network");
    expect(isPhononModelDownloaded()).toBe(false);

    const retry = loadPhonon();
    await flush();
    expect(pending).toHaveLength(2);
    pending[1].resolve({ dispose: vi.fn() });
    await retry;
    expect(isPhononModelDownloaded()).toBe(true);
  });

  it("doesn't mark a model deleted mid-load as downloaded", async () => {
    const pending = deferLoads();
    const load = loadPhonon();
    await flush();

    const removed = removePhononModel();
    const tts = { dispose: vi.fn() };
    pending[0].resolve(tts);
    await expect(load).rejects.toThrow();
    await removed;

    expect(isPhononModelDownloaded()).toBe(false);
    expect(tts.dispose).toHaveBeenCalled();
    expect(mockClearCache).toHaveBeenCalled();
  });
});
