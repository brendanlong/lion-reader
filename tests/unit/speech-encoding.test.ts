import { describe, it, expect } from "vitest";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { ClipEdges, encodeSpeech, pcmFromWav, pcmOrWav } from "@/server/services/speech-encoding";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** `seconds` of a tone as 16-bit little-endian PCM. */
function tone(seconds: number, sampleRate: number, channels = 1): Uint8Array {
  const frames = Math.round(seconds * sampleRate);
  const view = new DataView(new ArrayBuffer(frames * channels * 2));
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((i / sampleRate) * 440 * 2 * Math.PI) * 8000);
    for (let c = 0; c < channels; c++) view.setInt16((i * channels + c) * 2, sample, true);
  }
  return new Uint8Array(view.buffer);
}

function wavHeader(sampleRate: number, channels: number, extraChunk = false): Uint8Array {
  const extra = extraChunk ? 8 + 3 + 1 : 0;
  const view = new DataView(new ArrayBuffer(44 + extra));
  const ascii = (at: number, text: string) =>
    [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 0xffffffff, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  let at = 36;
  if (extraChunk) {
    // An odd-sized chunk, padded to even, before the data.
    ascii(at, "LIST");
    view.setUint32(at + 4, 3, true);
    at += 12;
  }
  ascii(at, "data");
  view.setUint32(at + 4, 0xffffffff, true);
  return new Uint8Array(view.buffer);
}

describe("pcmFromWav", () => {
  it("reads the format from the header, however the header is split", async () => {
    const header = wavHeader(22_050, 2, true);
    const pcm = tone(0.1, 22_050, 2);
    const wav = streamOf(header.subarray(0, 5), header.subarray(5, 40), header.subarray(40), pcm);
    const result = await pcmFromWav(wav);
    expect(result.sampleRate).toBe(22_050);
    expect(result.channels).toBe(2);
    expect(await readAll(result.data)).toEqual(pcm);
  });

  it("refuses what isn't 16-bit PCM WAV", async () => {
    await expect(
      pcmFromWav(streamOf(new TextEncoder().encode("ID3\x04".repeat(10))))
    ).rejects.toThrow("isn't WAV");
    const float = wavHeader(24_000, 1);
    new DataView(float.buffer).setUint16(20, 3, true);
    await expect(pcmFromWav(streamOf(float))).rejects.toThrow("16-bit PCM");
    await expect(pcmFromWav(streamOf(wavHeader(24_000, 1).subarray(0, 30)))).rejects.toThrow(
      "ended"
    );
  });
});

describe("pcmOrWav", () => {
  it("takes bare PCM in the format given", async () => {
    const pcm = tone(0.1, 24_000);
    const result = await pcmOrWav(streamOf(pcm.subarray(0, 3), pcm.subarray(3)), {
      sampleRate: 24_000,
      channels: 1,
    });
    expect(result.sampleRate).toBe(24_000);
    expect(await readAll(result.data)).toEqual(pcm);
  });

  it("reads a WAV sent instead from its header", async () => {
    const pcm = tone(0.1, 22_050, 2);
    const result = await pcmOrWav(streamOf(wavHeader(22_050, 2), pcm), {
      sampleRate: 24_000,
      channels: 1,
    });
    expect([result.sampleRate, result.channels]).toEqual([22_050, 2]);
    expect(await readAll(result.data)).toEqual(pcm);
  });
});

describe("encodeSpeech", () => {
  it("is fragmented MP4 holding all of the audio as mono AAC", async () => {
    const pcm = tone(3, 24_000, 2);
    const pieces = Array.from({ length: Math.ceil(pcm.length / 4801) }, (_, i) =>
      pcm.subarray(i * 4801, (i + 1) * 4801)
    );
    const mp4 = await readAll(
      await encodeSpeech({ sampleRate: 24_000, channels: 2, data: streamOf(...pieces) })
    );
    expect(new TextDecoder().decode(mp4.subarray(4, 8))).toBe("ftyp");
    expect(new TextDecoder().decode(mp4)).toContain("moof");

    const input = new Input({ source: new BufferSource(mp4), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    expect(track?.codec).toBe("aac");
    expect(track?.numberOfChannels).toBe(1);
    expect(track?.sampleRate).toBe(24_000);
    // All of it: three seconds plus the encoder's priming and padding.
    const duration = await input.computeDuration();
    expect(duration).toBeGreaterThanOrEqual(3);
    expect(duration).toBeLessThan(3.3);
  });

  it("ends with the pause asked for", async () => {
    const mp4 = await readAll(
      await encodeSpeech(
        { sampleRate: 24_000, channels: 2, data: streamOf(tone(1, 24_000, 2)) },
        { pauseSeconds: 0.5 }
      )
    );
    const input = new Input({ source: new BufferSource(mp4), formats: ALL_FORMATS });
    const duration = await input.computeDuration();
    expect(duration).toBeGreaterThanOrEqual(1.5);
    expect(duration).toBeLessThan(1.8);
  });

  it("puts the first fragments out before the audio has all arrived", async () => {
    let more: ((chunk: Uint8Array | null) => void) | null = null;
    const data = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tone(2, 24_000));
        more = (chunk) => (chunk ? controller.enqueue(chunk) : controller.close());
      },
    });
    const reader = (await encodeSpeech({ sampleRate: 24_000, channels: 1, data })).getReader();
    let received = 0;
    while (received < 2) {
      const { done } = await reader.read();
      expect(done).toBe(false);
      received++;
    }
    more!(tone(1, 24_000));
    more!(null);
    while (!(await reader.read()).done);
  });

  it("fails before any audio for a provider that sends none", async () => {
    await expect(
      encodeSpeech({ sampleRate: 24_000, channels: 1, data: streamOf(new Uint8Array(0)) })
    ).rejects.toThrow("empty");
    // Not hidden by the pause that would follow it.
    await expect(
      encodeSpeech(
        { sampleRate: 24_000, channels: 1, data: streamOf(new Uint8Array(0)) },
        { pauseSeconds: 0.25 }
      )
    ).rejects.toThrow("empty");
    await expect(
      encodeSpeech({ sampleRate: 1_234, channels: 1, data: streamOf(tone(1, 24_000)) })
    ).rejects.toThrow();
  });

  it("stops reading the provider when the client goes away", async () => {
    let cancelled = false;
    const data = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tone(1, 24_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const audio = await encodeSpeech({ sampleRate: 24_000, channels: 1, data });
    await audio.cancel();
    await expect.poll(() => cancelled).toBe(true);
  });

  it("gives up on a client that stops reading, and stops reading the provider", async () => {
    let cancelled = false;
    const data = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(tone(1, 24_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const audio = await encodeSpeech(
      { sampleRate: 24_000, channels: 1, data },
      { deadlineMs: 200 }
    );
    // Never read: encoding blocks once the queue is full, until the deadline.
    await expect.poll(() => cancelled, { timeout: 2000 }).toBe(true);
    await expect(readAll(audio)).rejects.toThrow("too long");
  });

  it("cuts off a provider that sends far too much", async () => {
    // 15 minutes' worth at 8 kHz, in one-minute pieces, then one more.
    const minute = new Uint8Array(8_000 * 2 * 60);
    const data = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 16; i++) controller.enqueue(minute);
        controller.close();
      },
    });
    const audio = await encodeSpeech({ sampleRate: 8_000, channels: 1, data });
    await expect(readAll(audio)).rejects.toThrow("too long");
  });
});

