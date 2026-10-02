/**
 * BreezeBlue cloud voices against a local stand-in for its API: each key's own
 * voices stay with that key, and speech streams through to fMP4.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { listSpeechModels, streamSpeech } from "../../src/server/services/speech";

let server: Server;
const speechRequests: Array<{ path: string; key: string; body: unknown }> = [];
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
    const json = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
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
    if (url.pathname.startsWith("/text-to-speech/")) {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        speechRequests.push({ path: req.url ?? "", key, body: JSON.parse(body) });
        res.writeHead(200, { "Content-Type": "audio/pcm" });
        // A quarter second of silence at 24 kHz mono.
        res.end(Buffer.alloc(24_000 / 2));
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
});
