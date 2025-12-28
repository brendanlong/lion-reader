/**
 * Unit tests for TTS Provider abstraction.
 *
 * These tests verify the TTSProvider interface contract using a mock implementation.
 * The BrowserTTSProvider relies on Web Speech API which isn't available in Node.js,
 * so we test the interface contracts with a mock and test settings logic separately.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TTSProvider, TTSVoice, SpeakOptions } from "../../src/lib/narration/types";

/**
 * Mock TTSProvider implementation for testing the interface contract.
 */
class MockTTSProvider implements TTSProvider {
  readonly id = "browser" as const;
  readonly name = "Mock TTS";

  private _isAvailable = true;
  private _voices: TTSVoice[] = [];
  private _isSpeaking = false;
  private _isPaused = false;
  private _currentOptions: SpeakOptions | null = null;

  // Test control methods
  setAvailable(available: boolean): void {
    this._isAvailable = available;
  }

  setVoices(voices: TTSVoice[]): void {
    this._voices = voices;
  }

  // TTSProvider implementation
  isAvailable(): boolean {
    return this._isAvailable;
  }

  async getVoices(): Promise<TTSVoice[]> {
    return this._voices;
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    if (!this._isAvailable) {
      options.onError?.(new Error("Provider not available"));
      return;
    }

    this._isSpeaking = true;
    this._isPaused = false;
    this._currentOptions = options;
    options.onStart?.();

    // Simulate async completion
    return Promise.resolve();
  }

  stop(): void {
    this._isSpeaking = false;
    this._isPaused = false;
    this._currentOptions = null;
  }

  pause(): void {
    if (this._isSpeaking) {
      this._isPaused = true;
    }
  }

  resume(): void {
    if (this._isPaused) {
      this._isPaused = false;
    }
  }

  // Test helper methods
  isSpeaking(): boolean {
    return this._isSpeaking;
  }

  isPaused(): boolean {
    return this._isPaused;
  }

  simulateEnd(): void {
    this._currentOptions?.onEnd?.();
    this._isSpeaking = false;
  }

  simulateError(error: Error): void {
    this._currentOptions?.onError?.(error);
    this._isSpeaking = false;
  }
}