describe("ClipEdges", () => {
  const rate = 24_000;
  const silence = (seconds: number, channels = 1) =>
    new Uint8Array(Math.round(seconds * rate) * 2 * channels);
  const cat = (...parts: Uint8Array[]) => {
    const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  };
  /** The clip through ClipEdges, fed in pieces of `size` bytes. */
  const through = (clip: Uint8Array, pauseSeconds: number, size = clip.length, channels = 1) => {
    const edges = new ClipEdges(rate, channels, pauseSeconds);
    const out: Uint8Array[] = [];
    for (let at = 0; at < clip.length; at += size)
      out.push(edges.push(clip.subarray(at, at + size)));
    out.push(edges.finish());
    return cat(...out);
  };
  const seconds = (bytes: Uint8Array, channels = 1) => bytes.length / 2 / channels / rate;
  /** Loud from its first sample to its last, unlike a tone, which starts at zero. */
  const sound = (duration: number, channels = 1) => {
    const view = new DataView(new ArrayBuffer(Math.round(duration * rate) * 2 * channels));
    for (let at = 0; at < view.byteLength; at += 2) view.setInt16(at, 8000, true);
    return new Uint8Array(view.buffer);
  };

  it("cuts the opening silence and makes the closing silence the pause", () => {
    const speech = sound(0.5);
    const out = through(cat(silence(0.4), speech, silence(0.7)), 1);
    expect(seconds(out)).toBeCloseTo(0.05 + 0.5 + 1, 3);
    // The speech is untouched, and everything after it is silent.
    const start = Math.round(0.05 * rate) * 2;
    expect(out.subarray(start, start + speech.length)).toEqual(speech);
    expect(out.subarray(start + speech.length).every((byte) => byte === 0)).toBe(true);
  });

  it("cuts a long closing silence back to the pause", () => {
    const out = through(cat(sound(0.5), silence(1.8)), 1);
    expect(seconds(out)).toBeCloseTo(1.5, 3);
  });

  it("keeps a word's decay even with no pause", () => {
    const out = through(cat(sound(0.5), silence(0.5)), 0);
    expect(seconds(out)).toBeCloseTo(0.55, 3);
  });

  it("keeps silence inside the speech whole, however the PCM arrives", () => {
    const clip = cat(silence(0.2), sound(0.3), silence(0.6), sound(0.3), silence(0.2));
    const whole = through(clip, 0.5);
    expect(seconds(whole)).toBeCloseTo(0.05 + 0.3 + 0.6 + 0.3 + 0.5, 3);
    for (const size of [1, 7, 4801]) expect(through(clip, 0.5, size)).toEqual(whole);
  });

  it("works in whole frames of every channel", () => {
    const clip = cat(silence(0.2, 2), sound(0.3, 2), silence(0.1, 2));
    const out = through(clip, 0.25, 3, 2);
    expect(seconds(out, 2)).toBeCloseTo(0.05 + 0.3 + 0.25, 3);
  });

  it("treats a noisy tail with a click in it as silence", () => {
    // Noise around RMS 60 with peaks to about 100, as models' tails measure, and one loud sample.
    const view = new DataView(new ArrayBuffer(Math.round(0.6 * rate) * 2));
    for (let at = 0; at < view.byteLength; at += 2) {
      view.setInt16(at, Math.round(Math.sin(at * 0.7) * 85), true);
    }
    view.setInt16(Math.round(0.4 * rate) * 2, 900, true);
    const out = through(cat(sound(0.5), new Uint8Array(view.buffer)), 0.25);
    expect(seconds(out)).toBeCloseTo(0.5 + 0.25, 3);
  });

  it("pads the whole pause after sound that runs to the last sample", () => {
    expect(seconds(through(sound(0.505), 1))).toBeCloseTo(0.505 + 1, 3);
  });

  it("keeps the decay's length even with a shorter pause", () => {
    expect(seconds(through(cat(sound(0.5), silence(0.5)), 0.02))).toBeCloseTo(0.55, 3);
  });

  it("is just the pause for a clip with no sound", () => {
    expect(seconds(through(silence(2), 1))).toBe(1);
  });
});
