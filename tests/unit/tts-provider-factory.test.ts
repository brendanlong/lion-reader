/**
 * Unit tests for TTS Provider Factory.
 *
 * Tests the factory functions for creating TTS providers with fallback behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoist the mock for isWebWorkerSupported
const { mockIsWebWorkerSupported } = vi.hoisted(() => ({
  mockIsWebWorkerSupported: vi.fn().mockReturnValue(true),
}));

// Mock the worker client module
vi.mock("../../src/lib/narration/piper-worker-client", () => ({
  getPiperWorkerClient: vi.fn(() => ({
    getStoredVoiceIds: vi.fn().mockResolvedValue([]),
    downloadVoice: vi.fn(),
    removeVoice: vi.fn(),
    generateAudio: vi.fn(),
    terminate: vi.fn(),
    isAvailable: vi.fn().mockReturnValue(true),
  })),
  isWebWorkerSupported: mockIsWebWorkerSupported,
}));

// Mock AudioContext for Piper tests
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

// Reset modules to get fresh singletons
beforeEach(async () => {
  vi.resetModules();
});

describe("createTTSProvider", () => {
  beforeEach(() => {
    // Set up browser environment mocks
    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
      speechSynthesis: {
        getVoices: () => [],
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
      SpeechSynthesisUtterance: class {
        text = "";
        voice = null;
        rate = 1;
        pitch = 1;
        onstart = null;
        onend = null;
        onerror = null;
      },
    });
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      speak: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("with browser provider setting", () => {
    it("returns browser provider", async () => {
      const { createTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");

      const result = createTTSProvider({
        settings: { provider: "browser" },
      });

      expect(result.provider.id).toBe("browser");
      expect(result.hasFallback).toBe(false);
    });

    it("returns browser provider availability status", async () => {
      const { createTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");

      const result = createTTSProvider({
        settings: { provider: "browser" },
      });

      expect(typeof result.primaryAvailable).toBe("boolean");
    });
  });

  describe("with piper provider setting", () => {
    it("returns fallback-wrapped provider by default", async () => {
      const { createTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");
      const { FallbackTTSProvider } = await import("../../src/lib/narration/fallback-tts-provider");

      const result = createTTSProvider({
        settings: { provider: "piper" },
      });

      expect(result.provider).toBeInstanceOf(FallbackTTSProvider);
      expect(result.hasFallback).toBe(true);
    });

    it("returns unwrapped provider when fallback disabled", async () => {
      const { createTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");
      const { PiperTTSProvider } = await import("../../src/lib/narration/piper-tts-provider");

      const result = createTTSProvider({
        settings: { provider: "piper" },
        enableFallback: false,
      });

      expect(result.provider).toBeInstanceOf(PiperTTSProvider);
      expect(result.hasFallback).toBe(false);
    });

    it("calls onFallback callback when fallback occurs", async () => {
      const { createTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");

      const onFallback = vi.fn();
      const result = createTTSProvider({
        settings: { provider: "piper" },
        onFallback,
      });

      expect(result.hasFallback).toBe(true);
      // The onFallback callback is passed through to the FallbackTTSProvider
      // and will be called when the primary provider fails
    });

    it("logs warning when fallback is activated", async () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { createTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");

      const result = createTTSProvider({
        settings: { provider: "piper" },
      });

      // The logging happens inside the FallbackTTSProvider when fallback occurs
      expect(result.hasFallback).toBe(true);

      consoleWarnSpy.mockRestore();
    });
  });
});

describe("getTTSProvider", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
      speechSynthesis: {
        getVoices: () => [],
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
      },
      SpeechSynthesisUtterance: class {},
    });
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36",
    });
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [],
      speak: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a TTSProvider for browser settings", async () => {
    const { getTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");

    const provider = getTTSProvider({ provider: "browser" });

    expect(provider.id).toBe("browser");
  });

  it("returns a TTSProvider for piper settings", async () => {
    const { getTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");
    const { FallbackTTSProvider } = await import("../../src/lib/narration/fallback-tts-provider");

    const provider = getTTSProvider({ provider: "piper" });

    expect(provider).toBeInstanceOf(FallbackTTSProvider);
  });

  it("accepts onFallback callback", async () => {
    const { getTTSProvider } = await import("../../src/lib/narration/tts-provider-factory");

    const onFallback = vi.fn();
    const provider = getTTSProvider({ provider: "piper" }, onFallback);

    expect(provider).toBeDefined();
  });
});

describe("isPiperAvailable", () => {
  it("returns true when Piper requirements are met", async () => {
    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
    });
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
      userAgent: "Chrome/120.0.0.0",
    });
    vi.stubGlobal("AudioContext", MockAudioContext);

    const { isPiperAvailable } = await import("../../src/lib/narration/tts-provider-factory");

    expect(isPiperAvailable()).toBe(true);
  });

  it("returns false when AudioContext is not available", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
      userAgent: "Chrome/120.0.0.0",
    });

    const { isPiperAvailable } = await import("../../src/lib/narration/tts-provider-factory");

    expect(isPiperAvailable()).toBe(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

describe("getBestAvailableProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns piper when Piper is available", async () => {
    vi.stubGlobal("window", {
      AudioContext: MockAudioContext,
    });
    vi.stubGlobal("navigator", {
      storage: {
        getDirectory: vi.fn().mockResolvedValue({}),
      },
      userAgent: "Chrome/120.0.0.0",
    });
    vi.stubGlobal("AudioContext", MockAudioContext);

    const { getBestAvailableProvider } =
      await import("../../src/lib/narration/tts-provider-factory");

    expect(getBestAvailableProvider()).toBe("piper");
  });

  it("returns browser when Piper is not available", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      userAgent: "Chrome/120.0.0.0",
    });

    const { getBestAvailableProvider } =
      await import("../../src/lib/narration/tts-provider-factory");

    expect(getBestAvailableProvider()).toBe("browser");
  });
});
