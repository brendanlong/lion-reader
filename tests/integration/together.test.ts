/**
 * Together AI cloud voices, and failing over to another model when the one
 * asked for is busy, against local stand-ins for Together and BreezeBlue.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { eq } from "drizzle-orm";
import { SPEECH_FAILOVER_HEADER } from "../../src/lib/narration/constants";
import { listSpeechModels, streamSpeech } from "../../src/server/services/speech";
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";
import { POST as speechPost } from "../../src/app/api/v1/narration/speech/route";
import { createSession } from "../../src/server/auth/session";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createTestUser } from "./helpers";

const KOKORO = "together:hexgrad/Kokoro-82M";
const BREEZE = "breezeblue:breeze-tts-2";

let server: Server;
const requests: Array<{ provider: "together" | "breezeblue"; path: string; body: unknown }> = [];
/** Together speech requests to turn away as busy before answering. */
let togetherBusy = 0;
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
            // Listed, but only on a dedicated endpoint: no price.
            { id: "deepgram/aura-2", type: "audio", display_name: "Aura 2", pricing: { input: 0 } },
            { id: "some/chat-model", type: "chat", pricing: { input: 0.5 } },
          ]);
        }
        if (path === "/voices") {
          return json({
            data: [
              { model: "hexgrad/Kokoro-82M", voices: [{ name: "af_heart" }, { name: "af_bella" }] },
              { model: "deepgram/aura-2", voices: [{ name: "thalia" }] },
            ],
          });
        }
        if (path === "/audio/speech") {
          requests.push({ provider, path, body: JSON.parse(body) });
          if (togetherBusy > 0) {
            togetherBusy--;
            return json({ error: { message: "Model busy", type: "rate_limit" } }, 429);
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
        if (path === "/voices") return json({ voices: [{ voice_id: "elara", name: "Elara" }] });
        if (path.startsWith("/text-to-speech/")) {
          requests.push({ provider, path, body: JSON.parse(body) });
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
    SPEECH_FAILOVER_MODELS: `${KOKORO}, ${BREEZE}`,
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
  togetherBusy = 0;
});

const userKeys = () => ({ together: randomUUID(), breezeblue: randomUUID() });

function requestsSince(before: number) {
  return requests.slice(before).map(({ provider }) => provider);
}

describe("Together voices", () => {
  it("lists the speech models it serves serverless, with their voices and price", async () => {
    const { models } = await listSpeechModels({ together: randomUUID() });
    expect(models).toEqual([
      {
        id: KOKORO,
        displayName: "Kokoro 82M",
        provider: "together",
        voices: [
          { id: "af_heart", name: "af_heart" },
          { id: "af_bella", name: "af_bella" },
        ],
        pricePerMillionCharacters: 4,
      },
    ]);
  });

  it("streams the voice as fragmented MP4, asking for 16-bit PCM", async () => {
    const before = requests.length;
    const { audio, failoverModel } = await streamSpeech(
      { together: randomUUID() },
      { model: KOKORO, voice: "af_bella", text: "Hello.", userId: randomUUID() }
    );
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(await new Response(audio).arrayBuffer()),
    });
    expect(await input.computeDuration()).toBeGreaterThan(0.2);
    expect(failoverModel).toBeNull();
    expect(requests[before].body).toMatchObject({
      model: "hexgrad/Kokoro-82M",
      voice: "af_bella",
      input: "Hello.",
      stream: true,
      response_encoding: "pcm_s16le",
    });
  });
});

describe("speech failover", () => {
  it("goes straight to the next model in the list when the one asked for is busy", async () => {
    togetherBusy = 1;
    const before = requests.length;
    const { audio, failoverModel } = await streamSpeech(userKeys(), {
      model: KOKORO,
      voice: "af_heart",
      text: "Hi.",
      userId: randomUUID(),
    });
    await new Response(audio).arrayBuffer();
    expect(failoverModel).toBe(BREEZE);
    expect(requestsSince(before)).toEqual(["together", "breezeblue"]);
    // BreezeBlue has no af_heart: its default voice.
    expect(requests.at(-1)?.path).toBe("/text-to-speech/elara/stream");
  });

  it("waits out a busy model that isn't in the list", async () => {
    process.env.SPEECH_FAILOVER_MODELS = BREEZE;
    togetherBusy = 1;
    const before = requests.length;
    try {
      const { failoverModel } = await streamSpeech(userKeys(), {
        model: KOKORO,
        voice: "af_heart",
        text: "Hi.",
        userId: randomUUID(),
      });
      expect(failoverModel).toBeNull();
      expect(requestsSince(before)).toEqual(["together", "together"]);
    } finally {
      process.env.SPEECH_FAILOVER_MODELS = `${KOKORO}, ${BREEZE}`;
    }
  });

  it("never fails over an exact request", async () => {
    togetherBusy = 1;
    const before = requests.length;
    const { failoverModel } = await streamSpeech(userKeys(), {
      model: KOKORO,
      voice: "af_heart",
      text: "Hi.",
      userId: randomUUID(),
      exact: true,
    });
    expect(failoverModel).toBeNull();
    expect(requestsSince(before)).toEqual(["together", "together"]);
  });

  it("only fails over to a model allowed on the key it would bill", async () => {
    process.env.BREEZEBLUE_API_KEY = randomUUID();
    process.env.SERVER_KEY_MODELS = KOKORO;
    togetherBusy = 1;
    const before = requests.length;
    try {
      const { failoverModel } = await streamSpeech(
        { together: randomUUID() },
        { model: KOKORO, voice: "af_heart", text: "Hi.", userId: randomUUID() }
      );
      expect(failoverModel).toBeNull();
      expect(requestsSince(before)).toEqual(["together", "together"]);
    } finally {
      delete process.env.BREEZEBLUE_API_KEY;
      delete process.env.SERVER_KEY_MODELS;
    }
  });

  it("names the failover model in the speech route's answer", async () => {
    process.env.TOGETHER_API_KEY = randomUUID();
    process.env.BREEZEBLUE_API_KEY = randomUUID();
    const userId = await createTestUser({ emailPrefix: "together" });
    togetherBusy = 1;
    try {
      const { token } = await createSession(db, { userId });
      const res = await speechPost(
        new Request("http://localhost:3000/api/v1/narration/speech", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `session=${token}` },
          body: JSON.stringify({ model: KOKORO, voice: "af_heart", text: "Hi." }),
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get(SPEECH_FAILOVER_HEADER)).toBe(BREEZE);
      await res.arrayBuffer();
    } finally {
      delete process.env.TOGETHER_API_KEY;
      delete process.env.BREEZEBLUE_API_KEY;
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
