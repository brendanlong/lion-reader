/**
 * Recorded narration (`@/lib/narration/prerecorded-speech`), recorded on
 * demand. Every request takes the same path: the machine's disk cache, else
 * object storage, else (for chunks in the catalog, `./demo-narration`)
 * synthesis; whatever it fetched or synthesized is written to the disk cache,
 * and a synthesis to object storage too, for every process after this one.
 *
 * The disk cache is what bounds the spending: whatever object storage does, a
 * machine synthesizes each chunk in the catalog at most once while its disk
 * lasts (on Fly, until it restarts). So the disk is checked before anything
 * is served, and if it ever fails a write, recorded narration is off for this
 * process. Processes may share the directory: files are content-addressed and
 * written atomically.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/lib/logger";
import type { PrerecordedChunk } from "@/server/services/demo-narration";

export interface PrerecordedSpeechSources {
  catalog: () => Promise<Map<string, PrerecordedChunk>>;
  /** The stored recording, or null if there's none (or no storage to read). */
  read: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  /** The chunk spoken; rejects as `streamSpeech` does. */
  synthesize: (chunk: PrerecordedChunk) => Promise<ReadableStream<Uint8Array>>;
  /** Stores a recording; null when there's no storage to write to. */
  store: ((key: string, audio: Uint8Array) => Promise<void>) | null;
  /** The disk cache's directory. */
  cacheDir: string;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Written whole or not at all: a file is only ever served complete. */
async function writeAtomically(path: string, data: Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Whether the cache directory can be written and read back. */
async function probe(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Named for this probe alone: other processes may be probing the directory.
  const path = join(dir, `probe-${randomUUID()}`);
  const written = new TextEncoder().encode("probe");
  await writeAtomically(path, written);
  const read = await readFile(path);
  await rm(path);
  if (!Buffer.from(read).equals(written)) throw new Error("Read back what wasn't written");
}

/**
 * Gets recordings as described above. Resolves to null for a key that isn't
 * recorded and can't be (not in the catalog), or when recorded narration is
 * off; rejects with a synthesis's failure, which requests waiting on the same
 * chunk get too, rather than each paying to try again.
 */
export function createPrerecordedSpeech(sources: PrerecordedSpeechSources) {
  const { cacheDir } = sources;
  let disabled = false;
  const ready = probe(cacheDir).catch((error: unknown) => {
    disabled = true;
    logger.error("Recorded narration is off: its disk cache doesn't work", {
      cacheDir,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  /** Chunks being fetched or synthesized, so concurrent requests share one. */
  const filling = new Map<string, Promise<Uint8Array | null>>();

  async function fetchOrSynthesize(
    key: string
  ): Promise<{ audio: ReadableStream<Uint8Array>; synthesized: boolean } | null> {
    // Read before consulting the catalog, so a recording another version of
    // the catalog asked for (mid-deploy) is still served.
    const stored = await sources.read(key);
    if (stored) return { audio: stored, synthesized: false };
    const chunk = (await sources.catalog()).get(key);
    if (!chunk) return null;
    return { audio: await sources.synthesize(chunk), synthesized: true };
  }

  async function cache(key: string, bytes: Uint8Array, synthesized: boolean): Promise<void> {
    try {
      await writeAtomically(join(cacheDir, key), bytes);
    } catch (error) {
      disabled = true;
      logger.error("Recorded narration is off: its disk cache failed a write", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    if (synthesized && sources.store) {
      await sources.store(key, bytes).catch((error: unknown) => {
        logger.error("Couldn't store recorded narration", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /** Fetches or synthesizes `key`, streaming it to the caller while caching it. */
  async function fill(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const source = fetchOrSynthesize(key).then(
      (found) => found && { synthesized: found.synthesized, branches: found.audio.tee() }
    );
    // Read to the end even if the listener leaves, so the chunk is kept; a
    // stream that fails partway isn't.
    const filled = source.then(async (found) => {
      if (!found) return null;
      const bytes = await new Response(found.branches[1]).bytes();
      await cache(key, bytes, found.synthesized);
      return bytes;
    });
    filling.set(key, filled);
    filled
      .catch((error: unknown) => {
        logger.warn("Couldn't get recorded narration", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => filling.delete(key));
    return (await source)?.branches[0] ?? null;
  }

  async function filledElsewhere(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await filling.get(key);
    return bytes ? streamOf(bytes) : null;
  }

  return async function getPrerecordedSpeech(
    key: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    await ready;
    if (disabled) return null;
    if (filling.has(key)) return filledElsewhere(key);
    const cached = await readIfPresent(join(cacheDir, key));
    if (cached) return streamOf(cached);
    // Asked again without awaiting since: a request for it may have started
    // filling while this one read the disk.
    if (filling.has(key)) return filledElsewhere(key);
    return fill(key);
  };
}
