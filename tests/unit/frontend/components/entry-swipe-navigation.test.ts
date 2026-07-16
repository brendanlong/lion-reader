// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  detectSwipeDirection,
  getScreenX,
  getViewportEdges,
  isEdgeGestureSwipe,
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

describe("isEdgeGestureSwipe", () => {
  const WIDTH = 400;

  it("flags a rightward swipe starting against the left screen edge (browser back gesture)", () => {
    expect(isEdgeGestureSwipe("right", 0, WIDTH)).toBe(true);
    expect(isEdgeGestureSwipe("right", 32, WIDTH)).toBe(true);
  });

  it("flags a leftward swipe starting against the right screen edge (browser forward gesture)", () => {
    expect(isEdgeGestureSwipe("left", WIDTH, WIDTH)).toBe(true);
    expect(isEdgeGestureSwipe("left", WIDTH - 32, WIDTH)).toBe(true);
  });

  it("allows swipes starting away from the screen edges", () => {
    expect(isEdgeGestureSwipe("right", 33, WIDTH)).toBe(false);
    expect(isEdgeGestureSwipe("left", WIDTH - 33, WIDTH)).toBe(false);
  });

  it("allows a swipe moving away from the edge it started against", () => {
    // Leftward swipe from the left edge / rightward from the right edge are
    // not system gestures.
    expect(isEdgeGestureSwipe("left", 10, WIDTH)).toBe(false);
    expect(isEdgeGestureSwipe("right", WIDTH - 10, WIDTH)).toBe(false);
  });

  it("never blocks when the viewport width is unknown", () => {
    expect(isEdgeGestureSwipe("right", 0, 0)).toBe(false);
    expect(isEdgeGestureSwipe("left", 0, 0)).toBe(false);
  });
});

describe("getScreenX", () => {
  const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

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
  });

  it("returns clientX unchanged when the visualViewport API is unavailable", () => {
    setVisualViewport(null);
    expect(getScreenX(100)).toBe(100);
  });

  it("returns clientX unchanged when not zoomed", () => {
    setVisualViewport({ offsetLeft: 0, scale: 1 });
    expect(getScreenX(100)).toBe(100);
  });

  it("magnifies layout distance by the zoom scale when panned to the left edge", () => {
    // Zoomed 2x, panned fully left: 10 layout px from the edge spans 20
    // physical px on screen.
    setVisualViewport({ offsetLeft: 0, scale: 2 });
    expect(getScreenX(10)).toBe(20);
  });

  it("subtracts the pan offset when zoomed and panned into the page", () => {
    // Zoomed 2x, panned to layout x=100: a touch at clientX=110 is 10 layout
    // px into the visual viewport = 20 physical px from the screen edge.
    setVisualViewport({ offsetLeft: 100, scale: 2 });
    expect(getScreenX(110)).toBe(20);
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
