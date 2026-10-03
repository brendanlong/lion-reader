/**
 * Recorded narration (`@/lib/narration/prerecorded-speech`), recorded on
 * demand: a chunk is synthesized the first time anyone asks for it and kept in
 * object storage, which serves it from then on. Only chunks in the catalog
 * (`./demo-narration`) are ever synthesized, and a process synthesizes a chunk
 * at most once per {@link RESYNTHESIS_INTERVAL_MS} however storage behaves, so
 * what this can spend is bounded by catalog × machines, and with storage
 * healthy is one recording of the demo.
 */

import { logger } from "@/lib/logger";
import type { PrerecordedChunk } from "@/server/services/demo-narration";

/**
 * How soon a process may synthesize again a chunk it already recorded: only
 * needed when storage loses it, or the bucket read isn't the one written.
 */
const RESYNTHESIS_INTERVAL_MS = 60 * 60 * 1000;

export interface PrerecordedSpeechSources {
  catalog: () => Promise<Map<string, PrerecordedChunk>>;
  /** The stored recording, or null if there's none (or no storage to read). */
  read: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  /** The chunk spoken; rejects as `streamSpeech` does. */
  synthesize: (chunk: PrerecordedChunk) => Promise<ReadableStream<Uint8Array>>;
  /** Stores a recording; null when there's no storage to write to. */
  store: ((key: string, audio: Uint8Array) => Promise<void>) | null;
  /**
   * Synthesize every time when there's nowhere to store the result. For
   * development only: in production it would pay for every play.
   */
  synthesizeUncached: boolean;
  now?: () => number;
}

/** A chunk this process recorded is missing from storage, and won't be paid for again yet. */
export class RecordingLostError extends Error {
  constructor(readonly key: string) {
    super(`Recorded narration ${key} is missing from storage`);
  }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Fetches recordings, recording missing ones as {@link PrerecordedSpeechSources} allow. */
export function createPrerecordedSpeech(sources: PrerecordedSpeechSources) {
  const now = sources.now ?? Date.now;
  /** Recordings being made here, so concurrent requests for one share it. */
  const recording = new Map<string, Promise<Uint8Array>>();
  /** When this process last recorded each chunk. */
  const recordedAt = new Map<string, number>();
  /** Recordings storage refused, served from here instead. At most the catalog. */
  const unstored = new Map<string, Uint8Array>();

  async function record(
    key: string,
    chunk: PrerecordedChunk,
    store: NonNullable<PrerecordedSpeechSources["store"]>
  ): Promise<ReadableStream<Uint8Array>> {
    const streams = sources.synthesize(chunk).then((audio) => audio.tee());
    // Read to the end even if the listener leaves, so the chunk is kept; a
    // stream that fails partway isn't.
    const recorded = streams.then(async ([, toStore]) => {
      const bytes = await new Response(toStore).bytes();
      recordedAt.set(key, now());
      try {
        await store(key, bytes);
      } catch (error) {
        unstored.set(key, bytes);
        logger.error("Couldn't store recorded narration; serving it from memory", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return bytes;
    });
    recording.set(key, recorded);
    recorded
      .catch((error: unknown) => {
        logger.warn("Couldn't record narration", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => recording.delete(key));
    const [toListener] = await streams;
    return toListener;
  }

  /**
   * `key`'s audio, or null if there's no such chunk (or way to get it).
   * Rejects with a synthesis's failure, which requests waiting on another's
   * recording get too, rather than each paying to try again.
   */
  return async function getPrerecordedSpeech(
    key: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    const inProgress = recording.get(key);
    if (inProgress) return streamOf(await inProgress);
    const kept = unstored.get(key);
    if (kept) return streamOf(kept);
    // Read before consulting the catalog, so a recording another version of
    // the catalog asked for (mid-deploy) is still served.
    const stored = await sources.read(key);
    if (stored) return stored;
    const chunk = (await sources.catalog()).get(key);
    if (!chunk) return null;

    if (sources.store) {
      // Without awaiting since: a request for it may have started recording
      // while this one read the bucket.
      const started = recording.get(key);
      if (started) return streamOf(await started);
      const last = recordedAt.get(key);
      if (last !== undefined && now() - last < RESYNTHESIS_INTERVAL_MS) {
        throw new RecordingLostError(key);
      }
      return record(key, chunk, sources.store);
    }
    if (sources.synthesizeUncached) return sources.synthesize(chunk);
    return null;
  };
}
