import { describe, it, expect, afterEach } from "vitest";
import {
  defaultSpeechModelId,
  defaultVoiceFor,
  resolveSpeechModel,
  SpeechRequestError,
  type SpeechModel,
  type SpeechProvider,
  toDeepInfraSpeechModels,
  toSpeechModels,
} from "@/server/services/speech";
import {
  canNarrate,
  voicesFromSchema,
  type DeepInfraSpeechModel,
} from "@/server/services/deepinfra";
import type { OpenRouterModel } from "@/server/services/openrouter";
import { DEEPINFRA_KOKORO, OPENROUTER_KOKORO } from "@/lib/narration/constants";

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
  {
    id: "google/gemini-3.8-flash-tts",
    name: "Google: Gemini 3.8 Flash TTS",
    pricing: { prompt: "0.0000005", completion: "0.000009" },
    supported_voices: ["Kore"],
  },
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
      "openrouter:google/gemini-3.8-flash-tts",
      "openrouter:hexgrad/kokoro-82m",
      "openrouter:minimax/speech-2.8-hd",
    ]);
    expect(models[1].pricePerMillionCharacters).toBe(4);
  });

  it("omits the per-character price for models that also bill generated audio", () => {
    const [gemini] = toSpeechModels(catalog, { openrouterApiKey: "o" });
    expect(gemini.pricePerMillionCharacters).toBeUndefined();
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
    const [, kokoro, minimax] = toSpeechModels(catalog, { openrouterApiKey: "o" });
    expect(defaultVoiceFor(kokoro)).toBe("af_heart");
    expect(defaultVoiceFor(minimax)).toBe("English_expressive_narrator");
  });
});

const deepInfraCatalog: DeepInfraSpeechModel[] = [
  { name: "hexgrad/Kokoro-82M", voices: ["af_bella", "af_heart"], pricePerMillionCharacters: 0.62 },
  {
    name: "inworld-ai/realtime-tts-2",
    voices: ["Ashley", "Dennis"],
    pricePerMillionCharacters: 35,
  },
];

describe("toDeepInfraSpeechModels", () => {
  const originalDeepInfraKey = process.env.DEEPINFRA_API_KEY;
  afterEach(() => {
    if (originalDeepInfraKey === undefined) delete process.env.DEEPINFRA_API_KEY;
    else process.env.DEEPINFRA_API_KEY = originalDeepInfraKey;
  });

  it("lists every model on the user's own key, named like OpenRouter's", () => {
    const models = toDeepInfraSpeechModels(deepInfraCatalog, { deepinfraApiKey: "d" });
    expect(models.map((model) => [model.id, model.displayName, model.provider])).toEqual([
      ["deepinfra:hexgrad/Kokoro-82M", "hexgrad: Kokoro 82M", "deepinfra"],
      ["deepinfra:inworld-ai/realtime-tts-2", "inworld ai: realtime tts 2", "deepinfra"],
    ]);
    expect(models[0].pricePerMillionCharacters).toBe(0.62);
  });

  it("limits the server's key to Kokoro", () => {
    process.env.DEEPINFRA_API_KEY = "server";
    expect(toDeepInfraSpeechModels(deepInfraCatalog, {}).map((model) => model.id)).toEqual([
      "deepinfra:hexgrad/Kokoro-82M",
    ]);
  });

  it("isn't limited by an OpenRouter key", () => {
    process.env.DEEPINFRA_API_KEY = "server";
    expect(toDeepInfraSpeechModels(deepInfraCatalog, { openrouterApiKey: "o" })).toHaveLength(1);
  });
});

describe("defaultSpeechModelId", () => {
  const openRouter = toSpeechModels(catalog, { openrouterApiKey: "o" });
  const deepInfra = toDeepInfraSpeechModels(deepInfraCatalog, { deepinfraApiKey: "d" });

  it("prefers DeepInfra's Kokoro, then OpenRouter's", () => {
    expect(defaultSpeechModelId([...openRouter, ...deepInfra])).toBe(DEEPINFRA_KOKORO);
    expect(defaultSpeechModelId(openRouter)).toBe(OPENROUTER_KOKORO);
  });

  it("falls back to whatever is available", () => {
    const [, inworld] = deepInfra;
    expect(defaultSpeechModelId([inworld])).toBe(inworld.id);
  });

  it("gives DeepInfra's Kokoro its curated default voice too", () => {
    expect(defaultVoiceFor(deepInfra[0])).toBe("af_heart");
  });
});

