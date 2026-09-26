/**
 * StreamingAudioPlayer seeking, driven with fake audio primitives: generated
 * "buffers" carry the text they were made from so playback order is visible.
 */

import { describe, it, expect, vi } from "vitest";
import {
  StreamingAudioPlayer,
  type PlaybackPosition,
} from "@/lib/narration/streaming-audio-player";

type FakeBuffer = AudioBuffer & { text: string };

function createPlayer() {
  const played: string[] = [];
  const positions: PlaybackPosition[] = [];
  const pausePlayback = vi.fn();
  const resumePlayback = vi.fn();

  const player = new StreamingAudioPlayer(
    async (text) => ({ text, duration: 1 }) as unknown as FakeBuffer,
    (buffer) => played.push((buffer as FakeBuffer).text),
    vi.fn(),
    pausePlayback,
    resumePlayback,
    () => ({}) as AudioContext
  );
  player.setConfig({ voiceId: "voice", rate: 1, sentenceGapSeconds: 0 });
  player.setCallbacks({
    onPositionChange: (position) => positions.push(position),
  });
  player.load(["One.", "Two.", "Three."]);

  return { player, played, positions, resumePlayback };
}

describe("StreamingAudioPlayer.skipTo", () => {
  it("plays from the start of the chosen paragraph", async () => {
    const { player, played, positions } = createPlayer();
    await player.play();

    await player.skipTo(2);

    expect(played.at(-1)).toBe("Three.");
    expect(positions.at(-1)).toEqual({ paragraph: 2, sentence: 0 });
    expect(player.getStatus()).toBe("playing");
  });

  it("starts playing when paused, instead of resuming the old paragraph", async () => {
    const { player, played, resumePlayback } = createPlayer();
    await player.play();
    player.pause();

    await player.skipTo(1);

    expect(player.getStatus()).toBe("playing");
    expect(played.at(-1)).toBe("Two.");
    expect(resumePlayback).not.toHaveBeenCalled();
  });

  it("clamps out-of-range paragraphs", async () => {
    const { player, played } = createPlayer();
    await player.play();

    await player.skipTo(10);
    expect(played.at(-1)).toBe("Three.");

    await player.skipTo(-3);
    expect(played.at(-1)).toBe("One.");
  });
});
