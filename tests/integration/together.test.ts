/**
 * Together AI cloud voices, and failing over to another host of the same
 * model when the one asked is busy, against local stand-ins for Together and
 * BreezeBlue.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import {
  listSpeechModels,
  SpeechRejectedError,
  streamSpeech,
} from "../../src/server/services/speech";
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";

const KOKORO = "together:hexgrad/Kokoro-82M";
const ORPHEUS = "together:canopylabs/orpheus-3b-0.1-ft";
const BREEZE = "breezeblue:breeze-tts-2";
const FAILOVER = `${KOKORO}, ${ORPHEUS}, ${BREEZE}`;

let server: Server;
/** Speech requests, by the model asked for. */
const requests: Array<{ model: string; path: string; body: unknown }> = [];
/** How many speech requests for a Together model to turn away as busy. */
const busy = new Map<string, number>();
/** Together models that refuse speech requests. */
const refusing = new Set<string>();
/** Together models whose speech requests fail: a 500, or an error event before any audio. */
const failing = new Map<string, "500" | "event" | "empty">();
const saved = new Map<string, string | undefined>();

/** A quarter second of sound at 24 kHz mono, 16-bit. */
function speech(): Buffer {
  const audio = Buffer.alloc(24_000 / 2);
  for (let at = 0; at < audio.length; at += 2) audio.writeInt16LE(8000, at);
  return audio;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const [, provider, ...rest] = url.pathname.split("/");
      const path = `/${rest.join("/")}`;
      if (provider === "together") {
        if (path === "/models") {
          // Shaped like Together's (checked against the real API).
          return json([
            {
              id: "hexgrad/Kokoro-82M",
              type: "audio",
              display_name: "Kokoro 82M",
              pricing: { input: 4, output: 0 },
            },
            {
              id: "canopylabs/orpheus-3b-0.1-ft",
              type: "audio",
              display_name: "Orpheus 3B 0.1 FT",
              pricing: { input: 15, output: 0 },
            },
            // Listed, but only on a dedicated endpoint: no price.
            { id: "deepgram/aura-2", type: "audio", display_name: "Aura 2", pricing: { input: 0 } },
            { id: "some/chat-model", type: "chat", pricing: { input: 0.5 } },
          ]);
        }
        if (path === "/voices") {
          return json({
            data: [
              { model: "hexgrad/Kokoro-82M", voices: [{ name: "af_heart" }, { name: "af_bella" }] },
              // Not Orpheus's real voices: one it shares with Kokoro.
              {
                model: "canopylabs/orpheus-3b-0.1-ft",
                voices: [{ name: "tara" }, { name: "af_bella" }],
              },
              { model: "deepgram/aura-2", voices: [{ name: "thalia" }] },
            ],
          });
        }
        if (path === "/audio/speech") {
          const request = JSON.parse(body) as { model: string };
          const model = `together:${request.model}`;
          requests.push({ model, path, body: request });
          const turnAway = busy.get(model) ?? 0;
          if (turnAway > 0) {
            busy.set(model, turnAway - 1);
            return json({ error: { message: "Model busy", type: "rate_limit" } }, 429);
          }
          if (failing.get(model) === "500") return json({ error: "Internal error" }, 500);
          if (failing.get(model) === "empty") {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end("data: [DONE]\n\n");
            return;
          }
          if (failing.get(model) === "event") {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.end(`data: ${JSON.stringify({ error: { message: "Model busy" } })}\n\n`);
            return;
          }
          if (refusing.has(model)) {
            // What Together answers for a model it serves only on a dedicated endpoint.
            return json({ error: { message: "Unable to access non-serverless model" } }, 400);
          }
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          // Split mid-event, as a network would.
          const audio = speech();
          const events = [audio.subarray(0, 4001), audio.subarray(4001)]
            .map(
              (part) =>
                `data: ${JSON.stringify({ type: "conversation.item.audio_output.delta", delta: part.toString("base64") })}\n\n`
            )
            .join("");
          res.write(events.slice(0, 100));
          res.end(`${events.slice(100)}data: [DONE]\n\n`);
          return;
        }
      }
      if (provider === "breezeblue") {
        if (path === "/models") return json([{ model_id: "breeze-tts-2", name: "Breeze TTS 2" }]);
        if (path === "/voices") {
          return json({
            voices: [
              { voice_id: "elara", name: "Elara" },
              { voice_id: "af_bella", name: "Bella" },
            ],
          });
        }
        if (path.startsWith("/text-to-speech/")) {
          requests.push({ model: BREEZE, path, body: JSON.parse(body) });
          res.writeHead(200, { "Content-Type": "audio/pcm" });
          res.end(speech());
          return;
        }
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: Record<string, string | undefined> = {
    TOGETHER_BASE_URL: `${base}/together`,
    BREEZEBLUE_BASE_URL: `${base}/breezeblue`,
    MODEL_FAILOVER: FAILOVER,
    SERVER_KEY_MODELS: undefined,
    ...Object.fromEntries(Object.values(AI_PROVIDER_ENV_KEYS).map((name) => [name, undefined])),
  };
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterEach(() => {
  busy.clear();
  refusing.clear();
  failing.clear();
  process.env.MODEL_FAILOVER = FAILOVER;
  for (const name of ["SERVER_KEY_MODELS", "TOGETHER_API_KEY", "BREEZEBLUE_API_KEY"]) {
    delete process.env[name];
  }
});

const userKeys = () => ({ together: randomUUID(), breezeblue: randomUUID() });

/** Says "Hi." as asked, returning which models were asked for it, in order. */
async function speak(
  keys: Parameters<typeof streamSpeech>[0],
  options: { model?: string; voice?: string; exact?: boolean } = {}
) {
  const before = requests.length;
  const audio = await streamSpeech(keys, {
    model: options.model ?? KOKORO,
    voice: options.voice ?? "af_bella",
    text: "Hi.",
    userId: randomUUID(),
    exact: options.exact,
  });
  await new Response(audio).arrayBuffer();
  return requests.slice(before);
}

const modelsOf = (asked: typeof requests) => asked.map((request) => request.model);

describe("Together voices", () => {
  it("lists the speech models it serves serverless, with their voices and price", async () => {
    const { models } = await listSpeechModels({ together: randomUUID() });
    expect(
      models.map((model) => [model.id, model.displayName, model.pricePerMillionCharacters])
    ).toEqual([
      [KOKORO, "Kokoro 82M", 4],
      [ORPHEUS, "Orpheus 3B 0.1 FT", 15],
    ]);
    expect(models[0].voices).toEqual([
      { id: "af_heart", name: "af_heart" },
      { id: "af_bella", name: "af_bella" },
    ]);
  });

  it("streams the voice as fragmented MP4, asking for 16-bit PCM", async () => {
    const before = requests.length;
    const audio = await streamSpeech(
      { together: randomUUID() },
      { model: KOKORO, voice: "af_bella", text: "Hello.", userId: randomUUID() }
    );
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(await new Response(audio).arrayBuffer()),
    });
    expect(await input.computeDuration()).toBeGreaterThan(0.2);
    expect(requests[before].body).toMatchObject({
      model: "hexgrad/Kokoro-82M",
      voice: "af_bella",
      input: "Hello.",
      stream: true,
      response_encoding: "pcm_s16le",
    });
  });
});

