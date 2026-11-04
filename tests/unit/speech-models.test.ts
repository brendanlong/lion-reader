import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  defaultSpeechModelId,
  defaultVoiceFor,
  pickableSpeechModels,
  resolveSpeechModel,
  SpeechRejectedError,
  SpeechUnavailableError,
  type SpeechHost,
  type SpeechModel,
  targetSpeechModelId,
  toDeepInfraSpeechModels,
  toSpeechModels,
} from "@/server/services/speech";
import { UNREADABLE_API_KEY } from "@/server/services/unreadable-api-key";
import { isOnUserKey, type AiProviderKeys } from "@/server/services/ai-providers";
import type { SpeechProvider } from "@/lib/ai/providers";
import {
  canNarrate,
  voicesFromSchema,
  type DeepInfraSpeechModel,
} from "@/server/services/deepinfra";
import type { OpenRouterModel } from "@/server/services/openrouter";
import { ProviderRejectedError } from "@/server/services/provider-errors";
import { PLAN_LIMITS } from "@/lib/plans";
import {
  DEEPINFRA_KOKORO,
  DEFAULT_CLOUD_VOICES,
  OPENROUTER_KOKORO,
  SELFHOSTED_KOKORO,
} from "@/lib/narration/constants";

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

const ENV_VARS = [
  "OPENROUTER_API_KEY",
  "DEEPINFRA_API_KEY",
  "SELFHOSTED_API_KEY",
  "MODEL_FAILOVER",
  "SERVER_KEY_MODELS",
  "SERVER_KEY_MAX_SPEECH_PRICE",
] as const;
const originalEnv = Object.fromEntries(ENV_VARS.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of ENV_VARS) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** Hosts as listed to the key they'd run on: the user's own, if they have one. */
const onTheirKey = (models: SpeechModel[], keys: AiProviderKeys): SpeechHost[] =>
  models.map((model) => ({ model, onUserKey: isOnUserKey(model.provider, keys) }));

const openRouterModels = (keys: AiProviderKeys) =>
  pickableSpeechModels(onTheirKey(toSpeechModels(catalog), keys), keys);

describe("OpenRouter speech models", () => {
  it("lists every model with voices on the user's own key, priced per character", () => {
    const models = openRouterModels({ openrouter: "o", plan: null });
    expect(models.map((model) => model.id)).toEqual([
      "openrouter:hexgrad/kokoro-82m",
      "openrouter:minimax/speech-2.8-hd",
      "openrouter:google/gemini-3.8-flash-tts",
    ]);
    expect(models[0].pricePerMillionCharacters).toBe(4);
  });

  it("omits the per-character price for models that also bill generated audio", () => {
    const [, , gemini] = openRouterModels({ openrouter: "o", plan: null });
    expect(gemini.pricePerMillionCharacters).toBeUndefined();
  });

  it("lists every model with voices on the server's key by default", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    expect(openRouterModels({ plan: null })).toHaveLength(3);
  });

  it("lists none on the server's key for a plan without cloud voices, all on the user's own", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    const plan = {
      userId: "u",
      limits: {
        ...PLAN_LIMITS.paid,
        quotas: { ...PLAN_LIMITS.paid.quotas, speechCharacters: "excluded" as const },
      },
      serverKeyModels: null,
    };
    expect(openRouterModels({ plan })).toEqual([]);
    expect(openRouterModels({ openrouter: "o", plan })).toHaveLength(3);
  });

  it("limits the server's key to models within the speech price cap", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-server";
    process.env.SERVER_KEY_MAX_SPEECH_PRICE = "5";
    // Gemini's per-character cost is unknown, so it's left out too.
    expect(openRouterModels({ plan: null }).map((model) => model.id)).toEqual([
      "openrouter:hexgrad/kokoro-82m",
    ]);
  });
});

