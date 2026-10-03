/**
 * Recorded narration (`@/lib/narration/prerecorded-speech`), recorded on
 * demand. Every request takes the same path: the machine's disk cache, else
 * object storage, else (for chunks in the catalog, `./demo-narration`)
 * synthesis; whatever it fetched or synthesized is written to the disk cache,
 * and a synthesis to object storage too, for every process after this one.
 *
 * The disk cache is what bounds the spending: whatever object storage does, a
 * machine synthesizes each chunk in the catalog once while its disk lasts (on
 * Fly, until it restarts), plus whatever syntheses fail partway. So the disk
 * is checked before anything is served, and a failed write turns recorded
 * narration off for a while, longer each time it fails again
 * ({@link DISK_FAILURE_FIRST_PAUSE_MS}). Processes may share the directory:
 * files are content-addressed and written atomically.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@/lib/logger";
import type { PrerecordedChunk } from "@/server/services/demo-narration";

const DISK_FAILURE_FIRST_PAUSE_MS = 60 * 1000;
const DISK_FAILURE_MAX_PAUSE_MS = 24 * 60 * 60 * 1000;

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
  now?: () => number;
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
    // Not there, or the directory isn't (which the next write reports).
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Written whole or not at all: a file is only ever served complete. The
 * directory is made as needed, so it may be removed at any time.
 */
async function writeAtomically(dir: string, name: string, data: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Gets recordings as described above. Resolves to null for a key that isn't
 * recorded and can't be (not in the catalog), or while recorded narration is
 * off; rejects with a synthesis's failure, which requests waiting on the same
 * chunk get too, rather than each paying to try again.
 */
export function createPrerecordedSpeech(sources: PrerecordedSpeechSources) {
  const { cacheDir } = sources;
  const now = sources.now ?? Date.now;
  /** Disk writes failed in a row, and when recorded narration is back on. */
  let diskFailures = 0;
  let offUntil = 0;
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
      await writeAtomically(cacheDir, key, bytes);
      diskFailures = 0;
    } catch (error) {
      const pauseMs = Math.min(
        DISK_FAILURE_FIRST_PAUSE_MS * 2 ** diskFailures,
        DISK_FAILURE_MAX_PAUSE_MS
      );
      diskFailures++;
      offUntil = now() + pauseMs;
      logger.error("Recorded narration is off for a while: its disk cache failed a write", {
        key,
        pauseSeconds: pauseMs / 1000,
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
    if (now() < offUntil) return null;
    if (filling.has(key)) return filledElsewhere(key);
    const cached = await readIfPresent(join(cacheDir, key));
    if (cached) return streamOf(cached);
    // Asked again without awaiting since: a request for it may have started
    // filling while this one read the disk.
    if (filling.has(key)) return filledElsewhere(key);
    return fill(key);
  };
}
