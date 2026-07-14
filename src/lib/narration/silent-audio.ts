/**
 * Silent looping audio for the Media Session API.
 *
 * The Media Session API (`navigator.mediaSession`) only surfaces OS-level media
 * controls — the lock-screen / notification widget, and hardware/Bluetooth
 * play-pause buttons — while the browser believes an `HTMLMediaElement` is
 * actively playing. Lion Reader's narration plays through the Web Speech API
 * (`speechSynthesis`) or the Web Audio API (Piper TTS via `AudioBufferSourceNode`),
 * neither of which registers as media playback. Without a real media element,
 * setting `mediaSession.metadata` and action handlers has no visible effect: the
 * notification never appears and Bluetooth buttons aren't routed to us.
 *
 * The standard workaround is to play a silent, looping audio element alongside
 * the narration. That element is what the browser treats as "the media", so the
 * OS controls appear and the media-key/Bluetooth events flow into our action
 * handlers. This module owns generating that silent clip and the element.
 *
 * The clip is generated at runtime as a tiny silent WAV data URI so we don't ship
 * a binary asset. It loops, so it can be very short.
 *
 * @module narration/silent-audio
 */

/** Sample rate for the generated silent clip. Low rate keeps the clip tiny. */
const SILENT_SAMPLE_RATE = 8000;

/** Duration of the generated silent clip in seconds. It loops, so this is short. */
const SILENT_DURATION_SECONDS = 0.5;

/**
 * Generates the bytes of a mono, 8-bit PCM WAV file containing pure silence.
 *
 * 8-bit PCM samples are unsigned, so the silence value is 128 (0x80), not 0.
 * This is a pure function so the WAV structure can be unit-tested without a DOM.
 *
 * @param durationSeconds - Length of the clip
 * @param sampleRate - Samples per second
 * @returns A `Uint8Array` containing a complete WAV file
 */
export function createSilentWavBytes(
  durationSeconds: number = SILENT_DURATION_SECONDS,
  sampleRate: number = SILENT_SAMPLE_RATE
): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 8;
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.max(1, Math.floor(durationSeconds * sampleRate));
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  // RIFF header
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // chunk size
  writeAscii(8, "WAVE");

  // fmt subchunk
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // subchunk1 size (PCM)
  view.setUint16(20, 1, true); // audio format (1 = PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  // Fill samples with 8-bit silence (unsigned midpoint = 128).
  const bytes = new Uint8Array(buffer);
  bytes.fill(128, 44);

  return bytes;
}

/**
 * Encodes the silent WAV as a `data:` URI usable as an `<audio>` element `src`.
 */
export function createSilentAudioDataUri(): string {
  const bytes = createSilentWavBytes();
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = typeof btoa === "function" ? btoa(binary) : "";
  return `data:audio/wav;base64,${base64}`;
}

/**
 * Lazily-created singleton silent audio element. Shared across narrations since
 * only one narration plays at a time.
 */
let silentAudio: HTMLAudioElement | null = null;

/**
 * Gets (creating if needed) the shared silent, looping audio element.
 *
 * Returns null when there is no DOM (SSR) or `Audio` is unavailable.
 */
function getSilentAudioElement(): HTMLAudioElement | null {
  if (typeof document === "undefined" || typeof Audio === "undefined") {
    return null;
  }
  if (!silentAudio) {
    silentAudio = new Audio(createSilentAudioDataUri());
    silentAudio.loop = true;
    // Keep the volume audible-but-silent (the clip itself is silent); muting can
    // cause some browsers to ignore the element for Media Session purposes.
    silentAudio.volume = 1;
    silentAudio.preload = "auto";
  }
  return silentAudio;
}

/**
 * Starts the silent loop, activating the OS media session.
 *
 * Must be reachable from a user gesture (or sticky activation) so autoplay
 * policies allow playback; the returned promise rejection is swallowed so a
 * blocked autoplay degrades gracefully (no controls) rather than throwing.
 */
export function startSilentAudio(): void {
  const audio = getSilentAudioElement();
  if (!audio) return;
  const playResult = audio.play();
  if (playResult && typeof playResult.catch === "function") {
    playResult.catch(() => {
      // Autoplay blocked (e.g. no user activation). Media controls simply won't
      // appear; narration itself is unaffected.
    });
  }
}

/**
 * Stops the silent loop and releases it, deactivating the OS media session.
 */
export function stopSilentAudio(): void {
  if (!silentAudio) return;
  silentAudio.pause();
  silentAudio.currentTime = 0;
}
