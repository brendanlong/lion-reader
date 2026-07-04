// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  detectSwipeDirection,
  getViewportEdges,
  isSwipeNavigationAllowed,
  type ViewportEdges,
} from "@/components/entries/EntryContentHelpers";

describe("detectSwipeDirection", () => {
  it("detects a leftward swipe past the threshold", () => {
    expect(detectSwipeDirection({ x: 200, y: 0 }, { x: 100, y: 0 })).toBe("left");
  });

  it("detects a rightward swipe past the threshold", () => {
    expect(detectSwipeDirection({ x: 100, y: 0 }, { x: 200, y: 0 })).toBe("right");
  });

  it("ignores short horizontal movement below the threshold", () => {
    expect(detectSwipeDirection({ x: 100, y: 0 }, { x: 120, y: 0 })).toBeNull();
  });

  it("ignores mostly-vertical movement (scrolling)", () => {
    expect(detectSwipeDirection({ x: 100, y: 0 }, { x: 160, y: 100 })).toBeNull();
  });
});

describe("isSwipeNavigationAllowed", () => {
  const bothEdges: ViewportEdges = { atLeftEdge: true, atRightEdge: true };
  const leftOnly: ViewportEdges = { atLeftEdge: true, atRightEdge: false };
  const rightOnly: ViewportEdges = { atLeftEdge: false, atRightEdge: true };
  const neither: ViewportEdges = { atLeftEdge: false, atRightEdge: false };

  it("allows navigation in both directions when not zoomed (both edges)", () => {
    expect(isSwipeNavigationAllowed("left", bothEdges)).toBe(true);
    expect(isSwipeNavigationAllowed("right", bothEdges)).toBe(true);
  });

  it("allows swipe-left (next) only when panned to the right edge", () => {
    expect(isSwipeNavigationAllowed("left", rightOnly)).toBe(true);
    expect(isSwipeNavigationAllowed("left", leftOnly)).toBe(false);
  });

  it("allows swipe-right (previous) only when panned to the left edge", () => {
    expect(isSwipeNavigationAllowed("right", leftOnly)).toBe(true);
    expect(isSwipeNavigationAllowed("right", rightOnly)).toBe(false);
  });

  it("blocks navigation when panned to neither edge of a zoomed article", () => {
    expect(isSwipeNavigationAllowed("left", neither)).toBe(false);
    expect(isSwipeNavigationAllowed("right", neither)).toBe(false);
  });
});

describe("getViewportEdges", () => {
  const LAYOUT_WIDTH = 400;
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

  function setLayoutWidth(width: number) {
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: width,
    });
  }

  function setVisualViewport(vv: Partial<VisualViewport> | null) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: vv,
    });
  }

  afterEach(() => {
    if (originalVisualViewport) {
      Object.defineProperty(window, "visualViewport", originalVisualViewport);
    }
    // Drop the clientWidth override so jsdom's default getter is restored.
    delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
  });

  it("reports both edges when the visualViewport API is unavailable", () => {
    setVisualViewport(null);
    expect(getViewportEdges()).toEqual({ atLeftEdge: true, atRightEdge: true });
  });

  it("reports both edges when not zoomed (viewport fills layout)", () => {
    setLayoutWidth(LAYOUT_WIDTH);
    setVisualViewport({ offsetLeft: 0, width: LAYOUT_WIDTH });
    expect(getViewportEdges()).toEqual({ atLeftEdge: true, atRightEdge: true });
  });

  it("reports only the left edge when zoomed and panned fully left", () => {
    setLayoutWidth(LAYOUT_WIDTH);
    // Zoomed 2x: visual viewport is half as wide, panned to the left.
    setVisualViewport({ offsetLeft: 0, width: 200 });
    expect(getViewportEdges()).toEqual({ atLeftEdge: true, atRightEdge: false });
  });

  it("reports only the right edge when zoomed and panned fully right", () => {
    setLayoutWidth(LAYOUT_WIDTH);
    setVisualViewport({ offsetLeft: 200, width: 200 });
    expect(getViewportEdges()).toEqual({ atLeftEdge: false, atRightEdge: true });
  });

  it("reports neither edge when zoomed and panned to the middle", () => {
    setLayoutWidth(LAYOUT_WIDTH);
    setVisualViewport({ offsetLeft: 100, width: 200 });
    expect(getViewportEdges()).toEqual({
      atLeftEdge: false,
      atRightEdge: false,
    });
  });

  it("treats sub-pixel offsets within the epsilon as flush against an edge", () => {
    setLayoutWidth(LAYOUT_WIDTH);
    setVisualViewport({ offsetLeft: 0.5, width: LAYOUT_WIDTH - 0.5 });
    expect(getViewportEdges()).toEqual({ atLeftEdge: true, atRightEdge: true });
  });
});
