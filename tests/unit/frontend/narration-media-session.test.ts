/**
 * @vitest-environment jsdom
 */

/**
 * Integration tests for the Media Session wiring that surfaces native narration
 * controls in a PWA (issue #410).
 *
 * jsdom implements neither `navigator.mediaSession` nor `HTMLMediaElement.play()`,
 * so we stub those browser primitives (not internal code) and assert that the
 * module sets metadata, registers action handlers that dispatch to the provided
 * controls, mirrors playback state, and drives the silent audio element that
 * makes the OS controls appear.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";

interface StubMediaSession {
  metadata: unknown;
  playbackState: string;
  setActionHandler: Mock;
}

let mediaSession: StubMediaSession;
let actionHandlers: Record<string, (() => void) | null>;

beforeEach(() => {
  actionHandlers = {};
  mediaSession = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => {
      actionHandlers[action] = handler;
    }),
  };

  Object.defineProperty(navigator, "mediaSession", {
    value: mediaSession,
    configurable: true,
    writable: true,
  });

  // Minimal MediaMetadata stand-in (jsdom lacks it).
  (globalThis as unknown as { MediaMetadata: unknown }).MediaMetadata = class {
    constructor(init: unknown) {
      Object.assign(this, init);
    }
  };

  // jsdom's HTMLMediaElement.play/pause are unimplemented; stub them.
  vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadModule() {
  // Re-import per test so the silent-audio singleton is fresh.
  return await import("@/lib/narration/media-session");
}

function makeControls() {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    previousTrack: vi.fn(),
    nextTrack: vi.fn(),
  };
}

describe("setupMediaSession", () => {
  it("sets metadata and registers all action handlers", async () => {
    const { setupMediaSession } = await loadModule();
    const controls = makeControls();

    setupMediaSession(
      { articleTitle: "My Article", feedTitle: "My Feed", artwork: "https://x/icon.png" },
      controls
    );

    expect(mediaSession.metadata).toMatchObject({
      title: "My Article",
      artist: "My Feed",
      album: "Lion Reader",
    });
    for (const action of ["play", "pause", "stop", "previoustrack", "nexttrack"]) {
      expect(actionHandlers[action]).toBeTypeOf("function");
    }
  });

  it("dispatches OS media buttons to the provided controls", async () => {
    const { setupMediaSession } = await loadModule();
    const controls = makeControls();

    setupMediaSession({ articleTitle: "T", feedTitle: "F" }, controls);

    actionHandlers.play?.();
    actionHandlers.pause?.();
    actionHandlers.stop?.();
    actionHandlers.previoustrack?.();
    actionHandlers.nexttrack?.();

    expect(controls.play).toHaveBeenCalledTimes(1);
    expect(controls.pause).toHaveBeenCalledTimes(1);
    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(controls.previousTrack).toHaveBeenCalledTimes(1);
    expect(controls.nextTrack).toHaveBeenCalledTimes(1);
  });
});

describe("updateMediaSessionPlaybackState", () => {
  it("starts the silent audio and reports playing while active", async () => {
    const { updateMediaSessionPlaybackState } = await loadModule();

    updateMediaSessionPlaybackState("playing");

    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(mediaSession.playbackState).toBe("playing");
  });

  it("keeps the silent audio playing but reports paused when paused", async () => {
    const { updateMediaSessionPlaybackState } = await loadModule();

    updateMediaSessionPlaybackState("paused");

    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(window.HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(mediaSession.playbackState).toBe("paused");
  });

  it("stops the silent audio and clears state when idle", async () => {
    const { updateMediaSessionPlaybackState } = await loadModule();

    updateMediaSessionPlaybackState("playing");
    updateMediaSessionPlaybackState("idle");

    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(mediaSession.playbackState).toBe("none");
  });
});

describe("clearMediaSession", () => {
  it("tears down metadata, handlers, and the silent audio", async () => {
    const { setupMediaSession, updateMediaSessionPlaybackState, clearMediaSession } =
      await loadModule();
    const controls = makeControls();

    setupMediaSession({ articleTitle: "T", feedTitle: "F" }, controls);
    updateMediaSessionPlaybackState("playing");
    clearMediaSession();

    expect(mediaSession.metadata).toBeNull();
    expect(mediaSession.playbackState).toBe("none");
    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    for (const action of ["play", "pause", "stop", "previoustrack", "nexttrack"]) {
      expect(actionHandlers[action]).toBeNull();
    }
  });
});