// Kokoro, Orpheus and BreezeBlue stand in for hosts of one model: the
// stand-ins share af_bella, and only Kokoro has af_heart.
describe("speech failover", () => {
  it("goes straight to the next host, in the same voice", async () => {
    busy.set(KOKORO, 1);
    const asked = await speak(userKeys());
    expect(modelsOf(asked)).toEqual([KOKORO, ORPHEUS]);
    expect(asked[1].body).toMatchObject({ voice: "af_bella" });
  });

  it("fails over when the host asked fails", async () => {
    failing.set(KOKORO, "500");
    expect(modelsOf(await speak(userKeys()))).toEqual([KOKORO, ORPHEUS]);
  });

  it("passes over a host that's busy, refuses or fails", async () => {
    for (const passOver of [
      () => busy.set(ORPHEUS, 1),
      () => refusing.add(ORPHEUS),
      () => failing.set(ORPHEUS, "event"),
      () => failing.set(ORPHEUS, "empty"),
    ]) {
      busy.set(KOKORO, 1);
      passOver();
      const asked = await speak(userKeys());
      expect(modelsOf(asked)).toEqual([KOKORO, ORPHEUS, BREEZE]);
      expect(asked[2].path).toBe("/text-to-speech/af_bella/stream");
      busy.clear();
      refusing.clear();
      failing.clear();
    }
  });

  it("doesn't fail over a request the host asked refused", async () => {
    refusing.add(KOKORO);
    const before = requests.length;
    await expect(speak(userKeys())).rejects.toThrow(SpeechRejectedError);
    expect(modelsOf(requests.slice(before))).toEqual([KOKORO]);
  });

  it.each([
    ["a voice no other host has", () => {}, { voice: "af_heart" }],
    ["a model in no group", () => (process.env.MODEL_FAILOVER = `${ORPHEUS},${BREEZE}`), {}],
    ["an exact request", () => {}, { exact: true }],
  ])("waits out a busy host for %s", async (_, setUp, options) => {
    setUp();
    busy.set(KOKORO, 1);
    expect(modelsOf(await speak(userKeys(), options))).toEqual([KOKORO, KOKORO]);
  });

  it("fails over on the server's key to a model it doesn't let users pick", async () => {
    process.env.TOGETHER_API_KEY = randomUUID();
    process.env.SERVER_KEY_MODELS = KOKORO;
    const { models } = await listSpeechModels({});
    expect(models.map((model) => model.id)).toEqual([KOKORO]);

    busy.set(KOKORO, 1);
    expect(modelsOf(await speak({}))).toEqual([KOKORO, ORPHEUS]);
  });

  it("never fails over from the user's own key to the server's", async () => {
    process.env.BREEZEBLUE_API_KEY = randomUUID();
    busy.set(KOKORO, 1);
    busy.set(ORPHEUS, 1);
    expect(modelsOf(await speak({ together: randomUUID() }))).toEqual([KOKORO, ORPHEUS, KOKORO]);
  });
});
