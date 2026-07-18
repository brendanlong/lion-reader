// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImagePrefetch } from "@/lib/hooks/useImagePrefetch";

/**
 * These tests cover the synchronous, pre-paint behavior: images already in the
 * viewport are flipped to eager + sync-decode so cached bytes paint without the
 * native lazy-loading flash. The IntersectionObserver path (below-the-fold
 * images) can't be exercised in jsdom — its stub never fires callbacks — so it's
 * verified via the Playwright demo instead.
 */

const VIEWPORT_HEIGHT = 768;

function makeImage(rect: { top: number; bottom: number }): HTMLImageElement {
  const img = document.createElement("img");
  img.setAttribute("loading", "lazy");
  img.src = "https://example.com/a.png";
  // jsdom returns all-zero rects; stub the geometry we care about.
  vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
    top: rect.top,
    bottom: rect.bottom,
    left: 0,
    right: 0,
    x: 0,
    y: rect.top,
    width: 0,
    height: rect.bottom - rect.top,
    toJSON: () => ({}),
  });
  return img;
}

function renderWithImages(images: HTMLImageElement[]) {
  const container = document.createElement("div");
  images.forEach((img) => container.appendChild(img));
  const containerRef = { current: container };
  renderHook(() => useImagePrefetch(containerRef, "some-content"));
  return container;
}

describe("useImagePrefetch", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("eager-loads and sync-decodes images already in the viewport", () => {
    const img = makeImage({ top: 100, bottom: 400 });
    renderWithImages([img]);

    expect(img.loading).toBe("eager");
    expect(img.decoding).toBe("sync");
  });

  it("leaves far-below-the-fold images lazy for the observer to upgrade", () => {
    // Well beyond the viewport + 50% margin (768 * 1.5 = 1152).
    const img = makeImage({ top: 5000, bottom: 5300 });
    renderWithImages([img]);

    // The hook sets the `loading`/`decoding` IDL properties; an untouched image
    // keeps its original `loading="lazy"` attribute and no sync-decode.
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.loading).not.toBe("eager");
    expect(img.decoding).not.toBe("sync");
  });

  it("does not sync-decode lazy images just below the viewport (leaves them to the observer)", () => {
    // Below the fold: no visible flash to prevent, so it must not be
    // eagerly sync-decoded — it's queued for the IntersectionObserver instead.
    const img = makeImage({ top: VIEWPORT_HEIGHT + 100, bottom: VIEWPORT_HEIGHT + 400 });
    renderWithImages([img]);

    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.decoding).not.toBe("sync");
  });

  it("sync-decodes an image straddling the bottom edge of the viewport", () => {
    // Partially visible (top on screen, bottom just past it) → still flashes.
    const img = makeImage({ top: VIEWPORT_HEIGHT - 50, bottom: VIEWPORT_HEIGHT + 300 });
    renderWithImages([img]);

    expect(img.loading).toBe("eager");
    expect(img.decoding).toBe("sync");
  });

  it("sync-decodes in-viewport images that were never lazy (e.g. demo content)", () => {
    // Demo article HTML is raw/unsanitized, so its images have no loading attr.
    const img = makeImage({ top: 100, bottom: 400 });
    img.removeAttribute("loading");
    renderWithImages([img]);

    expect(img.decoding).toBe("sync");
    expect(img.loading).toBe("eager");
  });

  it("leaves far-below-the-fold non-lazy images untouched", () => {
    const img = makeImage({ top: 5000, bottom: 5300 });
    img.removeAttribute("loading");
    renderWithImages([img]);

    expect(img.decoding).not.toBe("sync");
    expect(img.loading).not.toBe("eager");
  });

  it("hides the placeholder of a still-loading image, then reveals it on load", () => {
    const img = makeImage({ top: 100, bottom: 400 });
    // jsdom never loads images, so a src'd <img> stays incomplete.
    expect(img.complete).toBe(false);
    renderWithImages([img]);

    // Class present before the image loads → alt text/placeholder hidden.
    expect(img.classList.contains("content-img-loading")).toBe(true);

    img.dispatchEvent(new Event("load"));
    // Removed on load → the painted image shows.
    expect(img.classList.contains("content-img-loading")).toBe(false);
  });

  it("reveals the placeholder when a loading image errors", () => {
    const img = makeImage({ top: 100, bottom: 400 });
    renderWithImages([img]);

    expect(img.classList.contains("content-img-loading")).toBe(true);

    img.dispatchEvent(new Event("error"));
    // Removed on error → alt text reappears so a broken image stays meaningful.
    expect(img.classList.contains("content-img-loading")).toBe(false);
  });

  it("hides the placeholder of below-the-fold lazy images too", () => {
    // The placeholder-hiding applies to every still-loading image, not just
    // visible ones, so a lazy feed image doesn't flash its alt text if it
    // scrolls in before it finishes loading.
    const img = makeImage({ top: 5000, bottom: 5300 });
    renderWithImages([img]);

    // Still lazy (left for the observer to upgrade) but its placeholder is hidden.
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.classList.contains("content-img-loading")).toBe(true);
  });
});