describe("voicesFromSchema", () => {
  it("reads Kokoro's preset_voice array of an enum definition", () => {
    expect(
      voicesFromSchema({
        properties: {
          preset_voice: { type: "array", items: { $ref: "#/definitions/KokoroTtsVoice" } },
        },
        definitions: { KokoroTtsVoice: { enum: ["af_bella", "af_heart"] } },
      })
    ).toEqual(["af_bella", "af_heart"]);
  });

  it("reads a voice enum, inline or behind anyOf", () => {
    expect(voicesFromSchema({ properties: { voice: { enum: ["tara", "leo"] } } })).toEqual([
      "tara",
      "leo",
    ]);
    expect(
      voicesFromSchema({
        properties: { voice: { anyOf: [{ $ref: "#/definitions/Voice" }, { type: "null" }] } },
        definitions: { Voice: { enum: ["Ashley"] } },
      })
    ).toEqual(["Ashley"]);
  });

  it("finds nothing for voice-cloning models", () => {
    expect(voicesFromSchema({ properties: { voice_id: { type: "string" } } })).toEqual([]);
    expect(voicesFromSchema(null)).toEqual([]);
  });
});

describe("canNarrate", () => {
  const formats = { TtsResponseFormat: { enum: ["mp3", "wav", "pcm"] } };
  const responseFormat = { $ref: "#/definitions/TtsResponseFormat" };

  it("accepts a model that takes a full chunk and returns PCM and WAV", () => {
    expect(
      canNarrate({
        properties: { text: { maxLength: 10000 }, output_format: responseFormat },
        definitions: formats,
      })
    ).toBe(true);
  });

  it("rejects a model whose input is shorter than a chunk", () => {
    expect(
      canNarrate({
        properties: { input: { maxLength: 300 }, response_format: responseFormat },
        definitions: formats,
      })
    ).toBe(false);
  });

  it("rejects a model that can't stream PCM or say what format it's in", () => {
    // PCM alone has no header to learn its rate from; WAV alone doesn't stream.
    for (const only of ["pcm", "wav"]) {
      expect(
        canNarrate({ properties: { input: { maxLength: 1500 }, response_format: { const: only } } })
      ).toBe(false);
    }
    expect(canNarrate({ properties: { text: { maxLength: 1000 } } })).toBe(false);
  });
});

describe("resolveSpeechModel", () => {
  const originalKeys = {
    deepinfra: process.env.DEEPINFRA_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  afterEach(() => {
    for (const [provider, value] of Object.entries(originalKeys)) {
      const name = `${provider.toUpperCase()}_API_KEY`;
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const deepInfraKokoro = {
    id: DEEPINFRA_KOKORO,
    displayName: "hexgrad: Kokoro 82M",
    provider: "deepinfra" as const,
    voices: [
      { id: "af_heart", name: "af_heart" },
      { id: "bm_george", name: "bm_george" },
    ],
  };
  const qwen = {
    id: "deepinfra:Qwen/Qwen3-TTS",
    displayName: "Qwen: Qwen3 TTS",
    provider: "deepinfra" as const,
    voices: [{ id: "Vivian", name: "Vivian" }],
  };

  const catalog = (models: SpeechModel[], unavailable: SpeechProvider[] = []) => ({
    models,
    unavailable,
  });

  it("uses the default model and voice when nothing is chosen", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    expect(resolveSpeechModel(catalog([deepInfraKokoro]), {}, null, null)).toEqual({
      model: deepInfraKokoro,
      voice: "af_heart",
    });
  });

  it("falls back to the default when the chosen model's provider has no key", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    delete process.env.OPENROUTER_API_KEY;
    expect(
      resolveSpeechModel(catalog([deepInfraKokoro]), {}, OPENROUTER_KOKORO, "bm_george")
    ).toEqual({
      model: deepInfraKokoro,
      voice: "bm_george",
    });
  });

  it("falls back from a model the server's key doesn't allow", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    expect(resolveSpeechModel(catalog([deepInfraKokoro]), {}, qwen.id, "Vivian")).toEqual({
      model: deepInfraKokoro,
      voice: "af_heart",
    });
  });

  it("keeps a model chosen on the user's own key, even if it's no longer listed", () => {
    const keys = { deepinfraApiKey: "d" };
    expect(resolveSpeechModel(catalog([deepInfraKokoro, qwen]), keys, qwen.id, null).model).toBe(
      qwen
    );
    expect(() => resolveSpeechModel(catalog([deepInfraKokoro]), keys, qwen.id, null)).toThrow(
      "Speech model not available"
    );
  });

  it("fails retryably when the chosen model's provider couldn't be listed", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    const keys = { openrouterApiKey: "o" };
    expect(() =>
      resolveSpeechModel(catalog([deepInfraKokoro], ["openrouter"]), keys, OPENROUTER_KOKORO, null)
    ).toThrow(Error);
    expect(() =>
      resolveSpeechModel(catalog([deepInfraKokoro], ["openrouter"]), keys, OPENROUTER_KOKORO, null)
    ).not.toThrow(SpeechRequestError);
    expect(() => resolveSpeechModel(catalog([], ["deepinfra"]), {}, null, null)).not.toThrow(
      SpeechRequestError
    );
  });

  it("needs a provider, and names them", () => {
    expect(() => resolveSpeechModel(catalog([]), {}, null, null)).toThrow(
      "Cloud voices require a DeepInfra or OpenRouter API key"
    );
  });
});
