/**
 * Cloud-voice audio as every client plays it: AAC in fragmented MP4, encoded
 * here from the provider's PCM as it streams in, a fragment about every half
 * second. One format for all of them: it's the only one every Media Source
 * Extensions implementation takes (iOS's `ManagedMediaSource` refuses MP3),
 * the web appends the bytes as they arrive without decoding anything, and
 * ExoPlayer plays it while it's still arriving.
 *
 * Encoding is native (`@lion-reader/speech-encoder`, Fraunhofer FDK AAC): a
 * WASM encoder cost ~150 MB of resident memory on 512 MB machines. Mediabunny
 * only puts the encoded frames in MP4.
 */

import { SpeechEncoder } from "@lion-reader/speech-encoder";
import type * as Mediabunny from "mediabunny";

/** Raw speech as a provider streams it: signed 16-bit little-endian, interleaved. */
export interface PcmStream {
  sampleRate: number;
  channels: number;
  data: ReadableStream<Uint8Array>;
}

/** Plenty for mono speech. */
const BITRATE = 48_000;
/** Longest audio one chunk may be: ~15 minutes, where a 1000-character chunk is about one. */
const MAX_SECONDS = 15 * 60;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

/**
 * The PCM in a WAV stream, from its header: the `fmt ` chunk's format and
 * everything after the `data` chunk's header. Sizes in the header are ignored,
 * since a streamed WAV can't know them yet. Only 16-bit PCM.
 */
export async function pcmFromWav(body: ReadableStream<Uint8Array>): Promise<PcmStream> {
  const reader = body.getReader();
  let head: Uint8Array = new Uint8Array(0);
  let format: { sampleRate: number; channels: number } | null = null;
  let offset = 12;
  try {
    for (;;) {
      while (head.length < offset + 8) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Speech audio ended before its data");
        head = concat(head, value);
      }
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      if (offset === 12) {
        const riff = new TextDecoder().decode(head.subarray(0, 4));
        const wave = new TextDecoder().decode(head.subarray(8, 12));
        if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Speech audio isn't WAV");
      }
      const id = new TextDecoder().decode(head.subarray(offset, offset + 4));
      const size = view.getUint32(offset + 4, true);
      if (id === "data") {
        if (!format) throw new Error("Speech audio has no format");
        const rest = head.subarray(offset + 8);
        return { ...format, data: prepend(rest, reader) };
      }
      if (id === "fmt ") {
        while (head.length < offset + 8 + 16) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Speech audio ended in its header");
          head = concat(head, value);
        }
        const fmt = new DataView(head.buffer, head.byteOffset + offset + 8, 16);
        const audioFormat = fmt.getUint16(0, true);
        const bitsPerSample = fmt.getUint16(14, true);
        if (audioFormat !== 1 || bitsPerSample !== 16) {
          throw new Error("Speech audio isn't 16-bit PCM");
        }
        format = { channels: fmt.getUint16(2, true), sampleRate: fmt.getUint32(4, true) };
      }
      // Chunks are padded to an even size.
      offset += 8 + size + (size % 2);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
}

/**
 * `data`, asked for as bare PCM in `format`: unless it's a WAV after all (some
 * models ignore the format asked for), whose header then says what it is.
 */
export async function pcmOrWav(
  data: ReadableStream<Uint8Array>,
  format: { sampleRate: number; channels: number }
): Promise<PcmStream> {
  const reader = data.getReader();
  let head: Uint8Array = new Uint8Array(0);
  while (head.length < 4) {
    const { done, value } = await reader.read();
    if (done) break;
    head = concat(head, value);
  }
  const rest = prepend(head, reader);
  return new TextDecoder().decode(head.subarray(0, 4)) === "RIFF"
    ? pcmFromWav(rest)
    : { ...format, data: rest };
}

