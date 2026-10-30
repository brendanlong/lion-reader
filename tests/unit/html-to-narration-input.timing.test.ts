/** Wall-clock budgets for narrating hostile or very large markup. */

import { describe, it, expect } from "vitest";
import {
  htmlToNarrationInput,
  type HtmlToNarrationInputResult,
} from "../../src/lib/narration/html-to-narration-input";

function narrated(result: HtmlToNarrationInputResult): string[] {
  return result.paragraphs.map((paragraph) => paragraph.text);
}

describe("lists", () => {
  it("narrates thousands of blocks under a wrapper in reasonable time", () => {
    // Two questions are asked of a wrapper by every block inside it — which
    // of my blocks carries the marker, and does this figure say anything of
    // its own — and answering either one walks the wrapper. Unmemoized that
    // is quadratic: these took 1.4s and 1.3s, and 4× the blocks took 16×.
    // Both run in tens of milliseconds, so the bound has plenty of slack.
    for (const [html, first] of [
      [`<ul><li>${"<p>text here</p>".repeat(3000)}</li></ul>`, "- text here"],
      [`<figure>${"<p>text here</p>".repeat(3000)}</figure>`, "text here"],
    ] as const) {
      const started = performance.now();
      const result = htmlToNarrationInput(html);

      expect(performance.now() - started).toBeLessThan(500);
      expect(result.paragraphs).toHaveLength(3000);
      expect(result.paragraphs[0].text).toBe(first);
    }
  });
});

describe("markup nested too deep to parse", () => {
  const divsAround = (count: number, html: string) =>
    `${"<div>".repeat(count)}${html}${"</div>".repeat(count)}`;

  // #2039: each took 20 s to a minute to parse. The last two close every
  // element they open, so only the tree's depth (not the markup's) catches them.
  it.each([
    ["nested elements", divsAround(80_000, "<p>deep</p>")],
    ["end tags a browser ignores", "<span><div></span>".repeat(55_000)],
    ["misnested formatting", "<b><div></b>".repeat(80_000)],
  ])("cuts %s off quickly", (_, deep) => {
    const start = performance.now();
    expect(narrated(htmlToNarrationInput(`<p>before</p>${deep}<p>after</p>`))).toEqual(["before"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("parses content foster-parented out of a table in linear time", () => {
    // Each <div> is inserted before the open table, which parse5's own tree
    // adapter finds by scanning from its parent's first child.
    const time = (count: number) => {
      const start = performance.now();
      htmlToNarrationInput("<table>" + "<div>x</div>".repeat(count));
      return performance.now() - start;
    };
    time(40_000);
    // Linear is 4x; the default adapter's scan made it 8-16x.
    expect(time(160_000)).toBeLessThan(6 * time(40_000));
  });

  it("moves a misnested block's children at once", () => {
    // The adoption agency moves every <br> into a new <b>; one at a time
    // from the front, each move shifted all the rest.
    const html = `<p>before</p><b><div>${"<br>".repeat(120_000)}</b>after</div>`;
    const start = performance.now();
    expect(narrated(htmlToNarrationInput(html))).toEqual(["before", "after"]);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("br handling", () => {
  it("collapses a long whitespace run around breaks in linear time", () => {
    // `/\s*\u0000\s*/` rescanned the run from each of its positions: ~1s here.
    const gap = " ".repeat(40000);
    const html = `<p>Line one${gap}<br>${gap}<br>${gap}Line two${gap}x</p>`;
    const started = performance.now();
    const result = htmlToNarrationInput(html);

    expect(performance.now() - started).toBeLessThan(200);
    expect(narrated(result)).toEqual(["Line one", "Line two x"]);
    expect(result.paragraphs.map((p) => p.o)).toEqual([0, 0]);
  });
});
