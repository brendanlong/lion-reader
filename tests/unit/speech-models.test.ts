import { describe, it, expect, afterEach } from "vitest";
import { defaultVoiceFor, toSpeechModels } from "@/server/services/speech";
import type { OpenRouterModel } from "@/server/services/openrouter";

const catalog: OpenRouterModel[] = [
  {
    id: "hexgrad/kokoro-82m",
    name: "hexgrad: Kokoro 82M",
    pricing: { prompt: "0.000004", completion: "0" },
    supported_voices: ["af_alloy", "af_heart"],
  },
  {
    id: "minimax/speech-2.8-hd",
    name: "MiniMax: Speech 2.8 HD",
    pricing: { prompt: "0.0001", completion: "0" },
    supported_voices: ["English_expressive_narrator"],
  },
  { id: "fish-audio/s1", name: "Fish Audio: S1", supported_voices: null },
];

const originalServerKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  if (originalServerKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalServerKey;
});

describe("toSpeechModels", () => {
  it("lists every model with voices on the user's own key, priced per character", () => {
    const models = toSpeechModels(catalog, { openrouterApiKey: "o" });
    expect(models.map((model) => model.id)).toEqual([
      "openrouter:hexgrad/kokoro-82m",
      "openrouter:minimax/speech-2.8-hd",
    ]);
    expect(models[0].pricePerMillionCharacters).toBe(4);
  });

  it("limits the server's key to the suggested models", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    expect(toSpeechModels(catalog, {}).map((model) => model.id)).toEqual([
      "openrouter:hexgrad/kokoro-82m",
    ]);
  });
});

describe("defaultVoiceFor", () => {
  it("prefers the curated default voice, else the first listed", () => {
    const [kokoro, minimax] = toSpeechModels(catalog, { openrouterApiKey: "o" });
    expect(defaultVoiceFor(kokoro)).toBe("af_heart");
    expect(defaultVoiceFor(minimax)).toBe("English_expressive_narrator");
  });
});
