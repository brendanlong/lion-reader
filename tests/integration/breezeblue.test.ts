/**
 * BreezeBlue cloud voices against a local stand-in for its API: each key's own
 * voices stay with that key, and speech streams through to fMP4.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { eq } from "drizzle-orm";
import {
  listSpeechModels,
  SpeechRejectedError,
  streamSpeech,
} from "../../src/server/services/speech";
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";
import { POST as speechPost } from "../../src/app/api/v1/narration/speech/route";
import { createSession } from "../../src/server/auth/session";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createTestUser } from "./helpers";

let server: Server;
const speechRequests: Array<{ path: string; key: string; body: unknown }> = [];
const voiceLookups: string[] = [];
/** Speech requests to turn away as busy before answering. */
let busyAnswers = 0;
const previousBaseUrl = process.env.BREEZEBLUE_BASE_URL;
const previousServerKey = process.env.BREEZEBLUE_API_KEY;

const voice = (id: string, name: string) => ({
  voice_id: id,
  name,
  accent: "american",
  gender: "female",
  age: "middle_aged",
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = String(req.headers["xi-api-key"] ?? "");
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (key.startsWith("refused-")) return json({ detail: "Invalid API key" }, 401);
    if (url.pathname.startsWith("/voices/")) {
      voiceLookups.push(url.pathname);
      const id = decodeURIComponent(url.pathname.slice("/voices/".length));
      // Any voice of the library, like one that has left the trending list.
      if (id.startsWith("library-")) return json(voice(id, "From the library"));
      return json({ detail: "Voice not found" }, 404);
    }
    if (url.pathname === "/models") {
      return json([{ model_id: "breeze-tts-2", name: "Breeze TTS 2" }]);
    }
    if (url.pathname === "/voices") {
      if (url.searchParams.get("favorites_only") === "true") {
        return json({
          voices: [
            voice(`fav-${key}`, `Favorite of ${key}`),
            { ...voice(`fav-narrator-${key}`, "Narrator"), primary_category_code: "narration" },
          ],
        });
      }
      if (url.searchParams.get("voice_type") === "personal") {
        return json({ voices: [voice(`mine-${key}`, `Made by ${key}`)] });
      }
      // An account sees voices it saved under its own alias.
      return json({ voices: [voice("trending", `Elara, as ${key} calls her`)] });
    }
    if (url.pathname.startsWith("/text-to-speech/") && busyAnswers > 0) {
      busyAnswers--;
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0" });
      res.end(JSON.stringify({ detail: "Your plan's concurrent generation limit was reached." }));
      return;
    }
    if (url.pathname.startsWith("/text-to-speech/") && key.startsWith("broke-")) {
      return json({ detail: "Insufficient credits" }, 402);
    }
    if (url.pathname.startsWith("/text-to-speech/library-cut-off/")) {
      // Some audio, then the connection drops.
      res.writeHead(200, { "Content-Type": "audio/pcm" });
      const speech = Buffer.alloc(24_000 * 2);
      for (let at = 0; at < speech.length; at += 2) speech.writeInt16LE(8000, at);
      res.write(speech, () => setTimeout(() => res.destroy(), 200));
      return;
    }
    if (url.pathname.startsWith("/text-to-speech/")) {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        speechRequests.push({ path: req.url ?? "", key, body: JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "audio/pcm" });
        // A quarter second of sound at 24 kHz mono.
        const speech = Buffer.alloc(24_000 / 2);
        for (let at = 0; at < speech.length; at += 2) speech.writeInt16LE(8000, at);
        res.end(speech);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.BREEZEBLUE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.BREEZEBLUE_API_KEY;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (previousBaseUrl === undefined) delete process.env.BREEZEBLUE_BASE_URL;
  else process.env.BREEZEBLUE_BASE_URL = previousBaseUrl;
  if (previousServerKey !== undefined) process.env.BREEZEBLUE_API_KEY = previousServerKey;
});

async function breezeBlueVoices(key: string): Promise<Array<{ id: string; name: string }>> {
  const { models } = await listSpeechModels({ breezeblue: key });
  const model = models.find((candidate) => candidate.id === "breezeblue:breeze-tts-2");
  if (!model) throw new Error("No BreezeBlue model");
  return model.voices;
}

describe("BreezeBlue voices", () => {
  it("lists the key's own voices first, narrators leading, then trending ones", async () => {
    const key = randomUUID();
    expect(await breezeBlueVoices(key)).toEqual([
      { id: `fav-narrator-${key}`, name: "Narrator (American, female, middle aged)" },
      { id: `fav-${key}`, name: `Favorite of ${key} (American, female, middle aged)` },
      { id: `mine-${key}`, name: `Made by ${key} (American, female, middle aged)` },
      { id: "trending", name: `Elara, as ${key} calls her (American, female, middle aged)` },
    ]);
  });

  it("never shows one key's view of the catalog to another", async () => {
    const first = randomUUID();
    const second = randomUUID();
    await breezeBlueVoices(first);

    const names = (await breezeBlueVoices(second)).map((v) => v.name).join("\n");
    expect(names).toContain(second);
    expect(names).not.toContain(first);
  });

  it("keeps offering a picked voice that has left the list, while the key has it", async () => {
    const key = randomUUID();
    const picked = `library-${randomUUID()}`;
    const list = async (voice: string) => {
      const { models } = await listSpeechModels(
        { breezeblue: key },
        { model: "breezeblue:breeze-tts-2", voice }
      );
      return models[0].voices;
    };

    expect((await list(picked)).at(-1)).toEqual({
      id: picked,
      name: "From the library (American, female, middle aged)",
    });
    await list(picked);
    expect(voiceLookups.filter((path) => path === `/voices/${picked}`)).toHaveLength(1);

    expect((await list("deleted")).map((voice) => voice.id)).not.toContain("deleted");
    // One it lists anyway isn't looked up.
    await list("trending");
    expect(voiceLookups).not.toContain("/voices/trending");
  });
});

describe("BreezeBlue speech", () => {
  it("streams the chosen voice as fragmented MP4", async () => {
    const key = randomUUID();
    const stream = await streamSpeech(
      { breezeblue: key },
      { model: "breezeblue:breeze-tts-2", voice: `fav-${key}`, text: "Hello." }
    );
    const audio = Buffer.from(await new Response(stream).arrayBuffer());

    expect(audio.subarray(4, 8).toString()).toBe("ftyp");
    expect(speechRequests.at(-1)).toEqual({
      path: `/text-to-speech/fav-${key}/stream?output_format=pcm&enable_logging=false`,
      key,
      body: { text: "Hello.", model_id: "breeze-tts-2" },
    });
  });

  it("ends with the pause asked for", async () => {
    const key = randomUUID();
    const duration = async (pauseSeconds: number) => {
      const stream = await streamSpeech(
        { breezeblue: key },
        { model: "breezeblue:breeze-tts-2", voice: null, text: "Hello.", pauseSeconds }
      );
      const audio = new Uint8Array(await new Response(stream).arrayBuffer());
      return new Input({ source: new BufferSource(audio), formats: ALL_FORMATS }).computeDuration();
    };

    // The stand-in speaks a quarter second.
    expect(await duration(0)).toBeLessThan(0.5);
    const paused = await duration(1);
    expect(paused).toBeGreaterThanOrEqual(1.25);
    expect(paused).toBeLessThan(1.5);
  });

  it("waits out BreezeBlue being busy", async () => {
    busyAnswers = 2;
    const before = speechRequests.length;
    const stream = await streamSpeech(
      { breezeblue: randomUUID() },
      { model: "breezeblue:breeze-tts-2", voice: null, text: "Busy." }
    );
    const audio = Buffer.from(await new Response(stream).arrayBuffer());
    expect(audio.subarray(4, 8).toString()).toBe("ftyp");
    expect(busyAnswers).toBe(0);
    expect(speechRequests.length).toBe(before + 1);
  });

  it("speaks a picked voice that has left the list", async () => {
    const picked = `library-${randomUUID()}`;
    const stream = await streamSpeech(
      { breezeblue: randomUUID() },
      { model: "breezeblue:breeze-tts-2", voice: picked, text: "Hi." }
    );
    await new Response(stream).arrayBuffer();
    expect(speechRequests.at(-1)?.path).toContain(`/text-to-speech/${picked}/`);
  });

  it("says why BreezeBlue refused the user's own key", async () => {
    const speak = (key: string) =>
      streamSpeech(
        { breezeblue: key },
        { model: "breezeblue:breeze-tts-2", voice: null, text: "Hi." }
      );
    await expect(speak(`broke-${randomUUID()}`)).rejects.toThrow(
      new SpeechRejectedError("BreezeBlue refused the request: Insufficient credits")
    );
    await expect(speak(`refused-${randomUUID()}`)).rejects.toThrow(
      new SpeechRejectedError("BreezeBlue refused the request: Invalid API key")
    );
  });

  it("errors the audio, rather than ending it, when BreezeBlue stops partway", async () => {
    const stream = await streamSpeech(
      { breezeblue: randomUUID() },
      { model: "breezeblue:breeze-tts-2", voice: "library-cut-off", text: "Hi." }
    );
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
  });
});

describe("the speech route", () => {
  const savedKeys = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const name of Object.values(AI_PROVIDER_ENV_KEYS)) {
      savedKeys.set(name, process.env[name]);
      delete process.env[name];
    }
  });
  afterAll(() => {
    for (const [name, value] of savedKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("answers the server's key being refused with a 422 that keeps the reason private", async () => {
    process.env.BREEZEBLUE_API_KEY = `refused-${randomUUID()}`;
    const userId = await createTestUser({ emailPrefix: "breezeblue" });
    try {
      const { token } = await createSession(db, { userId });
      const res = await speechPost(
        new Request("http://localhost:3000/api/v1/narration/speech", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `session=${token}` },
          body: JSON.stringify({ model: null, voice: null, text: "Hi." }),
        })
      );
      expect(res.status).toBe(422);
      expect((await res.json()).message).toBe("BreezeBlue cloud voices aren't available right now");
    } finally {
      delete process.env.BREEZEBLUE_API_KEY;
      await db.delete(users).where(eq(users.id, userId));
    }
  });
});
