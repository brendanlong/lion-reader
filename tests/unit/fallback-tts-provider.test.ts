/**
 * Unit tests for FallbackTTSProvider.
 *
 * Tests the automatic fallback behavior when the primary provider fails.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  TTSProvider,
  TTSVoice,
  SpeakOptions,
  TTSProviderId,
} from "../../src/lib/narration/types";
import {
  FallbackTTSProvider,
  createFallbackProvider,
} from "../../src/lib/narration/fallback-tts-provider";

/**
 * Mock TTSProvider implementation for testing.
 */
class MockTTSProvider implements TTSProvider {
  readonly id: TTSProviderId;
  readonly name: string;

  private _isAvailable: boolean;
  private _voices: TTSVoice[];
  private _shouldFail: boolean;
  private _failOnSpeak: boolean;
  private _speakError: Error | null;
  private _currentOptions: SpeakOptions | null = null;
  speakCalled = false;
  stopCalled = false;
  pauseCalled = false;
  resumeCalled = false;

  constructor(
    id: TTSProviderId,
    name: string,
    options: {
      isAvailable?: boolean;
      voices?: TTSVoice[];
      shouldFail?: boolean;
      failOnSpeak?: boolean;
      speakError?: Error;
    } = {}
  ) {
    this.id = id;
    this.name = name;
    this._isAvailable = options.isAvailable ?? true;
    this._voices = options.voices ?? [];
    this._shouldFail = options.shouldFail ?? false;
    this._failOnSpeak = options.failOnSpeak ?? false;
    this._speakError = options.speakError ?? null;
  }

  isAvailable(): boolean {
    return this._isAvailable;
  }

  async getVoices(): Promise<TTSVoice[]> {
    return this._voices;
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    this.speakCalled = true;
    this._currentOptions = options;

    if (this._failOnSpeak) {
      throw this._speakError ?? new Error("speak() failed");
    }

    if (this._shouldFail) {
      options.onError?.(this._speakError ?? new Error("Provider error"));
      return;
    }

    options.onStart?.();
    // Simulate successful completion
    setTimeout(() => {
      options.onEnd?.();
    }, 0);
  }

  stop(): void {
    this.stopCalled = true;
  }

  pause(): void {
    this.pauseCalled = true;
  }

  resume(): void {
    this.resumeCalled = true;
  }

  // Test helpers
  setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  setShouldFail(fail: boolean, error?: Error): void {
    this._shouldFail = fail;
    this._speakError = error ?? null;
  }

  setFailOnSpeak(fail: boolean, error?: Error): void {
    this._failOnSpeak = fail;
    this._speakError = error ?? null;
  }

  simulateEnd(): void {
    this._currentOptions?.onEnd?.();
  }

  simulateError(error: Error): void {
    this._currentOptions?.onError?.(error);
  }
}

