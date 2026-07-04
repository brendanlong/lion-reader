import { describe, expect, it } from "vitest";
import {
  detectSwipeDirection,
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
