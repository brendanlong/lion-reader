/**
 * Unit tests for voice download manager.
 *
 * These tests verify URL construction, progress tracking, and error handling
 * for downloading Piper TTS voices from HuggingFace.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { indexedDB } from "fake-indexeddb";

// Set up globals BEFORE importing the module under test
vi.stubGlobal("window", { indexedDB });
vi.stubGlobal("indexedDB", indexedDB);

import {
  getVoiceDownloadUrls,
  fetchWithProgress,
  downloadVoice,
  isVoiceDownloaded,
  deleteDownloadedVoice,
  getDownloadedVoices,
  VoiceDownloadError,
} from "../../src/lib/narration/voice-download";
import { VoiceCache } from "../../src/lib/narration/voice-cache";
import { ENHANCED_VOICES } from "../../src/lib/narration/enhanced-voices";

describe("getVoiceDownloadUrls", () => {
  it("constructs correct URLs for en_US-lessac-medium", () => {
    const urls = getVoiceDownloadUrls("en_US-lessac-medium");

    expect(urls.modelUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
    );
    expect(urls.configUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json"
    );
  });

  it("constructs correct URLs for en_US-amy-low", () => {
    const urls = getVoiceDownloadUrls("en_US-amy-low");

    expect(urls.modelUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx"
    );
    expect(urls.configUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx.json"
    );
  });

  it("constructs correct URLs for en_GB-alba-medium", () => {
    const urls = getVoiceDownloadUrls("en_GB-alba-medium");

    expect(urls.modelUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx"
    );
    expect(urls.configUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json"
    );
  });

  it("constructs correct URLs for en_AU-karen-medium", () => {
    const urls = getVoiceDownloadUrls("en_AU-karen-medium");

    expect(urls.modelUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_AU/karen/medium/en_AU-karen-medium.onnx"
    );
    expect(urls.configUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_AU/karen/medium/en_AU-karen-medium.onnx.json"
    );
  });

  it("constructs correct URLs for en_US-ryan-medium", () => {
    const urls = getVoiceDownloadUrls("en_US-ryan-medium");

    expect(urls.modelUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx"
    );
    expect(urls.configUrl).toBe(
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/medium/en_US-ryan-medium.onnx.json"
    );
  });

  it("throws error for invalid voice ID format", () => {
    expect(() => getVoiceDownloadUrls("invalid")).toThrow(
      'Invalid voice ID format: invalid. Expected format: "xx_XX-speaker-quality"'
    );
  });

  it("throws error for voice ID with wrong separator", () => {
    expect(() => getVoiceDownloadUrls("en-US-lessac-medium")).toThrow("Invalid voice ID format");
  });

  it("throws error for voice ID with missing parts", () => {
    expect(() => getVoiceDownloadUrls("en_US-lessac")).toThrow("Invalid voice ID format");
  });

  it("throws error for voice ID with wrong case", () => {
    expect(() => getVoiceDownloadUrls("EN_us-lessac-medium")).toThrow("Invalid voice ID format");
  });
});

describe("fetchWithProgress", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns ArrayBuffer on successful fetch", async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-length", "5"]]),
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: testData })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });

    const result = await fetchWithProgress("https://example.com/file.bin");

    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBe(5);
  });

  it("calls progress callback during download", async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);
    const onProgress = vi.fn();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-length", "5"]]),
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: testData })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });

    await fetchWithProgress("https://example.com/file.bin", onProgress);

    expect(onProgress).toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith(1); // 5/5 = 1
  });

  it("calls progress callback multiple times for chunked data", async () => {
    const chunk1 = new Uint8Array([1, 2]);
    const chunk2 = new Uint8Array([3, 4]);
    const chunk3 = new Uint8Array([5]);
    const onProgress = vi.fn();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-length", "5"]]),
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: chunk1 })
            .mockResolvedValueOnce({ done: false, value: chunk2 })
            .mockResolvedValueOnce({ done: false, value: chunk3 })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });

    await fetchWithProgress("https://example.com/file.bin", onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.4); // 2/5
    expect(onProgress).toHaveBeenNthCalledWith(2, 0.8); // 4/5
    expect(onProgress).toHaveBeenNthCalledWith(3, 1); // 5/5
  });

  it("throws error on HTTP error status", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(fetchWithProgress("https://example.com/file.bin")).rejects.toThrow(
      "HTTP 404: Not Found"
    );
  });

  it("throws error on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    await expect(fetchWithProgress("https://example.com/file.bin")).rejects.toThrow(
      "Network error"
    );
  });

  it("falls back to arrayBuffer() when no content-length header", async () => {
    const testData = new ArrayBuffer(5);
    const onProgress = vi.fn();

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map(),
      body: null,
      arrayBuffer: vi.fn().mockResolvedValue(testData),
    });

    const result = await fetchWithProgress("https://example.com/file.bin", onProgress);

    expect(result).toBe(testData);
    expect(onProgress).toHaveBeenCalledWith(1);
  });

  it("works without progress callback", async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5]);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-length", "5"]]),
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({ done: false, value: testData })
            .mockResolvedValueOnce({ done: true, value: undefined }),
        }),
      },
    });

    const result = await fetchWithProgress("https://example.com/file.bin");

    expect(result).toBeInstanceOf(ArrayBuffer);
  });
});

describe("downloadVoice", () => {
  let cache: VoiceCache;
  const originalFetch = global.fetch;

  beforeEach(() => {
    cache = new VoiceCache();
  });

  afterEach(async () => {
    await cache.deleteDatabase();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockSuccessfulDownload(): void {
    const modelData = new Uint8Array([1, 2, 3, 4, 5]);
    const configData = JSON.stringify({ sampleRate: 22050 });

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith(".onnx")) {
        return Promise.resolve({
          ok: true,
          headers: new Map([["content-length", "5"]]),
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: modelData })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            }),
          },
        });
      } else if (url.endsWith(".onnx.json")) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(configData),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });
  }

  it("downloads and stores voice in cache", async () => {
    mockSuccessfulDownload();

    await downloadVoice("en_US-lessac-medium", undefined, cache);

    const entry = await cache.get("en_US-lessac-medium");
    expect(entry).toBeDefined();
    expect(entry?.voiceId).toBe("en_US-lessac-medium");
    expect(entry?.version).toBe("1.0");
  });

  it("calls progress callback during download", async () => {
    mockSuccessfulDownload();
    const onProgress = vi.fn();

    await downloadVoice("en_US-lessac-medium", onProgress, cache);

    expect(onProgress).toHaveBeenCalled();
    // Should end with 1 (100%)
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it("throws VoiceDownloadError for unknown voice", async () => {
    await expect(downloadVoice("unknown-voice", undefined, cache)).rejects.toThrow(
      VoiceDownloadError
    );

    try {
      await downloadVoice("unknown-voice", undefined, cache);
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceDownloadError);
      expect((error as VoiceDownloadError).voiceId).toBe("unknown-voice");
      expect((error as VoiceDownloadError).message).toContain("Unknown voice");
    }
  });

  it("throws VoiceDownloadError on model download failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    await expect(downloadVoice("en_US-lessac-medium", undefined, cache)).rejects.toThrow(
      VoiceDownloadError
    );

    try {
      await downloadVoice("en_US-lessac-medium", undefined, cache);
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceDownloadError);
      expect((error as VoiceDownloadError).voiceId).toBe("en_US-lessac-medium");
      expect((error as VoiceDownloadError).message).toContain("Failed to download model");
    }
  });

  it("throws VoiceDownloadError on config download failure", async () => {
    const modelData = new Uint8Array([1, 2, 3, 4, 5]);

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith(".onnx")) {
        return Promise.resolve({
          ok: true,
          headers: new Map([["content-length", "5"]]),
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: modelData })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            }),
          },
        });
      } else if (url.endsWith(".onnx.json")) {
        return Promise.resolve({
          ok: false,
          status: 404,
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    await expect(downloadVoice("en_US-lessac-medium", undefined, cache)).rejects.toThrow(
      VoiceDownloadError
    );

    try {
      await downloadVoice("en_US-lessac-medium", undefined, cache);
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceDownloadError);
      expect((error as VoiceDownloadError).message).toContain("Failed to download config");
    }
  });

  it("stores correct config data", async () => {
    const configData = JSON.stringify({
      sampleRate: 22050,
      numSymbols: 256,
    });

    const modelData = new Uint8Array([1, 2, 3, 4, 5]);

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith(".onnx")) {
        return Promise.resolve({
          ok: true,
          headers: new Map([["content-length", "5"]]),
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: modelData })
                .mockResolvedValueOnce({ done: true, value: undefined }),
            }),
          },
        });
      } else if (url.endsWith(".onnx.json")) {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(configData),
        });
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    await downloadVoice("en_US-lessac-medium", undefined, cache);

    const entry = await cache.get("en_US-lessac-medium");
    expect(entry?.configData).toBe(configData);
    expect(JSON.parse(entry?.configData ?? "")).toEqual({
      sampleRate: 22050,
      numSymbols: 256,
    });
  });
});

describe("isVoiceDownloaded", () => {
  let cache: VoiceCache;

  beforeEach(() => {
    cache = new VoiceCache();
  });

  afterEach(async () => {
    await cache.deleteDatabase();
  });

  it("returns false for non-downloaded voice", async () => {
    const result = await isVoiceDownloaded("en_US-lessac-medium", cache);
    expect(result).toBe(false);
  });

  it("returns true for downloaded voice", async () => {
    // Put a voice in the cache
    await cache.put({
      voiceId: "en_US-lessac-medium",
      modelData: new ArrayBuffer(10),
      configData: "{}",
      downloadedAt: Date.now(),
      version: "1.0",
    });

    const result = await isVoiceDownloaded("en_US-lessac-medium", cache);
    expect(result).toBe(true);
  });
});

describe("deleteDownloadedVoice", () => {
  let cache: VoiceCache;

  beforeEach(() => {
    cache = new VoiceCache();
  });

  afterEach(async () => {
    await cache.deleteDatabase();
  });

  it("returns false when voice is not downloaded", async () => {
    const result = await deleteDownloadedVoice("en_US-lessac-medium", cache);
    expect(result).toBe(false);
  });

  it("deletes downloaded voice and returns true", async () => {
    // Put a voice in the cache
    await cache.put({
      voiceId: "en_US-lessac-medium",
      modelData: new ArrayBuffer(10),
      configData: "{}",
      downloadedAt: Date.now(),
      version: "1.0",
    });

    const result = await deleteDownloadedVoice("en_US-lessac-medium", cache);
    expect(result).toBe(true);

    // Verify it's gone
    const entry = await cache.get("en_US-lessac-medium");
    expect(entry).toBeUndefined();
  });
});

describe("getDownloadedVoices", () => {
  let cache: VoiceCache;

  beforeEach(() => {
    cache = new VoiceCache();
  });

  afterEach(async () => {
    await cache.deleteDatabase();
  });

  it("returns empty array when no voices downloaded", async () => {
    const result = await getDownloadedVoices(cache);
    expect(result).toEqual([]);
  });

  it("returns downloaded enhanced voices", async () => {
    // Put some voices in the cache
    await cache.put({
      voiceId: "en_US-lessac-medium",
      modelData: new ArrayBuffer(10),
      configData: "{}",
      downloadedAt: Date.now(),
      version: "1.0",
    });

    await cache.put({
      voiceId: "en_GB-alba-medium",
      modelData: new ArrayBuffer(10),
      configData: "{}",
      downloadedAt: Date.now(),
      version: "1.0",
    });

    const result = await getDownloadedVoices(cache);

    expect(result).toHaveLength(2);
    expect(result.map((v) => v.id).sort()).toEqual(["en_GB-alba-medium", "en_US-lessac-medium"]);
  });

  it("filters out unknown voice IDs", async () => {
    // Put a known voice
    await cache.put({
      voiceId: "en_US-lessac-medium",
      modelData: new ArrayBuffer(10),
      configData: "{}",
      downloadedAt: Date.now(),
      version: "1.0",
    });

    // Put an unknown voice (maybe from an old version)
    await cache.put({
      voiceId: "unknown-voice-id",
      modelData: new ArrayBuffer(10),
      configData: "{}",
      downloadedAt: Date.now(),
      version: "1.0",
    });

    const result = await getDownloadedVoices(cache);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("en_US-lessac-medium");
  });
});

describe("VoiceDownloadError", () => {
  it("has correct name property", () => {
    const error = new VoiceDownloadError("Test message", "test-voice");
    expect(error.name).toBe("VoiceDownloadError");
  });

  it("stores voiceId property", () => {
    const error = new VoiceDownloadError("Test message", "en_US-lessac-medium");
    expect(error.voiceId).toBe("en_US-lessac-medium");
  });

  it("stores cause property", () => {
    const cause = new Error("Original error");
    const error = new VoiceDownloadError("Test message", "test-voice", cause);
    expect(error.cause).toBe(cause);
  });

  it("is instanceof Error", () => {
    const error = new VoiceDownloadError("Test message", "test-voice");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("ENHANCED_VOICES constant", () => {
  it("contains all curated voices", () => {
    expect(ENHANCED_VOICES).toHaveLength(5);

    const voiceIds = ENHANCED_VOICES.map((v) => v.id);
    expect(voiceIds).toContain("en_US-lessac-medium");
    expect(voiceIds).toContain("en_US-amy-low");
    expect(voiceIds).toContain("en_US-ryan-medium");
    expect(voiceIds).toContain("en_GB-alba-medium");
    expect(voiceIds).toContain("en_AU-karen-medium");
  });

  it("has valid URL patterns for all voices", () => {
    for (const voice of ENHANCED_VOICES) {
      // Should not throw
      const urls = getVoiceDownloadUrls(voice.id);
      expect(urls.modelUrl).toContain(voice.id);
      expect(urls.configUrl).toContain(voice.id);
    }
  });

  it("has reasonable size estimates", () => {
    for (const voice of ENHANCED_VOICES) {
      expect(voice.sizeBytes).toBeGreaterThan(0);
      // Low quality should be smaller
      if (voice.quality === "low") {
        expect(voice.sizeBytes).toBeLessThan(30 * 1024 * 1024); // < 30 MB
      }
      // Medium quality should be ~50 MB
      if (voice.quality === "medium") {
        expect(voice.sizeBytes).toBe(50 * 1024 * 1024);
      }
    }
  });

  it("has valid language codes", () => {
    const validLangCodes = ["en-US", "en-GB", "en-AU"];

    for (const voice of ENHANCED_VOICES) {
      expect(validLangCodes).toContain(voice.language);
    }
  });
});
