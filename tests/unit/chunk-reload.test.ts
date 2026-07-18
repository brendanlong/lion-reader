/**
 * Unit tests for the blocking <head> ChunkLoadError recovery script.
 *
 * The script is a hand-written string that runs before the bundle loads (so it
 * can catch a chunk failing to load during hydration). These tests execute the
 * actual generated script against a fake `window` and drive its registered
 * `error` / `unhandledrejection` listeners, asserting it reloads exactly once
 * per window on a chunk error and never on unrelated errors.
 */

import { describe, it, expect } from "vitest";
import {
  buildChunkReloadScript,
  RELOAD_TIMESTAMP_KEY,
  RELOAD_WINDOW_MS,
} from "../../src/lib/chunk-reload";

type Listener = (event: unknown) => void;

interface FakeWindow {
  listeners: Record<string, Listener[]>;
  addEventListener: (type: string, fn: Listener) => void;
  sessionStorage: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
  };
  location: { reload: () => void };
  reloadCount: number;
  store: Map<string, string>;
}

function makeWindow(): FakeWindow {
  const store = new Map<string, string>();
  const listeners: Record<string, Listener[]> = {};
  const win: FakeWindow = {
    listeners,
    store,
    reloadCount: 0,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k, v) => {
        store.set(k, v);
      },
    },
    location: {
      reload() {
        win.reloadCount += 1;
      },
    },
  };
  return win;
}

/** Install the script's listeners onto a fresh fake window. */
function install(): FakeWindow {
  const win = makeWindow();
  // The script is an IIFE referencing `window` (and the global `Date`); shadow
  // `window` with our fake so we can drive its listeners.
  const fn = new Function("window", buildChunkReloadScript());
  fn(win);
  return win;
}

/** Dispatch to every listener registered for `type`. */
function dispatch(win: FakeWindow, type: string, event: unknown): void {
  for (const fn of win.listeners[type] ?? []) fn(event);
}

function chunkError(): Error {
  const err = new Error("Loading chunk 3241 failed.\n(error: /_next/static/chunks/3241-abc.js)");
  err.name = "ChunkLoadError";
  return err;
}

describe("buildChunkReloadScript", () => {
  it("registers error and unhandledrejection listeners", () => {
    const win = install();
    expect(win.listeners["error"]?.length).toBe(1);
    expect(win.listeners["unhandledrejection"]?.length).toBe(1);
  });

  it("reloads on a ChunkLoadError surfaced via the error event", () => {
    const win = install();
    dispatch(win, "error", { error: chunkError() });
    expect(win.reloadCount).toBe(1);
    expect(win.store.get(RELOAD_TIMESTAMP_KEY)).toBeTruthy();
  });

  it("reloads on a ChunkLoadError surfaced via unhandledrejection", () => {
    const win = install();
    dispatch(win, "unhandledrejection", { reason: chunkError() });
    expect(win.reloadCount).toBe(1);
  });

  it("detects a chunk error by message even without the ChunkLoadError name", () => {
    const win = install();
    dispatch(win, "error", { error: new Error("Loading CSS chunk 42 failed.") });
    expect(win.reloadCount).toBe(1);
  });

  it("does not reload on unrelated errors", () => {
    const win = install();
    dispatch(win, "error", { error: new TypeError("x is not a function") });
    dispatch(win, "unhandledrejection", { reason: new Error("Failed to fetch") });
    dispatch(win, "error", { error: null });
    dispatch(win, "error", {});
    expect(win.reloadCount).toBe(0);
  });

  it("reloads at most once within the guard window (no reload loop)", () => {
    const win = install();
    dispatch(win, "error", { error: chunkError() });
    dispatch(win, "error", { error: chunkError() });
    dispatch(win, "unhandledrejection", { reason: chunkError() });
    expect(win.reloadCount).toBe(1);
  });

  it("recovers again once the guard window has elapsed (later deploy mid-session)", () => {
    const win = install();
    // Simulate a prior reload that happened longer ago than the guard window.
    win.store.set(RELOAD_TIMESTAMP_KEY, String(Date.now() - RELOAD_WINDOW_MS - 1));
    dispatch(win, "error", { error: chunkError() });
    expect(win.reloadCount).toBe(1);
  });

  it("does not reload when sessionStorage is unavailable (no unguarded loop)", () => {
    // Private mode / disabled storage: the guard can't be persisted, so we must
    // skip the reload rather than reload unguarded and risk an infinite loop.
    const win = makeWindow();
    win.sessionStorage.getItem = () => {
      throw new Error("SecurityError: storage disabled");
    };
    win.sessionStorage.setItem = () => {
      throw new Error("SecurityError: storage disabled");
    };
    new Function("window", buildChunkReloadScript())(win);
    dispatch(win, "error", { error: chunkError() });
    dispatch(win, "unhandledrejection", { reason: chunkError() });
    expect(win.reloadCount).toBe(0);
  });
});