describe("a model with several hosts", () => {
  const kokoro = (id: string, provider: SpeechProvider, voices: string[]): SpeechModel => ({
    id,
    displayName: `${provider} Kokoro`,
    provider,
    voices: voices.map((voice) => ({ id: voice, name: voice })),
  });
  const selfHosted = kokoro(SELFHOSTED_KOKORO, "selfhosted", ["af_heart", "af_bella"]);
  const deepInfra = kokoro(DEEPINFRA_KOKORO, "deepinfra", ["af_heart", "bm_george"]);
  const ours = (model: SpeechModel): SpeechHost => ({ model, onUserKey: false });
  const theirs = (model: SpeechModel): SpeechHost => ({ model, onUserKey: true });
  const selfHostedDown = [{ provider: "selfhosted" as const, onUserKey: false }];
  const freePlan = (serverKeyModels: string[]) => ({
    userId: "u",
    limits: PLAN_LIMITS.free,
    serverKeyModels,
  });

  beforeEach(() => {
    process.env.SELFHOSTED_API_KEY = "self";
    process.env.DEEPINFRA_API_KEY = "di-server";
    process.env.MODEL_FAILOVER = `${SELFHOSTED_KOKORO},${DEEPINFRA_KOKORO}`;
    // DeepInfra's Kokoro may only run as a failover.
    process.env.SERVER_KEY_MODELS = "selfhosted:*";
  });

  it("is listed once, under its first host's id, with every host's voices", () => {
    const models = pickableSpeechModels([ours(deepInfra), ours(selfHosted)], { plan: null });
    expect(models).toEqual([
      expect.objectContaining({
        id: SELFHOSTED_KOKORO,
        provider: "selfhosted",
        voices: ["af_heart", "af_bella", "bm_george"].map((id) => ({ id, name: id })),
        hosts: [ours(selfHosted), ours(deepInfra)],
      }),
    ]);
  });

  it("is said on the user's own key first, backed up by the other hosts on ours", () => {
    const [model] = pickableSpeechModels([ours(selfHosted), theirs(deepInfra), ours(deepInfra)], {
      deepinfra: "d",
      plan: null,
    });
    expect(model.hosts).toEqual([theirs(deepInfra), ours(selfHosted)]);
  });

  it("stays listed, said by the other hosts, while its first host's catalog is down", () => {
    const [model] = pickableSpeechModels([ours(deepInfra)], { plan: null }, selfHostedDown);
    expect(model).toEqual(
      expect.objectContaining({
        id: SELFHOSTED_KOKORO,
        provider: "deepinfra",
        hosts: [ours(deepInfra)],
      })
    );
  });

  it("isn't listed through a failover host alone", () => {
    process.env.SERVER_KEY_MODELS = "openrouter:*";
    expect(pickableSpeechModels([ours(deepInfra)], { plan: null }, selfHostedDown)).toEqual([]);
  });

  it("isn't said by a host the user's plan doesn't allow on the server's key", () => {
    const plan = freePlan(["selfhosted:*"]);
    expect(pickableSpeechModels([ours(deepInfra)], { plan }, selfHostedDown)).toEqual([]);
    const [model] = pickableSpeechModels([ours(selfHosted), ours(deepInfra)], { plan });
    expect(model.hosts).toEqual([ours(selfHosted)]);
  });

  it("isn't kept listed by the user's own key's catalog being down", () => {
    process.env.SERVER_KEY_MODELS = "openrouter:*";
    const ownDown = [{ provider: "deepinfra" as const, onUserKey: true }];
    expect(
      pickableSpeechModels([ours(selfHosted)], { deepinfra: "d", plan: null }, ownDown)
    ).toEqual([]);
  });

  it("never says on the server's key what the user's own key would, even unreadable", () => {
    process.env.SERVER_KEY_MAX_SPEECH_PRICE = "10";
    const keys: AiProviderKeys = { deepinfra: UNREADABLE_API_KEY, plan: null };
    const qwen = kokoro("deepinfra:Qwen/Qwen3-TTS", "deepinfra", ["Vivian"]);
    const models = pickableSpeechModels([ours(selfHosted), ours(deepInfra), ours(qwen)], keys);
    expect(models.map((model) => [model.id, model.hosts])).toEqual([
      [SELFHOSTED_KOKORO, [ours(selfHosted)]],
    ]);
  });

  it("asks for an unreadable key again only if it's the one that would say it", () => {
    const keys: AiProviderKeys = { selfhosted: "s", deepinfra: UNREADABLE_API_KEY, plan: null };
    const models = pickableSpeechModels([theirs(selfHosted)], keys);
    const resolved = resolveSpeechModel({ models, unavailable: [] }, keys, DEEPINFRA_KOKORO, null);
    expect(resolved.model.id).toBe(SELFHOSTED_KOKORO);
    expect(() =>
      resolveSpeechModel(
        { models: [], unavailable: [] },
        { deepinfra: UNREADABLE_API_KEY, plan: null },
        DEEPINFRA_KOKORO,
        null
      )
    ).toThrow(SpeechRejectedError);
  });

  it("reports the failure of the catalog on the key the host would use", () => {
    const refused = new ProviderRejectedError("", "Lion Reader", null, 401);
    const unavailable = [
      { provider: "selfhosted" as const, onUserKey: false, error: refused },
      { provider: "selfhosted" as const, onUserKey: true, error: new Error("timed out") },
    ];
    const keys: AiProviderKeys = { selfhosted: "s", plan: null };
    const other = { ...deepInfra, id: "deepinfra:other", hosts: [ours(deepInfra)] };
    expect(() =>
      resolveSpeechModel({ models: [other], unavailable }, keys, SELFHOSTED_KOKORO, null)
    ).toThrow(SpeechUnavailableError);
  });

  it("is run for a request naming any of its hosts", () => {
    const models = pickableSpeechModels([ours(selfHosted), ours(deepInfra)], { plan: null });
    expect(targetSpeechModelId(models, { plan: null }, DEEPINFRA_KOKORO)).toBe(SELFHOSTED_KOKORO);
  });
});

