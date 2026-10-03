/**
 * Recorded narration (`@/lib/narration/prerecorded-speech`), recorded on
 * demand: a chunk is synthesized the first time anyone asks for it and kept in
 * object storage, which serves it from then on. Only chunks in the catalog
 * (`./demo-narration`) can be asked for, so what this can ever spend is
 * bounded by the catalog: each chunk once, give or take two machines missing
 * the same one at the same moment.
 */

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
  /**
   * Synthesize every time when there's nowhere to store the result. For
   * development only: in production it would pay for every play.
   */
  synthesizeUncached: boolean;
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
  /** Recordings being made here, so concurrent requests for one share it. */
  const recording = new Map<string, Promise<Uint8Array>>();

  /** The recording this process is making of `key`, once made; null if none or it failed. */
  async function recordedHere(key: string): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await recording.get(key)?.catch(() => null);
    return bytes ? streamOf(bytes) : null;
  }

  async function record(
    key: string,
    chunk: PrerecordedChunk,
    store: NonNullable<PrerecordedSpeechSources["store"]>
  ): Promise<ReadableStream<Uint8Array>> {
    const streams = sources.synthesize(chunk).then((audio) => audio.tee());
    // Read to the end even if the listener leaves, so the chunk is kept; a
    // stream that fails partway isn't.
    const stored = streams.then(async ([, toStore]) => {
      const bytes = await new Response(toStore).bytes();
      await store(key, bytes);
      return bytes;
    });
    recording.set(key, stored);
    stored
      .catch((error: unknown) => {
        logger.warn("Couldn't record narration", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        // A failed recording's request may already have started another.
        if (recording.get(key) === stored) recording.delete(key);
      });
    const [toListener] = await streams;
    return toListener;
  }

  /** Recording `key`'s audio, or null if there's no such chunk (or way to get it). */
  return async function getPrerecordedSpeech(
    key: string
  ): Promise<ReadableStream<Uint8Array> | null> {
    const chunk = (await sources.catalog()).get(key);
    if (!chunk) return null;

    const recorded = await recordedHere(key);
    if (recorded) return recorded;
    const stored = await sources.read(key);
    if (stored) return stored;
    if (sources.store) {
      // Asked again, without awaiting first: a request for it may have
      // started recording while this one read the bucket.
      if (!recording.has(key)) return record(key, chunk, sources.store);
      return (await recordedHere(key)) ?? record(key, chunk, sources.store);
    }
    if (sources.synthesizeUncached) return sources.synthesize(chunk);
    return null;
  };
}
