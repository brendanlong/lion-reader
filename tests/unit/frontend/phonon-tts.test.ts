/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoadOptions, ModelSpec } from "phonon-tts";

const { mockLoad } = vi.hoisted(() => ({ mockLoad: vi.fn() }));
vi.mock("phonon-tts", () => ({ PhononTTS: { load: mockLoad } }));

import {
  downloadPhononModel,
  getPhononModelState,
  loadPhonon,
  removePhononModel,
  subscribePhononModelState,
} from "@/lib/narration/phonon-tts";
import {
  createMemoryCacheStorage,
  type MemoryCacheStorage,
} from "../../utils/memory-cache-storage";
import {
  ENHANCED_VOICES,
  enhancedVoiceUrl,
  PHONON_MODEL_FILES,
} from "@/lib/narration/enhanced-voices";

const ALL_FILES = [
  PHONON_MODEL_FILES.weights,
  PHONON_MODEL_FILES.tokenizer,
  PHONON_MODEL_FILES.config,
  ...ENHANCED_VOICES.map((voice) => enhancedVoiceUrl(voice.id)),
];

let storage: MemoryCacheStorage;
const storedFiles = () => storage.storedUrls();

function fakeTts() {
  return { dispose: vi.fn(), sampleRate: 24_000 };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("phonon-tts", () => {
  beforeEach(async () => {
    storage = createMemoryCacheStorage();
    vi.stubGlobal("caches", storage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => new Response(`bytes of ${url}`))
    );
    let blobs = 0;
    URL.createObjectURL = vi.fn(() => `blob:test/${++blobs}`);
    URL.revokeObjectURL = vi.fn();
    mockLoad.mockReset();
    mockLoad.mockImplementation(async () => fakeTts());
    await removePhononModel();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores every model and voice file, reporting progress", async () => {
    const progress: number[] = [];
    await downloadPhononModel((fraction) => progress.push(fraction));

    expect(storedFiles().sort()).toEqual([...ALL_FILES].sort());
    expect(getPhononModelState()).toBe("downloaded");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });

  it("fetches only what a failed download didn't store", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      return url === PHONON_MODEL_FILES.config
        ? new Response("", { status: 503 })
        : new Response(`bytes of ${url}`);
    });
    await expect(downloadPhononModel()).rejects.toThrow("503");
    expect(getPhononModelState()).toBe("missing");

    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockImplementation(async (input) => new Response(`bytes of ${String(input)}`));
    await downloadPhononModel();

    const refetched = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(refetched).toContain(PHONON_MODEL_FILES.config);
    expect(refetched).not.toContain(PHONON_MODEL_FILES.weights);
    expect(getPhononModelState()).toBe("downloaded");
  });

  it("drops files from a model or voice version we no longer use", async () => {
    const stale = "https://huggingface.co/gradium/phonon-31m-en/resolve/old/model.q8.gguf";
    const cache = await storage.open("lion-reader-phonon");
    cache.files.set(stale, new Uint8Array(1));

    await downloadPhononModel();

    expect(storedFiles()).not.toContain(stale);
  });

  it("lets a removal requested mid-download finish last", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(fetch).mockImplementation(async (input) => {
      await gate;
      return new Response(`bytes of ${String(input)}`);
    });

    const download = downloadPhononModel();
    const removal = removePhononModel();
    release();
    await download;
    await removal;

    expect(storedFiles()).toEqual([]);
    expect(getPhononModelState()).toBe("missing");
  });

  it("loads the stored files through blob URLs, once for every caller", async () => {
    await downloadPhononModel();

    const [a, b] = await Promise.all([loadPhonon(), loadPhonon()]);

    expect(a).toBe(b);
    expect(mockLoad).toHaveBeenCalledTimes(1);
    const options = mockLoad.mock.calls[0][0] as LoadOptions;
    const model = options.model as ModelSpec;
    expect(options.cache).toBe(false);
    expect(String(model.weights.q8)).toMatch(/^blob:/);
    expect(Object.keys(model.voices ?? {}).sort()).toEqual(ENHANCED_VOICES.map((v) => v.id).sort());
    // The model's URLs go once it's loaded; voices load on first use.
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith(model.weights.q8);
    expect(vi.mocked(URL.revokeObjectURL)).not.toHaveBeenCalledWith(
      Object.values(model.voices ?? {})[0]
    );
  });

  it("releases the voices' URLs when the model is removed", async () => {
    await downloadPhononModel();
    await loadPhonon();
    const model = (mockLoad.mock.calls[0][0] as LoadOptions).model as ModelSpec;
    const voices = Object.values(model.voices ?? {});
    expect(voices).toHaveLength(ENHANCED_VOICES.length);

    await removePhononModel();

    for (const url of voices) expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith(url);
  });

  it("refuses to load before the download", async () => {
    await expect(loadPhonon()).rejects.toThrow("isn't downloaded");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("disposes a model deleted while it loads", async () => {
    await downloadPhononModel();
    const tts = fakeTts();
    let finishLoad!: (value: ReturnType<typeof fakeTts>) => void;
    mockLoad.mockImplementation(() => new Promise((resolve) => (finishLoad = resolve)));

    const load = loadPhonon();
    await flush();
    const removal = removePhononModel();
    finishLoad(tts);

    await load;
    await removal;
    expect(tts.dispose).toHaveBeenCalled();
    expect(getPhononModelState()).toBe("missing");
  });

  it("doesn't load a model requested while it's being removed", async () => {
    await downloadPhononModel();
    const removal = removePhononModel();
    const load = loadPhonon();

    await removal;
    await expect(load).rejects.toThrow("isn't downloaded");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("stores nothing of a file whose download breaks off", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url !== PHONON_MODEL_FILES.weights) return new Response(`bytes of ${url}`);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.error(new TypeError("network error"));
        },
      });
      return new Response(body);
    });

    await expect(downloadPhononModel()).rejects.toThrow("network error");

    expect(storedFiles()).not.toContain(PHONON_MODEL_FILES.weights);
    expect(getPhononModelState()).toBe("missing");
  });

  it("frees this tab's model when another tab removes the files", async () => {
    await downloadPhononModel();
    const tts = fakeTts();
    mockLoad.mockResolvedValue(tts);
    await loadPhonon();
    const unsubscribe = subscribePhononModelState(() => {});

    await storage.delete("lion-reader-phonon");
    const otherTab = new BroadcastChannel("lion-reader-phonon");
    otherTab.postMessage("changed");
    otherTab.close();

    await vi.waitFor(() => expect(tts.dispose).toHaveBeenCalled());
    unsubscribe();
  });

  it("hears another tab's download", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribePhononModelState(listener);
    await flush();
    expect(getPhononModelState()).toBe("missing");

    // Another tab stores the files, then says so.
    const cache = await storage.open("lion-reader-phonon");
    for (const url of ALL_FILES) cache.files.set(url, new Uint8Array(1));
    const otherTab = new BroadcastChannel("lion-reader-phonon");
    otherTab.postMessage("changed");
    otherTab.close();

    await vi.waitFor(() => expect(getPhononModelState()).toBe("downloaded"));
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