describe("TTSProvider interface", () => {
  let provider: MockTTSProvider;

  beforeEach(() => {
    provider = new MockTTSProvider();
  });

  describe("isAvailable", () => {
    it("returns true when provider is available", () => {
      provider.setAvailable(true);
      expect(provider.isAvailable()).toBe(true);
    });

    it("returns false when provider is unavailable", () => {
      provider.setAvailable(false);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe("getVoices", () => {
    it("returns empty array when no voices configured", async () => {
      const voices = await provider.getVoices();
      expect(voices).toEqual([]);
    });

    it("returns configured voices", async () => {
      const testVoices: TTSVoice[] = [
        {
          id: "voice-1",
          name: "Test Voice 1",
          language: "en-US",
          provider: "browser",
          downloadStatus: "downloaded",
        },
        {
          id: "voice-2",
          name: "Test Voice 2",
          language: "en-GB",
          provider: "browser",
          downloadStatus: "downloaded",
        },
      ];
      provider.setVoices(testVoices);

      const voices = await provider.getVoices();
      expect(voices).toHaveLength(2);
      expect(voices[0].id).toBe("voice-1");
      expect(voices[1].id).toBe("voice-2");
    });
  });

  describe("speak", () => {
    it("calls onStart callback when speech begins", async () => {
      const onStart = vi.fn();
      await provider.speak("Hello", { onStart });

      expect(onStart).toHaveBeenCalledOnce();
    });

    it("does not throw when options callbacks are undefined", async () => {
      await expect(provider.speak("Hello", {})).resolves.not.toThrow();
    });

    it("calls onError when provider is unavailable", async () => {
      provider.setAvailable(false);
      const onError = vi.fn();

      await provider.speak("Hello", { onError });

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it("starts speaking after speak is called", async () => {
      await provider.speak("Hello", {});
      expect(provider.isSpeaking()).toBe(true);
    });
  });

  describe("stop", () => {
    it("stops speaking", async () => {
      await provider.speak("Hello", {});
      expect(provider.isSpeaking()).toBe(true);

      provider.stop();
      expect(provider.isSpeaking()).toBe(false);
    });

    it("clears paused state", async () => {
      await provider.speak("Hello", {});
      provider.pause();
      expect(provider.isPaused()).toBe(true);

      provider.stop();
      expect(provider.isPaused()).toBe(false);
    });
  });

  describe("pause", () => {
    it("pauses when speaking", async () => {
      await provider.speak("Hello", {});
      expect(provider.isPaused()).toBe(false);

      provider.pause();
      expect(provider.isPaused()).toBe(true);
    });

    it("does nothing when not speaking", () => {
      provider.pause();
      expect(provider.isPaused()).toBe(false);
    });
  });

  describe("resume", () => {
    it("resumes when paused", async () => {
      await provider.speak("Hello", {});
      provider.pause();
      expect(provider.isPaused()).toBe(true);

      provider.resume();
      expect(provider.isPaused()).toBe(false);
    });

    it("does nothing when not paused", async () => {
      await provider.speak("Hello", {});
      provider.resume();
      expect(provider.isSpeaking()).toBe(true);
    });
  });

  describe("callbacks", () => {
    it("calls onEnd when speech completes naturally", async () => {
      const onEnd = vi.fn();
      await provider.speak("Hello", { onEnd });

      provider.simulateEnd();

      expect(onEnd).toHaveBeenCalledOnce();
    });

    it("calls onError when speech fails", async () => {
      const onError = vi.fn();
      await provider.speak("Hello", { onError });

      const error = new Error("Speech failed");
      provider.simulateError(error);

      expect(onError).toHaveBeenCalledWith(error);
    });
  });
});

describe("TTSVoice interface", () => {
  it("represents browser voice correctly", () => {
    const voice: TTSVoice = {
      id: "com.apple.speech.synthesis.voice.samantha",
      name: "Samantha",
      language: "en-US",
      provider: "browser",
      downloadStatus: "downloaded",
    };

    expect(voice.provider).toBe("browser");
    expect(voice.downloadStatus).toBe("downloaded");
  });

  it("represents piper voice with download status", () => {
    const voice: TTSVoice = {
      id: "en_US-lessac-medium",
      name: "Alex (US)",
      language: "en-US",
      provider: "piper",
      downloadStatus: "downloading",
      downloadProgress: 45,
    };

    expect(voice.provider).toBe("piper");
    expect(voice.downloadStatus).toBe("downloading");
    expect(voice.downloadProgress).toBe(45);
  });

  it("allows optional download fields", () => {
    const voice: TTSVoice = {
      id: "test-voice",
      name: "Test",
      language: "en-US",
      provider: "browser",
    };

    expect(voice.downloadStatus).toBeUndefined();
    expect(voice.downloadProgress).toBeUndefined();
  });
});

describe("SpeakOptions interface", () => {
  it("allows all optional fields", () => {
    const options: SpeakOptions = {};

    expect(options.voiceId).toBeUndefined();
    expect(options.rate).toBeUndefined();
    expect(options.pitch).toBeUndefined();
    expect(options.onStart).toBeUndefined();
    expect(options.onEnd).toBeUndefined();
    expect(options.onParagraph).toBeUndefined();
    expect(options.onError).toBeUndefined();
  });

  it("accepts all callback types", () => {
    const options: SpeakOptions = {
      voiceId: "test-voice",
      rate: 1.5,
      pitch: 1.2,
      onStart: () => {},
      onEnd: () => {},
      onParagraph: (index: number) => {
        expect(typeof index).toBe("number");
      },
      onError: (error: Error) => {
        expect(error).toBeInstanceOf(Error);
      },
    };

    expect(options.voiceId).toBe("test-voice");
    expect(options.rate).toBe(1.5);
    expect(options.pitch).toBe(1.2);
  });
});
