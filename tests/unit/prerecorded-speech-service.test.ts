import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrerecordedChunk } from "@/server/services/demo-narration";
import {
  createPrerecordedSpeech,
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

/** Lets a recording's background caching run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "prerecorded-speech-test-"));
});
afterEach(async () => {
  await chmod(join(root, "cache"), 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** A bucket and a voice in memory, counting what the voice is asked to say. */
function setup(overrides: Partial<PrerecordedSpeechSources> = {}) {
  const bucket = new Map<string, string>();
  const synthesized: string[] = [];
  const cacheDir = overrides.cacheDir ?? join(root, "cache");
  const sources: PrerecordedSpeechSources = {
    catalog: async () => new Map([[KEY, CHUNK]]),
    read: async (key) => {
      const stored = bucket.get(key);
      return stored === undefined ? null : streamOf(stored);
    },
    synthesize: async (chunk) => {
      synthesized.push(chunk.text);
      return streamOf("audio:", chunk.text);
    },
    store: async (key, audio) => {
      bucket.set(key, new TextDecoder().decode(audio));
    },
    cacheDir,
    ...overrides,
  };
  return { get: createPrerecordedSpeech(sources), bucket, synthesized, cacheDir };
}

// Permissions don't stop root, so a failing write can't be staged as root.
const canFailWrites = process.getuid?.() !== 0;

describe("prerecorded speech", () => {
  it("serves nothing, and synthesizes nothing, for a key not in the catalog", async () => {
    const { get, synthesized } = setup();
    expect(await get("b".repeat(64))).toBeNull();
    expect(synthesized).toEqual([]);
  });

  it("serves a recording from the bucket, then from disk", async () => {
    const { get, bucket, synthesized } = setup();
    bucket.set(KEY, "stored");
    expect(await text(await get(KEY))).toBe("stored");
    await settle();
    bucket.clear();
    expect(await text(await get(KEY))).toBe("stored");
    expect(synthesized).toEqual([]);
  });

  it("serves a recording in the bucket whatever the catalog says", async () => {
    const other = "c".repeat(64);
    const { get, bucket } = setup();
    bucket.set(other, "from another version");
    expect(await text(await get(other))).toBe("from another version");
  });

  it("records a missing chunk once, into the bucket and onto disk", async () => {
    const { get, bucket, synthesized } = setup();
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    await settle();
    expect(bucket.get(KEY)).toBe("audio:Hello.");
    bucket.clear();
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello."]);
  });

  it("synthesizes once for concurrent requests", async () => {
    const { get, synthesized } = setup();
    const results = await Promise.all([get(KEY), get(KEY), get(KEY)]);
    expect(await Promise.all(results.map(text))).toEqual([
      "audio:Hello.",
      "audio:Hello.",
      "audio:Hello.",
    ]);
    expect(synthesized).toEqual(["Hello."]);
  });

  it("keeps the recording when the listener leaves early", async () => {
    const { get, bucket, synthesized } = setup();
    await (await get(KEY))?.cancel();
    await settle();
    expect(bucket.get(KEY)).toBe("audio:Hello.");
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello."]);
  });

  it("keeps nothing of audio that stopped partway, and tries again", async () => {
    let attempts = 0;
    const { get, bucket, synthesized, cacheDir } = setup({
      synthesize: async (chunk) => {
        synthesized.push(chunk.text);
        if (++attempts > 1) return streamOf("audio:", chunk.text);
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
    expect(await readdir(cacheDir)).toEqual([]);
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    expect(synthesized).toEqual(["Hello.", "Hello."]);
  });

  it("gives requests waiting on a synthesis that fails its failure, not new syntheses", async () => {
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

  it("serves from disk what the bucket refused, without paying again", async () => {
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

  it("without a bucket, synthesizes once per disk cache", async () => {
    const first = setup({ read: async () => null, store: null });
    expect(await text(await first.get(KEY))).toBe("audio:Hello.");
    await settle();
    expect(await text(await first.get(KEY))).toBe("audio:Hello.");
    expect(first.synthesized).toEqual(["Hello."]);

    const restartedWithNewDisk = setup({
      read: async () => null,
      store: null,
      cacheDir: join(root, "next"),
    });
    expect(await text(await restartedWithNewDisk.get(KEY))).toBe("audio:Hello.");
    expect(restartedWithNewDisk.synthesized).toEqual(["Hello."]);
  });

  it("is off, synthesizing nothing, when the disk cache can't be set up", async () => {
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "");
    const { get, bucket, synthesized } = setup({ cacheDir: join(blocked, "cache") });
    bucket.set(KEY, "stored");
    expect(await get(KEY)).toBeNull();
    expect(synthesized).toEqual([]);
  });

  it.runIf(canFailWrites)("turns off when the disk cache fails a write", async () => {
    const { get, synthesized, cacheDir } = setup();
    await get("b".repeat(64)); // Waits out the probe.
    await chmod(cacheDir, 0o500);
    expect(await text(await get(KEY))).toBe("audio:Hello.");
    await settle();
    expect(await get(KEY)).toBeNull();
    expect(synthesized).toEqual(["Hello."]);
  });
});
