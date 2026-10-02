/**
 * How much of an MP4's audio its edit list says to skip: the encoder's priming
 * at the start of an AAC track (cloud speech: see
 * `src/server/services/speech-encoding.ts`).
 *
 * @module narration/mp4-priming
 */

const CONTAINERS = new Set(["moov", "trak", "mdia", "edts"]);

interface Found {
  mediaTime?: number;
  timescale?: number;
}

function walk(bytes: Uint8Array, view: DataView, from: number, to: number, found: Found): void {
  for (let at = from; at + 8 <= to;) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const end = size === 0 ? to : at + size;
    // A box that goes past what's arrived is skipped: its fields may be missing.
    if (size < 8 || end > to) return;
    const version = bytes[at + 8];
    if (type === "elst" && found.mediaTime === undefined && view.getUint32(at + 12) > 0) {
      // One entry: segment_duration then media_time, 32-bit (v0) or 64-bit (v1).
      found.mediaTime = version === 1 ? Number(view.getBigInt64(at + 24)) : view.getInt32(at + 20);
    } else if (type === "mdhd" && found.timescale === undefined) {
      found.timescale = view.getUint32(at + (version === 1 ? 28 : 20));
    } else if (CONTAINERS.has(type)) {
      walk(bytes, view, at + 8, end, found);
    }
    at = end;
  }
}

/**
 * Seconds of audio to skip at the start of the MP4 that `bytes` starts with
 * (its init segment, at least), from the edit list: 0 without one.
 */
export function mp4PrimingSeconds(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Found = {};
  walk(bytes, view, 0, bytes.length, found);
  const { mediaTime, timescale } = found;
  return mediaTime !== undefined && mediaTime > 0 && timescale ? mediaTime / timescale : 0;
}
