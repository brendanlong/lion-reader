import { describe, it, expect } from "vitest";
import type { PrerecordedChunk } from "@/server/services/demo-narration";
import {
  createPrerecordedSpeech,
  RecordingLostError,
  type PrerecordedSpeechSources,
} from "@/server/services/prerecorded-speech";

const KEY = "a".repeat(64);
const CHUNK: PrerecordedChunk = {
  voice: { model: "deepinfra:m", voice: "v", pauseSeconds: 0.6 },
  text: "Hello.",
};

function streamOf(...parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

async function text(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  return stream ? new Response(stream).text() : null;
}

/** A bucket and a voice in memory, counting what the voice is asked to say. */
function setup(overrides: Partial<PrerecordedSpeechSources> = {}) {
  const bucket = new Map<string, Uint8Array>();
  const synthesized: string[] = [];
  const sources: PrerecordedSpeechSources = {
    catalog: async () => new Map([[KEY, CHUNK]]),
    read: async (key) => {
      const bytes = bucket.get(key);
      return bytes ? streamOf(new TextDecoder().decode(bytes)) : null;
    },
    synthesize: async (chunk) => {
      synthesized.push(chunk.text);
      return streamOf("audio:", chunk.text);
    },
    store: async (key, audio) => {
      bucket.set(key, audio);
    },
    synthesizeUncached: false,
    ...overrides,
  };
  return {
    get: createPrerecordedSpeech(sources),
    bucket,
    synthesized,
  };
}

/** Lets the recording's background read and store run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("prerecorded speech", () => {
  it("serves only keys in the catalog", async () => {
    const { get, synthesized } = setup();
    expect(await get("b".repeat(64))).toBeNull();
    expect(synthesized).toEqual([]);
  });

  it("serves a stored recording without synthesizing", async () => {
    const { get, bucket, synthesized } = setup();
    bucket.set(KEY, new TextEncoder().encode("stored"));
    expect(await text(await get(KEY))).toBe("stored");
    expect(synthesized).toEqual([]);
  });

  it("records a missing chunk once, then serves the recording", async () => {
    const { get, bucket, synthesized } = setup();
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    await settle();
    expect(new TextDecoder().decode(bucket.get(KEY))).toBe("audio:Hello.");
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello."]);
  });

  it("synthesizes once for concurrent requests", async () => {
    const { get, synthesized } = setup();
    const [first, second] = await Promise.all([get(KEY), get(KEY)]);
    expect([await text(first), await text(second)]).toEqual(["audio:Hello.", "audio:Hello."]);
    expect(synthesized).toEqual(["Hello."]);
  });

  it("keeps the recording when the listener leaves early", async () => {
    const { get, bucket } = setup();
    await (await get(KEY))?.cancel();
    await settle();
    expect(new TextDecoder().decode(bucket.get(KEY))).toBe("audio:Hello.");
  });

  it("doesn't keep audio that stopped partway, and tries again", async () => {
    let attempts = 0;
    const { get, bucket, synthesized } = setup({
      synthesize: async (chunk) => {
        synthesized.push(chunk.text);
        attempts++;
        if (attempts > 1) return streamOf("audio:", chunk.text);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("audio:"));
            controller.error(new Error("connection dropped"));
          },
        });
      },
    });
    await expect(text(await get(KEY))).rejects.toThrow("connection dropped");
    await settle();
    expect(bucket.has(KEY)).toBe(false);
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello.", "Hello."]);
  });

  it("passes on a provider's refusal, and tries again next time", async () => {
    let refuse = true;
    const { get } = setup({
      synthesize: async (chunk) => {
        if (refuse) throw new Error("busy");
        return streamOf("audio:", chunk.text);
      },
    });
    await expect(get(KEY)).rejects.toThrow("busy");
    await settle();
    refuse = false;
    expect(await text(await get(KEY))).toBe("audio:Hello.");
  });

  it("serves a stored recording whatever the catalog says", async () => {
    const other = "c".repeat(64);
    const { get, bucket } = setup();
    bucket.set(other, new TextEncoder().encode("from another version"));
    expect(await text(await get(other))).toBe("from another version");
  });

  it("gives requests waiting on a recording that fails its failure, not new syntheses", async () => {
    let fail = true;
    const { get, synthesized } = setup({
      synthesize: async (chunk) => {
        synthesized.push(chunk.text);
        await settle();
        if (fail) throw new Error("busy");
        return streamOf("audio:", chunk.text);
      },
    });
    const results = await Promise.allSettled([get(KEY), get(KEY), get(KEY)]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(synthesized).toEqual(["Hello."]);
    fail = false;
    expect(await text(await get(KEY))).toBe("audio:Hello.");
  });

  it("serves a recording storage refused from memory, without paying again", async () => {
    const { get, synthesized } = setup({
      store: async () => {
        throw new Error("storage down");
      },
    });
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    await settle();
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello."]);
  });

  it("won't pay again soon for a recording storage lost", async () => {
    let time = 0;
    const { get, synthesized } = setup({
      // Stores, but reads somewhere else.
      store: async () => {},
      now: () => time,
    });
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    await settle();
    await expect(get(KEY)).rejects.toThrow(RecordingLostError);
    time += 2 * 60 * 60 * 1000;
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello.", "Hello."]);
  });

  it("without storage, synthesizes every play only when told to", async () => {
    const dev = setup({ store: null, synthesizeUncached: true });
    expect(await text(await dev.get(KEY))).toBe("audio:Hello.");
    expect(await text(await dev.get(KEY))).toBe("audio:Hello.");
    expect(dev.synthesized).toEqual(["Hello.", "Hello."]);

    const production = setup({ store: null, synthesizeUncached: false });
    expect(await production.get(KEY)).toBeNull();
    expect(production.synthesized).toEqual([]);
  });
});