describe("FallbackTTSProvider", () => {
  let primaryProvider: MockTTSProvider;
  let fallbackProvider: MockTTSProvider;

  beforeEach(() => {
    primaryProvider = new MockTTSProvider("piper", "Primary TTS");
    fallbackProvider = new MockTTSProvider("browser", "Fallback TTS");
  });

  describe("basic properties", () => {
    it("returns primary provider id when not using fallback", () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.id).toBe("piper");
    });

    it("returns primary provider name when not using fallback", () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.name).toBe("Primary TTS");
    });
  });

  describe("isAvailable", () => {
    it("returns true if primary is available", () => {
      primaryProvider.setAvailable(true);
      fallbackProvider.setAvailable(false);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.isAvailable()).toBe(true);
    });

    it("returns true if fallback is available", () => {
      primaryProvider.setAvailable(false);
      fallbackProvider.setAvailable(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.isAvailable()).toBe(true);
    });

    it("returns true if both are available", () => {
      primaryProvider.setAvailable(true);
      fallbackProvider.setAvailable(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.isAvailable()).toBe(true);
    });

    it("returns false if neither is available", () => {
      primaryProvider.setAvailable(false);
      fallbackProvider.setAvailable(false);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe("speak with successful primary", () => {
    it("uses primary provider when available", async () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});

      expect(primaryProvider.speakCalled).toBe(true);
      expect(fallbackProvider.speakCalled).toBe(false);
    });

    it("calls onStart callback", async () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      const onStart = vi.fn();
      await provider.speak("Hello", { onStart });

      expect(onStart).toHaveBeenCalled();
    });
  });

  describe("fallback on primary failure", () => {
    it("falls back when primary calls onError", async () => {
      const primaryError = new Error("Primary provider error");
      primaryProvider.setShouldFail(true, primaryError);

      const onFallback = vi.fn();
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
        onFallback,
      });

      await provider.speak("Hello", {});

      expect(primaryProvider.speakCalled).toBe(true);
      expect(fallbackProvider.speakCalled).toBe(true);
      expect(onFallback).toHaveBeenCalledWith(primaryError, fallbackProvider);
    });

    it("falls back when primary throws", async () => {
      const throwError = new Error("speak() threw");
      primaryProvider.setFailOnSpeak(true, throwError);

      const onFallback = vi.fn();
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
        onFallback,
      });

      await provider.speak("Hello", {});

      expect(fallbackProvider.speakCalled).toBe(true);
      expect(onFallback).toHaveBeenCalledWith(throwError, fallbackProvider);
    });

    it("falls back immediately when primary not available", async () => {
      primaryProvider.setAvailable(false);

      const onFallback = vi.fn();
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
        onFallback,
      });

      await provider.speak("Hello", {});

      expect(primaryProvider.speakCalled).toBe(false);
      expect(fallbackProvider.speakCalled).toBe(true);
      expect(onFallback).toHaveBeenCalled();
    });

    it("sets isUsingFallback to true after fallback", async () => {
      primaryProvider.setShouldFail(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      expect(provider.isUsingFallback()).toBe(false);

      await provider.speak("Hello", {});

      expect(provider.isUsingFallback()).toBe(true);
    });

    it("uses fallback for subsequent speak calls after fallback", async () => {
      primaryProvider.setShouldFail(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("First", {});

      // Reset speak tracking
      primaryProvider.speakCalled = false;
      fallbackProvider.speakCalled = false;

      await provider.speak("Second", {});

      expect(primaryProvider.speakCalled).toBe(false);
      expect(fallbackProvider.speakCalled).toBe(true);
    });

    it("returns fallback provider id after fallback", async () => {
      primaryProvider.setShouldFail(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});

      expect(provider.id).toBe("browser");
      expect(provider.name).toBe("Fallback TTS");
    });
  });

  describe("error when both providers fail", () => {
    it("calls onError when fallback also fails", async () => {
      primaryProvider.setShouldFail(true);
      fallbackProvider.setShouldFail(true, new Error("Fallback also failed"));

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      const onError = vi.fn();
      await provider.speak("Hello", { onError });

      expect(onError).toHaveBeenCalled();
    });

    it("throws when fallback is not available", async () => {
      primaryProvider.setShouldFail(true);
      fallbackProvider.setAvailable(false);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await expect(provider.speak("Hello", {})).rejects.toThrow(
        "Both primary and fallback providers are unavailable"
      );
    });
  });

  describe("resetToPrimary", () => {
    it("resets to using primary provider", async () => {
      primaryProvider.setShouldFail(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});
      expect(provider.isUsingFallback()).toBe(true);

      provider.resetToFrimary();
      expect(provider.isUsingFallback()).toBe(false);
    });
  });

  describe("stop", () => {
    it("stops both providers", () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      provider.stop();

      expect(primaryProvider.stopCalled).toBe(true);
      expect(fallbackProvider.stopCalled).toBe(true);
    });
  });

  describe("pause and resume", () => {
    it("pauses primary when not using fallback", async () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});
      provider.pause();

      expect(primaryProvider.pauseCalled).toBe(true);
      expect(fallbackProvider.pauseCalled).toBe(false);
    });

    it("pauses fallback when using fallback", async () => {
      primaryProvider.setShouldFail(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});
      provider.pause();

      expect(fallbackProvider.pauseCalled).toBe(true);
    });

    it("resumes primary when not using fallback", async () => {
      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});
      provider.resume();

      expect(primaryProvider.resumeCalled).toBe(true);
      expect(fallbackProvider.resumeCalled).toBe(false);
    });

    it("resumes fallback when using fallback", async () => {
      primaryProvider.setShouldFail(true);

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});
      provider.resume();

      expect(fallbackProvider.resumeCalled).toBe(true);
    });
  });

  describe("getVoices", () => {
    it("returns primary voices when not using fallback", async () => {
      const primaryVoices: TTSVoice[] = [
        { id: "voice1", name: "Voice 1", language: "en-US", provider: "piper" },
      ];
      primaryProvider = new MockTTSProvider("piper", "Primary TTS", {
        voices: primaryVoices,
      });

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      const voices = await provider.getVoices();
      expect(voices).toEqual(primaryVoices);
    });

    it("returns fallback voices when using fallback", async () => {
      primaryProvider.setShouldFail(true);
      const fallbackVoices: TTSVoice[] = [
        { id: "voice2", name: "Voice 2", language: "en-US", provider: "browser" },
      ];
      fallbackProvider = new MockTTSProvider("browser", "Fallback TTS", {
        voices: fallbackVoices,
      });

      const provider = new FallbackTTSProvider({
        primary: primaryProvider,
        fallback: fallbackProvider,
      });

      await provider.speak("Hello", {});
      const voices = await provider.getVoices();
      expect(voices).toEqual(fallbackVoices);
    });
  });
});

describe("createFallbackProvider", () => {
  it("creates a FallbackTTSProvider", () => {
    const primary = new MockTTSProvider("piper", "Primary");
    const fallback = new MockTTSProvider("browser", "Fallback");

    const provider = createFallbackProvider({
      primary,
      fallback,
    });

    expect(provider).toBeInstanceOf(FallbackTTSProvider);
  });

  it("passes onFallback callback", async () => {
    const primary = new MockTTSProvider("piper", "Primary", { shouldFail: true });
    const fallback = new MockTTSProvider("browser", "Fallback");
    const onFallback = vi.fn();

    const provider = createFallbackProvider({
      primary,
      fallback,
      onFallback,
    });

    await provider.speak("Hello", {});

    expect(onFallback).toHaveBeenCalled();
  });
});
