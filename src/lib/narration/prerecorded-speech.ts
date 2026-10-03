/**
 * Recorded narration, for where speech can't be synthesized on each request
 * (the public demo, which has no session to bill it to). Each chunk the cloud
 * player would ask the server for is recorded once, under a hash of
 * everything that shapes its audio, so a recording never goes stale: changed
 * text, or a different voice, is a different key that gets recorded anew.
 *
 * @module narration/prerecorded-speech
 */

import type { CloudVoice } from "./cloud-speech";

/** A cloud voice with nothing left to the server's defaults. */
export interface PrerecordedVoice extends CloudVoice {
  model: string;
  voice: string;
}

/** Bump to record everything again, e.g. after changing how speech is encoded. */
const RECORDING_FORMAT = 1;

const KEY_PATTERN = /^[0-9a-f]{64}$/;

export function isPrerecordedSpeechKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** The key `text` spoken in `voice` is stored under: a SHA-256, in hex. */
export async function prerecordedSpeechKey(voice: PrerecordedVoice, text: string): Promise<string> {
  const identity = JSON.stringify([
    RECORDING_FORMAT,
    voice.model,
    voice.voice,
    voice.pauseSeconds,
    text,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Where the browser fetches a recording from (`src/app/api/prerecorded-speech`):
 * through the CDN where there is one, which caches it.
 */
export function prerecordedSpeechUrl(key: string): string {
  const cdn = (process.env.NEXT_PUBLIC_ASSET_PREFIX ?? "").replace(/\/$/, "");
  return `${cdn}/api/prerecorded-speech/${key}`;
}

/** Where a recording is filed in object storage. */
export function prerecordedSpeechObjectKey(key: string): string {
  return `prerecorded-speech/${key}.mp4`;
}
