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
