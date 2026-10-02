/**
 * Type definitions for the native speech encoder (`native/speech-encoder/`).
 *
 * Hand-maintained to match the `#[napi]` exports in src/lib.rs — there is no
 * @napi-rs/cli codegen step. Keep them in sync; the loader's drift guard only
 * catches a missing export, not a wrong signature.
 */

/** Encodes one stream of 16-bit little-endian PCM to mono AAC-LC access units. */
export declare class SpeechEncoder {
  /** Throws for a rate AAC has no index for, or no channels. */
  constructor(sampleRate: number, channels: number, bitRate: number);
  /** The MPEG-4 AudioSpecificConfig, for the MP4 sample description. */
  readonly audioSpecificConfig: Buffer;
  /** Samples per access unit (1024). */
  readonly frameSamples: number;
  /** Silent samples the encoder puts before the audio (its priming), for the MP4 edit list. */
  readonly delaySamples: number;
  /** Encodes more interleaved PCM bytes (any length): the access units completed. */
  encode(pcm: Uint8Array): Buffer[];
  /** Encodes what's left and flushes the encoder: the final access units. Frees the encoder. */
  finish(): Buffer[];
  /**
   * Frees the encoder now. V8 doesn't see its native memory, so a wrapper can
   * wait a long time to be collected: call this when giving up on a stream.
   */
  close(): void;
}
