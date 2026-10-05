// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
  interface Window {
    lionPosition?: { restore(element: number, offset: number): void };
  }
}

const SCRIPT = readFileSync("kmp/androidApp/src/main/assets/reader/reading-position.js", "utf8");

/** Page coordinates (top, height) of each numbered element; jsdom has no layout. */
let layout: [number, number][] = [];
let scrollY = 0;
const messages: { type: string; at: unknown }[] = [];

function place(elements: [number, number][]) {
  layout = elements;
  document.body.innerHTML = elements.map((_, i) => `<p data-para-id="para-${i}"></p>`).join("");
  document.querySelectorAll("[data-para-id]").forEach((el, i) => {
    el.getBoundingClientRect = () => {
      const [top, height] = layout[i];
      return new DOMRect(0, top - scrollY, 100, height);
    };
  });
}

async function scrollTo(y: number) {
  scrollY = y;
  document.dispatchEvent(new Event("scroll"));
  await vi.runAllTimersAsync();
}

beforeAll(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "scrollY", { get: () => scrollY });
  window.scrollTo = ((_x: number, y: number) => {
    scrollY = y;
  }) as typeof window.scrollTo;
  window.lionReader = { postMessage: (message) => messages.push(JSON.parse(message)) };
  new Function(SCRIPT)();
});

beforeEach(async () => {
  await scrollTo(0);
  messages.length = 0;
});

describe("the app reader's reading position", () => {
  it("reports the element at the top of the screen and how far through it", async () => {
    place([
      [0, 100],
      [100, 200],
      [300, 100],
    ]);
    await scrollTo(150);
    expect(messages.at(-1)).toEqual({ type: "position", at: { element: 1, offset: 0.25 } });
  });

  it("reports the innermost element across the top, not its container", async () => {
    // A blockquote (0) holding two paragraphs (1, 2).
    place([
      [0, 400],
      [0, 200],
      [200, 200],
    ]);
    await scrollTo(250);
    expect(messages.at(-1)?.at).toEqual({ element: 2, offset: 0.25 });
  });

  it("reports the element below a gap at the top", async () => {
    place([
      [0, 100],
      [200, 100],
    ]);
    await scrollTo(150);
    expect(messages.at(-1)?.at).toEqual({ element: 1, offset: -0.5 });
  });

  it("reports no place at the top of the page", async () => {
    place([[0, 100]]);
    await scrollTo(50);
    await scrollTo(0);
    expect(messages.at(-1)?.at).toBeNull();
  });

  it("restores a place in a reflowed page to the same point in its element", async () => {
    place([
      [0, 100],
      [100, 200],
    ]);
    await scrollTo(150);
    const { element, offset } = messages.at(-1)!.at as { element: number; offset: number };

    // Bigger text: everything is twice as tall.
    place([
      [0, 200],
      [200, 400],
    ]);
    scrollY = 0;
    window.lionPosition!.restore(element, offset);
    expect(scrollY).toBe(300);
  });
});
