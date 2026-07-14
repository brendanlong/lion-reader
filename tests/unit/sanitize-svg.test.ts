import { describe, it, expect } from "vitest";

import { extractInlineSvg, reinsertInlineSvg } from "@/server/html/sanitize-svg";

/** Convenience: extract + immediately reinsert, i.e. the full round-trip. */
function roundTrip(html: string): string {
  const extraction = extractInlineSvg(html);
  return reinsertInlineSvg(extraction.html, extraction);
}

describe("extractInlineSvg", () => {
  it("is a no-op when there is no <svg>", () => {
    const html = "<p>hello <b>world</b></p>";
    const extraction = extractInlineSvg(html);
    expect(extraction.html).toBe(html);
    expect(extraction.svgs).toHaveLength(0);
  });

  it("replaces the svg with an opaque placeholder that carries no markup", () => {
    const extraction = extractInlineSvg('<p>x</p><svg><circle r="1"/></svg>');
    expect(extraction.svgs).toHaveLength(1);
    // The placeholder left in the HTML must not contain angle brackets, so
    // sanitize-html treats it as inert text.
    const withoutPrefix = extraction.html.replace("<p>x</p>", "");
    expect(withoutPrefix).not.toContain("<");
    expect(withoutPrefix).not.toContain("svg");
  });

  it("round-trips a safe SVG, preserving camelCase attribute names", () => {
    const out = roundTrip(
      '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg">' +
        '<clipPath id="c"><rect width="10" height="10"/></clipPath>' +
        '<circle cx="5" cy="5" r="5" clip-path="url(#c)"/></svg>'
    );
    expect(out).toContain("viewBox=");
    expect(out).toContain("<clipPath");
    expect(out).not.toContain("viewbox=");
    expect(out).not.toContain("clippath");
  });

  it("drops disallowed elements with their whole subtree", () => {
    const out = roundTrip(
      '<svg><script>alert(1)</script><foreignObject><div>hi</div></foreignObject><circle r="1"/></svg>'
    );
    expect(out).not.toContain("script");
    expect(out.toLowerCase()).not.toContain("foreignobject");
    expect(out).not.toContain("<div>");
    expect(out).toContain("<circle");
  });

  it("strips event handlers and style attributes", () => {
    const out = roundTrip(
      '<svg onload="x()"><rect style="fill:red" onclick="y()" width="1" height="1"/></svg>'
    );
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("style");
  });

  it("preserves the byte-verbatim text between and around SVGs", () => {
    const extraction = extractInlineSvg(
      'A<svg><circle r="1"/></svg>B<svg><rect width="1" height="1"/></svg>C'
    );
    expect(extraction.nonce.startsWith("inlineph")).toBe(true);
    // The non-SVG text (A, B, C) must be untouched around the two placeholders.
    expect(extraction.html.startsWith("A")).toBe(true);
    expect(extraction.html).toContain("B");
    expect(extraction.html.endsWith("C")).toBe(true);
    expect(extraction.svgs).toHaveLength(2);
    expect(roundTrip('A<svg><circle r="1"/></svg>B')).toBe('A<svg><circle r="1"/></svg>B');
  });

  it("uses a fresh nonce each call (unforgeable placeholder)", () => {
    const a = extractInlineSvg('<svg><circle r="1"/></svg>');
    const b = extractInlineSvg('<svg><circle r="1"/></svg>');
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("handles nested <svg> as a single top-level subtree", () => {
    const extraction = extractInlineSvg('<svg><svg><circle r="1"/></svg></svg>');
    expect(extraction.svgs).toHaveLength(1);
    expect(extraction.svgs[0]).toContain("<circle");
  });
});

describe("reinsertInlineSvg", () => {
  it("substitutes each placeholder with its sanitized SVG", () => {
    const extraction = extractInlineSvg('<div><svg><circle r="1"/></svg></div>');
    // Simulate sanitize-html having kept the placeholder text inside the div.
    const sanitizedShell = extraction.html;
    const final = reinsertInlineSvg(sanitizedShell, extraction);
    expect(final).toBe('<div><svg><circle r="1"/></svg></div>');
  });

  it("is a no-op when there were no SVGs", () => {
    const extraction = extractInlineSvg("<p>x</p>");
    expect(reinsertInlineSvg("<p>x</p>", extraction)).toBe("<p>x</p>");
  });
});
