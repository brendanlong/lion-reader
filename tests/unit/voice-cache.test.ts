/**
 * Unit tests for VoiceCache IndexedDB storage.
 *
 * These tests use fake-indexeddb to simulate IndexedDB in Node.js.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { indexedDB } from "fake-indexeddb";

// Set up globals BEFORE importing the module under test
// This must be done at module level because imports are hoisted
vi.stubGlobal("window", { indexedDB });
vi.stubGlobal("indexedDB", indexedDB);

import { VoiceCache, STORAGE_LIMIT_BYTES, type VoiceCacheEntry } from "../../src/lib/narration";

/**
 * Helper to create a test voice cache entry.
 */
function createTestEntry(voiceId: string, modelSizeBytes: number = 1024): VoiceCacheEntry {
  // Create an ArrayBuffer of the specified size
  const modelData = new ArrayBuffer(modelSizeBytes);

  return {
    voiceId,
    modelData,
    configData: JSON.stringify({ sampleRate: 22050, numSymbols: 100 }),
    downloadedAt: Date.now(),
    version: "1.0.0",
  };
}

describe("VoiceCache", () => {
  let cache: VoiceCache;

  beforeEach(async () => {
    cache = new VoiceCache();
  });

  afterEach(async () => {
    // Clean up the database after each test
    await cache.deleteDatabase();
  });

  describe("isAvailable", () => {
    it("returns true when indexedDB is available", () => {
      // fake-indexeddb provides indexedDB in the global scope
      expect(VoiceCache.isAvailable()).toBe(true);
    });

    it("returns false when window is undefined", () => {
      // Save the stubbed window
      const stubbedWindow = global.window;

      // Temporarily set window to undefined
      // @ts-expect-error - Intentionally setting to undefined for testing
      global.window = undefined;

      expect(VoiceCache.isAvailable()).toBe(false);

      // Restore the stubbed window
      global.window = stubbedWindow;
    });
  });

  describe("put and get", () => {
    it("stores and retrieves a voice entry", async () => {
      const entry = createTestEntry("en_US-lessac-medium", 2048);

      await cache.put(entry);
      const retrieved = await cache.get("en_US-lessac-medium");

      expect(retrieved).toBeDefined();
      expect(retrieved?.voiceId).toBe("en_US-lessac-medium");
      expect(retrieved?.modelData.byteLength).toBe(2048);
      expect(retrieved?.version).toBe("1.0.0");
    });

    it("returns undefined for non-existent voice", async () => {
      const result = await cache.get("non-existent-voice");
      expect(result).toBeUndefined();
    });

    it("updates existing entry when putting with same voiceId", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium", 1024);
      entry1.version = "1.0.0";

      const entry2 = createTestEntry("en_US-lessac-medium", 2048);
      entry2.version = "2.0.0";

      await cache.put(entry1);
      await cache.put(entry2);

      const retrieved = await cache.get("en_US-lessac-medium");

      expect(retrieved?.version).toBe("2.0.0");
      expect(retrieved?.modelData.byteLength).toBe(2048);
    });

    it("stores multiple different voices", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium");
      const entry2 = createTestEntry("en_GB-alba-medium");
      const entry3 = createTestEntry("en_US-amy-low");

      await cache.put(entry1);
      await cache.put(entry2);
      await cache.put(entry3);

      const retrieved1 = await cache.get("en_US-lessac-medium");
      const retrieved2 = await cache.get("en_GB-alba-medium");
      const retrieved3 = await cache.get("en_US-amy-low");

      expect(retrieved1?.voiceId).toBe("en_US-lessac-medium");
      expect(retrieved2?.voiceId).toBe("en_GB-alba-medium");
      expect(retrieved3?.voiceId).toBe("en_US-amy-low");
    });

    it("preserves configData correctly", async () => {
      const configData = JSON.stringify({
        sampleRate: 22050,
        numSymbols: 256,
        espeak: { voice: "en-us" },
      });

      const entry = createTestEntry("en_US-lessac-medium");
      entry.configData = configData;

      await cache.put(entry);
      const retrieved = await cache.get("en_US-lessac-medium");

      expect(retrieved?.configData).toBe(configData);
      expect(JSON.parse(retrieved?.configData ?? "")).toEqual({
        sampleRate: 22050,
        numSymbols: 256,
        espeak: { voice: "en-us" },
      });
    });
  });

  describe("delete", () => {
    it("deletes an existing voice entry", async () => {
      const entry = createTestEntry("en_US-lessac-medium");

      await cache.put(entry);
      const wasDeleted = await cache.delete("en_US-lessac-medium");

      expect(wasDeleted).toBe(true);

      const retrieved = await cache.get("en_US-lessac-medium");
      expect(retrieved).toBeUndefined();
    });

    it("returns false when deleting non-existent voice", async () => {
      const wasDeleted = await cache.delete("non-existent-voice");
      expect(wasDeleted).toBe(false);
    });

    it("does not affect other entries when deleting", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium");
      const entry2 = createTestEntry("en_GB-alba-medium");

      await cache.put(entry1);
      await cache.put(entry2);

      await cache.delete("en_US-lessac-medium");

      const retrieved1 = await cache.get("en_US-lessac-medium");
      const retrieved2 = await cache.get("en_GB-alba-medium");

      expect(retrieved1).toBeUndefined();
      expect(retrieved2?.voiceId).toBe("en_GB-alba-medium");
    });
  });

  describe("list", () => {
    it("returns empty array when no voices are cached", async () => {
      const voices = await cache.list();
      expect(voices).toEqual([]);
    });

    it("returns all cached voices", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium");
      const entry2 = createTestEntry("en_GB-alba-medium");
      const entry3 = createTestEntry("en_US-amy-low");

      await cache.put(entry1);
      await cache.put(entry2);
      await cache.put(entry3);

      const voices = await cache.list();

      expect(voices).toHaveLength(3);

      const voiceIds = voices.map((v) => v.voiceId).sort();
      expect(voiceIds).toEqual(["en_GB-alba-medium", "en_US-amy-low", "en_US-lessac-medium"]);
    });

    it("reflects deletions", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium");
      const entry2 = createTestEntry("en_GB-alba-medium");

      await cache.put(entry1);
      await cache.put(entry2);
      await cache.delete("en_US-lessac-medium");

      const voices = await cache.list();

      expect(voices).toHaveLength(1);
      expect(voices[0].voiceId).toBe("en_GB-alba-medium");
    });
  });

  describe("getStorageSize", () => {
    it("returns 0 when cache is empty", async () => {
      const size = await cache.getStorageSize();
      expect(size).toBe(0);
    });

    it("calculates size based on model data", async () => {
      const entry = createTestEntry("en_US-lessac-medium", 1024 * 1024); // 1 MB model
      await cache.put(entry);

      const size = await cache.getStorageSize();

      // Size should be at least the model size
      expect(size).toBeGreaterThanOrEqual(1024 * 1024);
    });

    it("accumulates sizes from multiple entries", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium", 1000);
      const entry2 = createTestEntry("en_GB-alba-medium", 2000);

      await cache.put(entry1);
      await cache.put(entry2);

      const size = await cache.getStorageSize();

      // Size should include both model sizes plus config and metadata
      expect(size).toBeGreaterThanOrEqual(3000);
    });

    it("decreases when entries are deleted", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium", 1000);
      const entry2 = createTestEntry("en_GB-alba-medium", 2000);

      await cache.put(entry1);
      await cache.put(entry2);

      const sizeBefore = await cache.getStorageSize();

      await cache.delete("en_GB-alba-medium");

      const sizeAfter = await cache.getStorageSize();

      expect(sizeAfter).toBeLessThan(sizeBefore);
    });
  });

  describe("isStorageLimitExceeded", () => {
    it("returns false when storage is below limit", async () => {
      const entry = createTestEntry("en_US-lessac-medium", 1024);
      await cache.put(entry);

      const exceeded = await cache.isStorageLimitExceeded();
      expect(exceeded).toBe(false);
    });

    it("returns false when cache is empty", async () => {
      const exceeded = await cache.isStorageLimitExceeded();
      expect(exceeded).toBe(false);
    });

    // Note: We don't test the true case because creating 200MB+ of data
    // would be slow and memory-intensive for unit tests
  });

  describe("STORAGE_LIMIT_BYTES constant", () => {
    it("equals 200 MB", () => {
      expect(STORAGE_LIMIT_BYTES).toBe(200 * 1024 * 1024);
    });
  });

  describe("close", () => {
    it("allows closing without error", async () => {
      // Open the database by performing an operation
      await cache.list();

      // Close should not throw
      expect(() => cache.close()).not.toThrow();
    });

    it("allows closing when never opened", () => {
      const freshCache = new VoiceCache();
      expect(() => freshCache.close()).not.toThrow();
    });
  });

  describe("deleteDatabase", () => {
    it("removes all cached voices", async () => {
      const entry1 = createTestEntry("en_US-lessac-medium");
      const entry2 = createTestEntry("en_GB-alba-medium");

      await cache.put(entry1);
      await cache.put(entry2);

      await cache.deleteDatabase();

      // Create a new cache instance to verify the database is gone
      const newCache = new VoiceCache();
      const voices = await newCache.list();

      expect(voices).toHaveLength(0);

      await newCache.deleteDatabase();
    });
  });

  describe("concurrent operations", () => {
    it("handles multiple concurrent puts", async () => {
      const entries = [
        createTestEntry("voice-1"),
        createTestEntry("voice-2"),
        createTestEntry("voice-3"),
        createTestEntry("voice-4"),
        createTestEntry("voice-5"),
      ];

      // Put all entries concurrently
      await Promise.all(entries.map((entry) => cache.put(entry)));

      const voices = await cache.list();
      expect(voices).toHaveLength(5);
    });

    it("handles concurrent read and write operations", async () => {
      const entry = createTestEntry("test-voice");

      // Perform concurrent operations
      const [, , retrieved] = await Promise.all([
        cache.put(entry),
        cache.list(),
        cache.put(entry).then(() => cache.get("test-voice")),
      ]);

      expect(retrieved?.voiceId).toBe("test-voice");
    });
  });

  describe("data integrity", () => {
    it("preserves ArrayBuffer content after storage", async () => {
      // Create an ArrayBuffer with specific content
      const buffer = new ArrayBuffer(16);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < 16; i++) {
        view[i] = i * 10;
      }

      const entry: VoiceCacheEntry = {
        voiceId: "test-voice",
        modelData: buffer,
        configData: "{}",
        downloadedAt: Date.now(),
        version: "1.0",
      };

      await cache.put(entry);
      const retrieved = await cache.get("test-voice");

      expect(retrieved).toBeDefined();

      const retrievedView = new Uint8Array(retrieved!.modelData);
      expect(retrievedView.length).toBe(16);

      for (let i = 0; i < 16; i++) {
        expect(retrievedView[i]).toBe(i * 10);
      }
    });

    it("preserves downloadedAt timestamp", async () => {
      const timestamp = 1700000000000;
      const entry = createTestEntry("test-voice");
      entry.downloadedAt = timestamp;

      await cache.put(entry);
      const retrieved = await cache.get("test-voice");

      expect(retrieved?.downloadedAt).toBe(timestamp);
    });
  });
});