describe("defaultVoiceFor", () => {
  it("prefers the curated default voice, else the first listed", () => {
    const [kokoro, minimax] = openRouterModels({ openrouter: "o", plan: null });
    expect(defaultVoiceFor(kokoro)).toBe(DEFAULT_CLOUD_VOICES[OPENROUTER_KOKORO]);
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

const deepInfraModels = (keys: AiProviderKeys) =>
  pickableSpeechModels(onTheirKey(toDeepInfraSpeechModels(deepInfraCatalog), keys), keys);

describe("DeepInfra speech models", () => {
  it("lists every model on the user's own key, named like OpenRouter's", () => {
    const models = deepInfraModels({ deepinfra: "d", plan: null });
    expect(models.map((model) => [model.id, model.displayName, model.provider])).toEqual([
      ["deepinfra:hexgrad/Kokoro-82M", "hexgrad: Kokoro 82M", "deepinfra"],
      ["deepinfra:inworld-ai/realtime-tts-2", "inworld ai: realtime tts 2", "deepinfra"],
    ]);
    expect(models[0].pricePerMillionCharacters).toBe(0.62);
  });

  it("limits the server's key to the listed models", () => {
    process.env.DEEPINFRA_API_KEY = "server";
    process.env.SERVER_KEY_MODELS = DEEPINFRA_KOKORO;
    expect(deepInfraModels({ plan: null }).map((model) => model.id)).toEqual([
      "deepinfra:hexgrad/Kokoro-82M",
    ]);
  });

  it("isn't unlocked by an OpenRouter key", () => {
    process.env.DEEPINFRA_API_KEY = "server";
    process.env.SERVER_KEY_MODELS = DEEPINFRA_KOKORO;
    expect(deepInfraModels({ openrouter: "o", plan: null })).toHaveLength(1);
  });
});

describe("defaultSpeechModelId", () => {
  const openRouter = openRouterModels({ openrouter: "o", plan: null });
  const deepInfra = deepInfraModels({ deepinfra: "d", plan: null });

  it("prefers DeepInfra's Kokoro, then OpenRouter's", () => {
    expect(defaultSpeechModelId([...openRouter, ...deepInfra])).toBe(DEEPINFRA_KOKORO);
    expect(defaultSpeechModelId(openRouter)).toBe(OPENROUTER_KOKORO);
  });

  it("falls back to whatever is available", () => {
    const [, inworld] = deepInfra;
    expect(defaultSpeechModelId([inworld])).toBe(inworld.id);
  });

  it("gives DeepInfra's Kokoro its curated default voice too", () => {
    expect(defaultVoiceFor(deepInfra[0])).toBe(DEFAULT_CLOUD_VOICES[DEEPINFRA_KOKORO]);
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

  const catalog = (
    models: SpeechModel[],
    unavailable: SpeechProvider[] = [],
    error: unknown = new Error("timed out"),
    onUserKey = false
  ) => ({
    models: models.map((model) => ({ ...model, hosts: [{ model, onUserKey }] })),
    unavailable: unavailable.map((provider) => ({ provider, onUserKey, error })),
  });

  it("uses the default model and voice when nothing is chosen", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    expect(resolveSpeechModel(catalog([deepInfraKokoro]), { plan: null }, null, null)).toEqual({
      model: expect.objectContaining(deepInfraKokoro),
      voice: DEFAULT_CLOUD_VOICES[DEEPINFRA_KOKORO],
    });
  });

  it("falls back to the default when the chosen model's provider has no key", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    delete process.env.OPENROUTER_API_KEY;
    expect(
      resolveSpeechModel(catalog([deepInfraKokoro]), { plan: null }, OPENROUTER_KOKORO, "bm_george")
    ).toEqual({
      model: expect.objectContaining(deepInfraKokoro),
      voice: "bm_george",
    });
  });

  it("falls back from a model the server's key doesn't allow", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    process.env.SERVER_KEY_MODELS = DEEPINFRA_KOKORO;
    expect(
      resolveSpeechModel(catalog([deepInfraKokoro]), { plan: null }, qwen.id, "Vivian")
    ).toEqual({
      model: expect.objectContaining(deepInfraKokoro),
      voice: DEFAULT_CLOUD_VOICES[DEEPINFRA_KOKORO],
    });
  });

  it("keeps a model chosen on the user's own key, even if it's no longer listed", () => {
    const keys = { deepinfra: "d", plan: null };
    expect(resolveSpeechModel(catalog([deepInfraKokoro, qwen]), keys, qwen.id, null).model.id).toBe(
      qwen.id
    );
    expect(() => resolveSpeechModel(catalog([deepInfraKokoro]), keys, qwen.id, null)).toThrow(
      "Speech model not available"
    );
  });

  it("fails retryably when the chosen model's provider couldn't be listed", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    const keys = { openrouter: "o", plan: null };
    expect(() =>
      resolveSpeechModel(
        catalog([deepInfraKokoro], ["openrouter"], new Error("timed out"), true),
        keys,
        OPENROUTER_KOKORO,
        null
      )
    ).toThrow(
      new SpeechUnavailableError("Couldn't get OpenRouter's cloud voices; try again shortly")
    );
    expect(() =>
      resolveSpeechModel(catalog([], ["deepinfra"]), { plan: null }, null, null)
    ).toThrow(SpeechUnavailableError);
  });

  describe("a provider refusing", () => {
    const refusal = (keys: AiProviderKeys, status = 402) => {
      const refused = new ProviderRejectedError("", "OpenRouter", "Insufficient credits", status);
      try {
        resolveSpeechModel(
          catalog([], ["openrouter"], refused, isOnUserKey("openrouter", keys)),
          keys,
          OPENROUTER_KOKORO,
          null
        );
      } catch (error) {
        expect(error).toBeInstanceOf(SpeechRejectedError);
        return (error as Error).message;
      }
      throw new Error("Not refused");
    };

    it("says it was the user's own key, and why", () => {
      const message = refusal({ openrouter: "o", plan: null });
      expect(message).toContain("your API key");
      expect(message).toContain("Insufficient credits");
    });

    it("says it was the server's key, keeping the operator's account private", () => {
      process.env.OPENROUTER_API_KEY = "or-server";
      const message = refusal({ plan: null });
      expect(message).toContain("server's OpenRouter API key");
      expect(message).not.toContain("Insufficient credits");
    });

    it("doesn't blame a key for a refused request", () => {
      expect(refusal({ openrouter: "o", plan: null }, 400)).not.toContain("key");
    });
  });

  it("needs a provider, and names them", () => {
    expect(() => resolveSpeechModel(catalog([]), { plan: null }, null, null)).toThrow(
      "Cloud voices require an API key from DeepInfra, OpenRouter, BreezeBlue, or Together AI"
    );
  });

  it("asks for the key again when the chosen model's saved key can't be read", () => {
    process.env.DEEPINFRA_API_KEY = "di-server";
    expect(() =>
      resolveSpeechModel(
        catalog([deepInfraKokoro]),
        { openrouter: UNREADABLE_API_KEY, plan: null },
        OPENROUTER_KOKORO,
        null
      )
    ).toThrow(
      new SpeechRejectedError(
        "Your saved OpenRouter API key can't be read; enter it again in Settings."
      )
    );
  });
});

describe("targetSpeechModelId", () => {
  const listed = (...ids: string[]): SpeechModel[] =>
    ids.map((id) => ({
      id,
      displayName: id,
      provider: id.split(":")[0] as SpeechProvider,
      voices: [{ id: "v", name: "v" }],
    }));

  it.each([
    ["nothing asked for", listed(DEEPINFRA_KOKORO), {}, null, DEEPINFRA_KOKORO],
    [
      "a listed model",
      listed(DEEPINFRA_KOKORO, OPENROUTER_KOKORO),
      {},
      OPENROUTER_KOKORO,
      OPENROUTER_KOKORO,
    ],
    [
      "an unlisted model on the server's key",
      listed(DEEPINFRA_KOKORO),
      {},
      OPENROUTER_KOKORO,
      DEEPINFRA_KOKORO,
    ],
    [
      "an unlisted model on the user's own key",
      listed(DEEPINFRA_KOKORO),
      { openrouter: "o" },
      OPENROUTER_KOKORO,
      OPENROUTER_KOKORO,
    ],
    [
      "an unlisted model on an unreadable key",
      listed(DEEPINFRA_KOKORO),
      { openrouter: UNREADABLE_API_KEY },
      OPENROUTER_KOKORO,
      OPENROUTER_KOKORO,
    ],
  ] as const)("for %s", (_, models, keys, requested, expected) => {
    expect(targetSpeechModelId(models, { ...keys, plan: null }, requested)).toBe(expected);
  });
});
