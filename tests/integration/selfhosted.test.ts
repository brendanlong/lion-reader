/**
 * Cloud voices from the operator's own Kokoro-FastAPI server, and falling back
 * to another host of Kokoro when it's down, against local stand-ins for it
 * and Together.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
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
import { SELFHOSTED_KOKORO } from "../../src/lib/narration/constants";
import { checkSelfHostedConfig } from "../../src/server/services/selfhosted";

const TOGETHER_KOKORO = "together:hexgrad/Kokoro-82M";

let server: Server;
let base: string;
const requests: Array<{ model: string; key: string; body: Record<string, unknown> }> = [];
/** The Cloudflare Access headers each self-hosted request carried. */
const accessTokens: Array<{ id: unknown; secret: unknown }> = [];
/** How the stand-in lists voices: Kokoro-FastAPI's older bare ids or newer objects. */
let voiceShape: "ids" | "objects" = "objects";
/** "302" is Cloudflare Access sending a refused service token to its sign-in page. */
let selfHostedFails: "500" | "401" | "302" | false = false;
const saved = new Map<string, string | undefined>();

/** A second of sound at 24 kHz mono, 16-bit. */
function speech(): Buffer {
  const audio = Buffer.alloc(24_000 * 2);
  for (let at = 0; at < audio.length; at += 2) audio.writeInt16LE(8000, at);
  return audio;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const key = String(req.headers.authorization).replace(/^Bearer /, "");
      if (req.url?.startsWith("/selfhosted/")) {
        accessTokens.push({
          id: req.headers["cf-access-client-id"],
          secret: req.headers["cf-access-client-secret"],
        });
      }
      switch (req.url) {
        case "/selfhosted/v1/audio/voices": {
          const voices = ["af_heart", "af_bella"];
          return json({
            voices: voiceShape === "ids" ? voices : voices.map((id) => ({ id })),
          });
        }
        case "/selfhosted/v1/audio/speech": {
          const request = JSON.parse(body) as Record<string, unknown>;
          requests.push({ model: `selfhosted:${String(request.model)}`, key, body: request });
          if (selfHostedFails === "500") return json({ detail: "Internal Server Error" }, 500);
          if (selfHostedFails === "401") return json({ detail: "Invalid API key" }, 401);
          if (selfHostedFails === "302") {
            res
              .writeHead(302, {
                Location: "https://example.cloudflareaccess.com/cdn-cgi/access/login",
              })
              .end("Redirecting");
            return;
          }
          res.writeHead(200, { "Content-Type": "audio/pcm" });
          res.end(speech());
          return;
        }
        case "/together/models":
          return json([
            {
              id: "hexgrad/Kokoro-82M",
              type: "audio",
              display_name: "Kokoro 82M",
              pricing: { input: 4 },
            },
          ]);
        case "/together/voices":
          return json({
            data: [{ model: "hexgrad/Kokoro-82M", voices: [{ name: "af_bella" }] }],
          });
        case "/together/audio/speech": {
          const request = JSON.parse(body) as Record<string, unknown>;
          requests.push({ model: `together:${String(request.model)}`, key, body: request });
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.end(
            `data: ${JSON.stringify({ delta: speech().toString("base64") })}\n\ndata: [DONE]\n\n`
          );
          return;
        }
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env: Record<string, string | undefined> = {
    TOGETHER_BASE_URL: `${base}/together`,
    MODEL_FAILOVER: `${SELFHOSTED_KOKORO},${TOGETHER_KOKORO}`,
    SERVER_KEY_MODELS: undefined,
    ...Object.fromEntries(Object.values(AI_PROVIDER_ENV_KEYS).map((name) => [name, undefined])),
  };
  for (const name of [
    ...Object.keys(env),
    "SELFHOSTED_BASE_URL",
    "SELFHOSTED_CF_ACCESS_CLIENT_ID",
    "SELFHOSTED_CF_ACCESS_CLIENT_SECRET",
  ]) {
    saved.set(name, process.env[name]);
  }
  for (const [name, value] of Object.entries(env)) {
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

beforeEach(() => {
  process.env.SELFHOSTED_BASE_URL = `${base}/selfhosted/v1`;
  // A fresh key each test, so the voices aren't served from another's catalog.
  process.env.SELFHOSTED_API_KEY = randomUUID();
});

afterEach(() => {
  voiceShape = "objects";
  selfHostedFails = false;
  delete process.env.TOGETHER_API_KEY;
  delete process.env.SELFHOSTED_CF_ACCESS_CLIENT_ID;
  delete process.env.SELFHOSTED_CF_ACCESS_CLIENT_SECRET;
});

async function speak(model: string | null) {
  const before = requests.length;
  const audio = await streamSpeech(
    { plan: null },
    { model, voice: "af_bella", text: "Hello.", userId: randomUUID() }
  );
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(await new Response(audio).arrayBuffer()),
  });
  // The stand-in's second, read at Kokoro's 24 kHz, plus the encoder's padding.
  const duration = await input.computeDuration();
  expect(duration).toBeGreaterThanOrEqual(1);
  expect(duration).toBeLessThan(1.2);
  return requests.slice(before);
}

describe("self-hosted voices", () => {
  it.each(["ids", "objects"] as const)(
    "lists Kokoro with the server's voices (%s)",
    async (shape) => {
      voiceShape = shape;
      const { models } = await listSpeechModels({ plan: null });
      expect(models.map((model) => model.id)).toEqual([SELFHOSTED_KOKORO]);
      expect(models[0].voices.map((voice) => voice.id)).toEqual(["af_heart", "af_bella"]);
    }
  );

  it("streams the voice as fragmented MP4, asking for PCM with the server's key", async () => {
    const asked = await speak(SELFHOSTED_KOKORO);
    expect(asked).toEqual([
      {
        model: SELFHOSTED_KOKORO,
        key: process.env.SELFHOSTED_API_KEY,
        body: expect.objectContaining({
          model: "kokoro",
          voice: "af_bella",
          input: "Hello.",
          response_format: "pcm",
        }),
      },
    ]);
  });

  it("fails over to another host of Kokoro, in the same voice, when the server fails", async () => {
    process.env.TOGETHER_API_KEY = "server-together";
    selfHostedFails = "500";
    const asked = await speak(SELFHOSTED_KOKORO);
    expect(asked.map((request) => [request.model, request.body.voice])).toEqual([
      [SELFHOSTED_KOKORO, "af_bella"],
      [TOGETHER_KOKORO, "af_bella"],
    ]);
  });

  it("leaves the default to another host while the server can't be reached", async () => {
    process.env.TOGETHER_API_KEY = "server-together";
    // A port nothing listens on.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    process.env.SELFHOSTED_BASE_URL = `http://127.0.0.1:${port}/v1`;

    const asked = await speak(null);
    expect(asked.map((request) => request.model)).toEqual([TOGETHER_KOKORO]);
  });

  it.each(["401", "302"] as const)(
    "refuses, without asking users for a key of their own, when the server's is refused (%s)",
    async (status) => {
      selfHostedFails = status;
      const refusal = speak(SELFHOSTED_KOKORO);
      await expect(refusal).rejects.toThrow(SpeechRejectedError);
      await expect(refusal).rejects.toThrow(/key was refused/);
      await expect(refusal).rejects.not.toThrow(/own|Settings/);
    }
  );

  it("sends the Cloudflare Access service token only when it's set", async () => {
    accessTokens.length = 0;
    await listSpeechModels({ plan: null });
    await speak(SELFHOSTED_KOKORO);
    // A new key, so the voices are fetched again rather than served from the catalog.
    process.env.SELFHOSTED_API_KEY = randomUUID();
    process.env.SELFHOSTED_CF_ACCESS_CLIENT_ID = "access-id";
    process.env.SELFHOSTED_CF_ACCESS_CLIENT_SECRET = "access-secret";
    await listSpeechModels({ plan: null });
    await speak(SELFHOSTED_KOKORO);
    const none = { id: undefined, secret: undefined };
    const token = { id: "access-id", secret: "access-secret" };
    expect(accessTokens).toEqual([none, none, token, token]);
  });

  it("refuses to start with half a Cloudflare Access service token", () => {
    expect(checkSelfHostedConfig).not.toThrow();
    process.env.SELFHOSTED_CF_ACCESS_CLIENT_ID = "access-id";
    expect(checkSelfHostedConfig).toThrow(/SELFHOSTED_CF_ACCESS_CLIENT_SECRET/);
  });

  it("refuses to start with a key but no server", () => {
    delete process.env.SELFHOSTED_BASE_URL;
    expect(checkSelfHostedConfig).toThrow(/SELFHOSTED_BASE_URL/);
  });
});
