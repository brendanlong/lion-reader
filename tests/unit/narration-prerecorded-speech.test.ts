import { describe, it, expect } from "vitest";
import {
  isPrerecordedSpeechKey,
  prerecordedSpeechKey,
  type PrerecordedVoice,
} from "@/lib/narration/prerecorded-speech";

const VOICE: PrerecordedVoice = { model: "deepinfra:m", voice: "v", pauseSeconds: 0.6 };

describe("prerecordedSpeechKey", () => {
  it("is a stable hex hash", async () => {
    const key = await prerecordedSpeechKey(VOICE, "Hello.");
    expect(isPrerecordedSpeechKey(key)).toBe(true);
    expect(await prerecordedSpeechKey({ ...VOICE }, "Hello.")).toBe(key);
  });

  it("differs for anything that changes the audio", async () => {
    const key = await prerecordedSpeechKey(VOICE, "Hello.");
    const variants = await Promise.all([
      prerecordedSpeechKey(VOICE, "Hello!"),
      prerecordedSpeechKey({ ...VOICE, model: "deepinfra:other" }, "Hello."),
      prerecordedSpeechKey({ ...VOICE, voice: "other" }, "Hello."),
      prerecordedSpeechKey({ ...VOICE, pauseSeconds: 0.65 }, "Hello."),
    ]);
    expect(new Set([key, ...variants]).size).toBe(5);
  });
});

describe("isPrerecordedSpeechKey", () => {
  it("accepts only a lowercase SHA-256 in hex", () => {
    expect(isPrerecordedSpeechKey("a".repeat(64))).toBe(true);
    expect(isPrerecordedSpeechKey("A".repeat(64))).toBe(false);
    expect(isPrerecordedSpeechKey("a".repeat(63))).toBe(false);
    expect(isPrerecordedSpeechKey(`../${"a".repeat(61)}`)).toBe(false);
  });
});
