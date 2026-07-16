// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSwipeGesture } from "@/lib/hooks/useSwipeGesture";

type Point = { clientX: number; clientY: number };

function touchEvent(touches: Point[], changedTouches: Point[] = touches) {
  return { touches, changedTouches } as unknown as React.TouchEvent;
}

const LEFT = 200;
const RIGHT = 50; // moving from x=200 to x=50 is a leftward swipe past threshold

describe("useSwipeGesture", () => {
  // Force the un-zoomed default (both edges) so these tests exercise the
  // multi-touch lifecycle, not the zoom edge-gating (covered elsewhere).
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
  beforeEach(() => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: null,
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(window, "visualViewport", original);
  });

  function setup() {
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const { result } = renderHook(() => useSwipeGesture({ onSwipeLeft, onSwipeRight }));
    return { onSwipeLeft, onSwipeRight, handlers: result.current };
  }

  it("fires onSwipeLeft for a single-finger leftward swipe", () => {
    const { onSwipeLeft, handlers } = setup();
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: RIGHT, clientY: 0 }]));
    expect(onSwipeLeft).toHaveBeenCalledOnce();
  });

  it("does not navigate when a second finger joins (pinch-zoom)", () => {
    const { onSwipeLeft, onSwipeRight, handlers } = setup();
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    // Second finger down → multi-touch.
    handlers.onTouchStart(
      touchEvent([
        { clientX: LEFT, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ])
    );
    // One finger lifts (other remains): still multi-touch, no navigation.
    handlers.onTouchEnd(
      touchEvent([{ clientX: 100, clientY: 0 }], [{ clientX: RIGHT, clientY: 0 }])
    );
    // Last finger lifts.
    handlers.onTouchEnd(touchEvent([], [{ clientX: 100, clientY: 0 }]));
    expect(onSwipeLeft).not.toHaveBeenCalled();
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("recovers on the next single-finger swipe after a pinch", () => {
    const { onSwipeLeft, handlers } = setup();
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    handlers.onTouchStart(
      touchEvent([
        { clientX: LEFT, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ])
    );
    handlers.onTouchEnd(touchEvent([], [{ clientX: 100, clientY: 0 }]));
    expect(onSwipeLeft).not.toHaveBeenCalled();

    // Fresh single-finger swipe should work again.
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: RIGHT, clientY: 0 }]));
    expect(onSwipeLeft).toHaveBeenCalledOnce();
  });

  it("clears the multi-touch flag on touchcancel so the next swipe works", () => {
    const { onSwipeLeft, handlers } = setup();
    // Pinch begins, then the browser hijacks it with touchcancel (no touchend).
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    handlers.onTouchStart(
      touchEvent([
        { clientX: LEFT, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ])
    );
    handlers.onTouchCancel?.(touchEvent([]));

    // Next single-finger swipe navigates.
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: RIGHT, clientY: 0 }]));
    expect(onSwipeLeft).toHaveBeenCalledOnce();
  });

  it("ignores a rightward swipe starting at the left screen edge (browser back gesture)", () => {
    const { onSwipeRight, handlers } = setup();
    // jsdom's window.innerWidth defaults to 1024; x=10 is inside the edge zone.
    handlers.onTouchStart(touchEvent([{ clientX: 10, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: 150, clientY: 0 }]));
    expect(onSwipeRight).not.toHaveBeenCalled();
  });

  it("ignores a leftward swipe starting at the right screen edge (browser forward gesture)", () => {
    const { onSwipeLeft, handlers } = setup();
    handlers.onTouchStart(touchEvent([{ clientX: window.innerWidth - 10, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: window.innerWidth - 150, clientY: 0 }]));
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });

  // The edge-gesture zone is physical: 32 *screen* px, however far that is in
  // layout px under pinch-zoom. Both tests zoom 2x panned fully left, where
  // zoom edge-gating (isSwipeNavigationAllowed) permits a rightward swipe.
  function setupZoomed2xAtLeftEdge() {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: { offsetLeft: 0, width: 200, scale: 2 },
    });
    return () => {
      delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
    };
  }

  it("blocks a zoomed swipe starting inside the physical edge zone (OS back gesture)", () => {
    const restore = setupZoomed2xAtLeftEdge();
    try {
      const { onSwipeRight, handlers } = setup();
      // clientX=10 is 20 physical px from the screen edge — inside the zone.
      handlers.onTouchStart(touchEvent([{ clientX: 10, clientY: 0 }]));
      handlers.onTouchEnd(touchEvent([], [{ clientX: 150, clientY: 0 }]));
      expect(onSwipeRight).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("allows a zoomed swipe outside the physical zone even within 32 layout px", () => {
    const restore = setupZoomed2xAtLeftEdge();
    try {
      const { onSwipeRight, handlers } = setup();
      // clientX=20 is only 20 layout px from the edge, but 40 physical px —
      // outside the OS gesture zone, so this legitimate zoomed "previous
      // article" swipe must not be blocked.
      handlers.onTouchStart(touchEvent([{ clientX: 20, clientY: 0 }]));
      handlers.onTouchEnd(touchEvent([], [{ clientX: 150, clientY: 0 }]));
      expect(onSwipeRight).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("fires onSwipeRight for a rightward swipe starting away from the edge", () => {
    const { onSwipeRight, handlers } = setup();
    handlers.onTouchStart(touchEvent([{ clientX: RIGHT, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: LEFT, clientY: 0 }]));
    expect(onSwipeRight).toHaveBeenCalledOnce();
  });

  it("keeps the flag set on touchcancel while a finger remains down", () => {
    const { onSwipeLeft, handlers } = setup();
    handlers.onTouchStart(touchEvent([{ clientX: LEFT, clientY: 0 }]));
    handlers.onTouchStart(
      touchEvent([
        { clientX: LEFT, clientY: 0 },
        { clientX: 100, clientY: 0 },
      ])
    );
    // touchcancel with one finger still down must NOT reset the flag.
    handlers.onTouchCancel?.(touchEvent([{ clientX: 100, clientY: 0 }]));
    handlers.onTouchEnd(touchEvent([], [{ clientX: RIGHT, clientY: 0 }]));
    expect(onSwipeLeft).not.toHaveBeenCalled();
  });
});
