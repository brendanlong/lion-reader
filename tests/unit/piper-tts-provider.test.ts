/**
 * Unit tests for PiperTTSProvider.
 *
 * These tests verify the PiperTTSProvider implementation.
 * Piper TTS requires the Origin Private File System and Media Source
 * Extensions, which these tests stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist the mock function so it can be used in vi.mock factory
const { mockPredict } = vi.hoisted(() => ({
  mockPredict: vi.fn(),
}));

// Mock the piper-tts-web module
vi.mock("@mintplex-labs/piper-tts-web", () => ({
  TtsSession: {
    create: vi.fn().mockResolvedValue({
      predict: mockPredict,
    }),
  },
  download: vi.fn(),
  remove: vi.fn(),
  stored: vi.fn(),
  flush: vi.fn(),
}));

// Import after mocking
import {
  PiperTTSProvider,
  VoiceNotDownloadedError,
} from "../../src/lib/narration/piper-tts-provider";
import * as piperTTS from "@mintplex-labs/piper-tts-web";

describe("PiperTTSProvider", () => {
  let provider: PiperTTSProvider;

  beforeEach(() => {
    // Set up browser environment mocks using vi.stubGlobal
    vi.stubGlobal("window", {});
    vi.stubGlobal("MediaSource", class {});
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
    });

    // Reset all mocks
    vi.clearAllMocks();

    // Create a new provider for each test
    provider = new PiperTTSProvider();
  });

  afterEach(() => {
    // Restore original globals
    vi.unstubAllGlobals();
  });

  describe("isAvailable", () => {
    it("returns false without Media Source Extensions", () => {
      vi.stubGlobal("MediaSource", undefined);
      expect(new PiperTTSProvider().isAvailable()).toBe(false);
    });

    it("returns true when the storage API and MSE are available", () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it("returns false when window is undefined", () => {
      vi.stubGlobal("window", undefined);
      const newProvider = new PiperTTSProvider();
      expect(newProvider.isAvailable()).toBe(false);
    });

    it("returns false when storage API is not available", () => {
      vi.stubGlobal("navigator", {});
      const newProvider = new PiperTTSProvider();
      expect(newProvider.isAvailable()).toBe(false);
    });
  });

  describe("getStoredVoiceIds", () => {
    it("returns stored voice IDs", async () => {
      vi.mocked(piperTTS.stored).mockResolvedValue(["en_US-lessac-medium", "en_GB-alba-medium"]);

      const voiceIds = await provider.getStoredVoiceIds();

      expect(voiceIds).toEqual(["en_US-lessac-medium", "en_GB-alba-medium"]);
    });

    it("returns empty array on error", async () => {
      vi.mocked(piperTTS.stored).mockRejectedValue(new Error("OPFS error"));

      const voiceIds = await provider.getStoredVoiceIds();

      expect(voiceIds).toEqual([]);
    });
  });

  describe("downloadVoice", () => {
    it("downloads a known voice", async () => {
      vi.mocked(piperTTS.download).mockResolvedValue(undefined);

      await provider.downloadVoice("en_US-lessac-medium");

      expect(piperTTS.download).toHaveBeenCalledWith("en_US-lessac-medium", expect.any(Function));
    });

    it("calls progress callback", async () => {
      vi.mocked(piperTTS.download).mockImplementation(async (_voiceId, callback) => {
        callback?.({ url: "test", loaded: 50, total: 100 });
        callback?.({ url: "test", loaded: 100, total: 100 });
      });

      const onProgress = vi.fn();
      await provider.downloadVoice("en_US-lessac-medium", onProgress);

      expect(onProgress).toHaveBeenCalledWith(0.5);
      expect(onProgress).toHaveBeenCalledWith(1);
    });

    it("throws error for unknown voice", async () => {
      await expect(provider.downloadVoice("unknown-voice")).rejects.toThrow(
        "Unknown voice: unknown-voice"
      );
    });
  });

  describe("removeVoice", () => {
    it("removes a voice from storage", async () => {
      vi.mocked(piperTTS.remove).mockResolvedValue(undefined);

      await provider.removeVoice("en_US-lessac-medium");

      expect(piperTTS.remove).toHaveBeenCalledWith("en_US-lessac-medium");
    });
  });

  describe("synthesize", () => {
    it("rejects when not available", async () => {
      vi.stubGlobal("window", undefined);
      await expect(
        new PiperTTSProvider().synthesize("Hello", "en_US-lessac-medium")
      ).rejects.toThrow("not available");
    });

    it("rejects an unknown voice", async () => {
      await expect(provider.synthesize("Hello", "unknown-voice")).rejects.toThrow(
        "Unknown enhanced voice"
      );
    });

    it("rejects a voice that isn't downloaded", async () => {
      vi.mocked(piperTTS.stored).mockResolvedValue([]);
      await expect(provider.synthesize("Hello", "en_US-lessac-medium")).rejects.toBeInstanceOf(
        VoiceNotDownloadedError
      );
    });

    it("returns Piper's WAV clip for a downloaded voice", async () => {
      vi.mocked(piperTTS.stored).mockResolvedValue(["en_US-lessac-medium"]);
      const wav = new Blob([new Uint8Array(1000)], { type: "audio/wav" });
      mockPredict.mockResolvedValue(wav);

      expect(await provider.synthesize("Hello", "en_US-lessac-medium")).toBe(wav);
      expect(piperTTS.TtsSession.create).toHaveBeenCalledWith({
        voiceId: "en_US-lessac-medium",
        wasmPaths: expect.any(Object),
      });
      expect(mockPredict).toHaveBeenCalledWith("Hello");
    });
  });
});

describe("VoiceNotDownloadedError", () => {
  it("has correct name and message", () => {
    const error = new VoiceNotDownloadedError("en_US-lessac-medium");

    expect(error.name).toBe("VoiceNotDownloadedError");
    expect(error.voiceId).toBe("en_US-lessac-medium");
    expect(error.message).toContain("en_US-lessac-medium");
    expect(error.message).toContain("not downloaded");
  });

  it("is an instance of Error", () => {
    const error = new VoiceNotDownloadedError("test-voice");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("getPiperTTSProvider", () => {
  beforeEach(() => {
    // Set up browser environment mocks
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a PiperTTSProvider instance", async () => {
    // Dynamically import to get fresh singleton
    const { getPiperTTSProvider } = await import("../../src/lib/narration/piper-tts-provider");
    const piperProvider = getPiperTTSProvider();
    expect(piperProvider).toBeInstanceOf(PiperTTSProvider);
  });
});
