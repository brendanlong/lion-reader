/**
 * Unit tests for PiperTTSProvider.
 *
 * These tests verify the PiperTTSProvider implementation.
 * Since Piper TTS requires browser APIs (AudioContext, OPFS), we mock these
 * for unit testing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TTSVoice } from "../../src/lib/narration/types";

// Mock the piper-tts-web module
vi.mock("@mintplex-labs/piper-tts-web", () => ({
  predict: vi.fn(),
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

// Mock AudioContext
class MockAudioContext {
  currentTime = 0;
  destination = {};

  async decodeAudioData(): Promise<AudioBuffer> {
    return {
      duration: 1.0,
      length: 44100,
      numberOfChannels: 1,
      sampleRate: 44100,
      getChannelData: () => new Float32Array(44100),
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
    } as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as AudioBufferSourceNode;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("PiperTTSProvider", () => {
  let provider: PiperTTSProvider;

  beforeEach(() => {
    // Set up browser environment mocks using vi.stubGlobal
    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
    });
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
    });
    vi.stubGlobal("AudioContext", MockAudioContext);

    // Reset all mocks
    vi.clearAllMocks();

    // Create a new provider for each test
    provider = new PiperTTSProvider();
  });

  afterEach(() => {
    // Restore original globals
    vi.unstubAllGlobals();
  });

  describe("basic properties", () => {
    it("has correct id", () => {
      expect(provider.id).toBe("piper");
    });

    it("has correct name", () => {
      expect(provider.name).toBe("Enhanced Voices");
    });
  });

  describe("isAvailable", () => {
    it("returns true when AudioContext and storage API are available", () => {
      expect(provider.isAvailable()).toBe(true);
    });

    it("returns false when window is undefined", () => {
      vi.stubGlobal("window", undefined);
      const newProvider = new PiperTTSProvider();
      expect(newProvider.isAvailable()).toBe(false);
    });

    it("returns false when AudioContext is not available", () => {
      vi.stubGlobal("window", {});
      const newProvider = new PiperTTSProvider();
      expect(newProvider.isAvailable()).toBe(false);
    });

    it("returns false when storage API is not available", () => {
      vi.stubGlobal("navigator", {});
      const newProvider = new PiperTTSProvider();
      expect(newProvider.isAvailable()).toBe(false);
    });
  });

  describe("getVoices", () => {
    it("returns empty array when not available", async () => {
      vi.stubGlobal("window", undefined);
      const newProvider = new PiperTTSProvider();
      const voices = await newProvider.getVoices();
      expect(voices).toEqual([]);
    });

    it("returns enhanced voices with download status", async () => {
      vi.mocked(piperTTS.stored).mockResolvedValue(["en_US-lessac-medium"]);

      const voices = await provider.getVoices();

      expect(voices.length).toBeGreaterThan(0);

      // Check that the downloaded voice is marked as such
      const alexVoice = voices.find((v) => v.id === "en_US-lessac-medium");
      expect(alexVoice).toBeDefined();
      expect(alexVoice?.downloadStatus).toBe("downloaded");
      expect(alexVoice?.provider).toBe("piper");

      // Check that non-downloaded voices are marked correctly
      const amyVoice = voices.find((v) => v.id === "en_US-amy-low");
      expect(amyVoice?.downloadStatus).toBe("not-downloaded");
    });

    it("handles storage errors gracefully", async () => {
      vi.mocked(piperTTS.stored).mockRejectedValue(new Error("Storage error"));

      const voices = await provider.getVoices();

      // All voices should be marked as not-downloaded
      expect(voices.every((v) => v.downloadStatus === "not-downloaded")).toBe(true);
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

  describe("speak", () => {
    it("calls onError when not available", async () => {
      vi.stubGlobal("window", undefined);
      const newProvider = new PiperTTSProvider();
      const onError = vi.fn();

      await newProvider.speak("Hello", { onError });

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0][0].message).toContain("not available");
    });

    it("calls onError when voiceId is not provided", async () => {
      const onError = vi.fn();

      await provider.speak("Hello", { onError });

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0][0].message).toContain("Voice ID is required");
    });

    it("calls onError when voice is not downloaded", async () => {
      vi.mocked(piperTTS.stored).mockResolvedValue([]);

      const onError = vi.fn();

      await provider.speak("Hello", {
        voiceId: "en_US-lessac-medium",
        onError,
      });

      expect(onError).toHaveBeenCalledWith(expect.any(VoiceNotDownloadedError));
    });

    it("generates audio and plays it", async () => {
      // Mock the voice as downloaded
      vi.mocked(piperTTS.stored).mockResolvedValue(["en_US-lessac-medium"]);

      // Mock predict to return a WAV blob
      const mockBlob = new Blob([new Uint8Array(1000)], { type: "audio/wav" });
      vi.mocked(piperTTS.predict).mockResolvedValue(mockBlob);

      const onStart = vi.fn();
      const onEnd = vi.fn();

      await provider.speak("Hello", {
        voiceId: "en_US-lessac-medium",
        onStart,
        onEnd,
      });

      expect(piperTTS.predict).toHaveBeenCalledWith({
        text: "Hello",
        voiceId: "en_US-lessac-medium",
      });
      expect(onStart).toHaveBeenCalled();
    });

    it("calls onError when voice is unknown", async () => {
      const onError = vi.fn();

      await provider.speak("Hello", { voiceId: "unknown-voice", onError });

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0][0].message).toContain("Unknown enhanced voice");
    });
  });

  describe("stop", () => {
    it("stops current playback", async () => {
      // Set up mock for playing state
      vi.mocked(piperTTS.stored).mockResolvedValue(["en_US-lessac-medium"]);
      const mockBlob = new Blob([new Uint8Array(1000)], { type: "audio/wav" });
      vi.mocked(piperTTS.predict).mockResolvedValue(mockBlob);

      await provider.speak("Hello", { voiceId: "en_US-lessac-medium" });

      // Stop should not throw
      expect(() => provider.stop()).not.toThrow();
    });

    it("does not throw when nothing is playing", () => {
      expect(() => provider.stop()).not.toThrow();
    });
  });

  describe("pause and resume", () => {
    it("pause does not throw when nothing is playing", () => {
      expect(() => provider.pause()).not.toThrow();
    });

    it("resume does not throw when not paused", () => {
      expect(() => provider.resume()).not.toThrow();
    });

    it("isPausedState returns false initially", () => {
      expect(provider.isPausedState()).toBe(false);
    });
  });

  describe("close", () => {
    it("closes the audio context", async () => {
      // Trigger creation of audio context by speaking
      vi.mocked(piperTTS.stored).mockResolvedValue(["en_US-lessac-medium"]);
      const mockBlob = new Blob([new Uint8Array(1000)], { type: "audio/wav" });
      vi.mocked(piperTTS.predict).mockResolvedValue(mockBlob);

      await provider.speak("Hello", { voiceId: "en_US-lessac-medium" });
      await provider.close();

      // Should not throw
      expect(true).toBe(true);
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
    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
    });
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
    });
    vi.stubGlobal("AudioContext", MockAudioContext);
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

describe("TTSVoice interface for Piper voices", () => {
  it("represents a piper voice correctly", () => {
    const voice: TTSVoice = {
      id: "en_US-lessac-medium",
      name: "Alex (US)",
      language: "en-US",
      provider: "piper",
      downloadStatus: "downloaded",
    };

    expect(voice.provider).toBe("piper");
    expect(voice.downloadStatus).toBe("downloaded");
  });

  it("represents a not-downloaded piper voice", () => {
    const voice: TTSVoice = {
      id: "en_GB-alba-medium",
      name: "Alba (UK)",
      language: "en-GB",
      provider: "piper",
      downloadStatus: "not-downloaded",
    };

    expect(voice.downloadStatus).toBe("not-downloaded");
  });

  it("represents a downloading piper voice with progress", () => {
    const voice: TTSVoice = {
      id: "en_US-ryan-medium",
      name: "Ryan (US)",
      language: "en-US",
      provider: "piper",
      downloadStatus: "downloading",
      downloadProgress: 75,
    };

    expect(voice.downloadStatus).toBe("downloading");
    expect(voice.downloadProgress).toBe(75);
  });
});