/** `first`, then the rest of `reader`. */
function prepend(
  first: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> {
  let pending: Uint8Array | null = first.length > 0 ? first : null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Longest a whole stream may take, provider and client together: past this a
 * client that stopped reading (and so blocks the encoder on backpressure)
 * can't hold an encoder and a provider connection open.
 */
const STREAM_DEADLINE_MS = 3 * 60 * 1000;
/** Fragments queued for a client before encoding waits for it to read. */
const QUEUED_FRAGMENTS = 8;

/**
 * `pcm` as AAC in fragmented MP4, streamed: fragments come out while the PCM
 * is still arriving. Resolves once the first audio has arrived, so a provider
 * that fails before sending any is still an ordinary error; failures after
 * that error the stream. Cancelling the result, an error, or the deadline
 * stops reading the provider and frees the encoder at once.
 */
export async function encodeSpeech(
  pcm: PcmStream,
  deadlineMs = STREAM_DEADLINE_MS
): Promise<ReadableStream<Uint8Array>> {
  const reader = pcm.data.getReader();
  const maxBytes = MAX_SECONDS * pcm.sampleRate * 2 * pcm.channels;

  let encoder: SpeechEncoder | null = null;
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    encoder = new SpeechEncoder(pcm.sampleRate, pcm.channels, BITRATE);
    do {
      first = await reader.read();
    } while (!first.done && first.value.length === 0);
    if (first.done) throw new Error("Speech audio was empty");
  } catch (error) {
    encoder?.close();
    await reader.cancel().catch(() => {});
    throw error;
  }
  const speech = encoder;

  // A plain stream rather than a TransformStream: backpressure is ours to
  // wait on, so stopping can always interrupt it.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let failure: unknown = null;
  let wake: (() => void) | null = null;
  const audio = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c;
      },
      pull: () => {
        wake?.();
        wake = null;
      },
      cancel: (reason) => stop(reason ?? new Error("Speech stream cancelled"), false),
    },
    new CountQueuingStrategy({ highWaterMark: QUEUED_FRAGMENTS })
  );
  const deadline = setTimeout(
    () => stop(new Error("Speech stream took too long"), true),
    deadlineMs
  );

  const mb = await import("mediabunny");
  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 0.5 }),
    target: new mb.StreamTarget(
      new WritableStream<Mediabunny.StreamTargetChunk>({
        write: async (chunk) => {
          if (failure) throw failure;
          controller.enqueue(chunk.data);
          while (!failure && (controller.desiredSize ?? 0) <= 0) {
            await new Promise<void>((resolve) => (wake = resolve));
          }
          if (failure) throw failure;
        },
      })
    ),
  });

  function stop(error: unknown, tellClient: boolean) {
    if (failure) return;
    failure = error;
    clearTimeout(deadline);
    wake?.();
    wake = null;
    speech.close();
    void reader.cancel().catch(() => {});
    void output.cancel().catch(() => {});
    if (tellClient) controller.error(error);
  }

  const source = new mb.EncodedAudioPacketSource("aac");
  output.addAudioTrack(source);

  const frameSeconds = speech.frameSamples / pcm.sampleRate;
  let frames = 0;
  const add = async (units: Buffer[]) => {
    for (const unit of units) {
      const packet = new mb.EncodedPacket(unit, "key", frames * frameSeconds, frameSeconds);
      await source.add(
        packet,
        frames === 0
          ? {
              decoderConfig: {
                codec: "mp4a.40.2",
                sampleRate: pcm.sampleRate,
                numberOfChannels: 1,
                description: speech.audioSpecificConfig,
              },
            }
          : undefined
      );
      frames++;
    }
  };

  const encode = async () => {
    await output.start();
    let total = 0;
    let next: ReadableStreamReadResult<Uint8Array> = first;
    while (!next.done) {
      total += next.value.length;
      if (total > maxBytes) throw new Error("Speech audio too long");
      await add(speech.encode(next.value));
      next = await reader.read();
    }
    await add(speech.finish());
    await output.finalize();
    if (failure) return;
    clearTimeout(deadline);
    controller.close();
  };

  encode().catch((error: unknown) => stop(error, true));

  return audio;
}
