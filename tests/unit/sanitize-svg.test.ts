import { describe, it, expect } from "vitest";

import { sanitizeEntryHtml } from "@/server/html/sanitize";

/**
 * Inline-SVG sanitization now lives in the native sanitizer
 * (native/sanitizer/core/src/svg.rs) and runs inside `sanitizeEntryHtml`
 * (extract → sanitize → placeholder → main pass → reinsert). These tests
 * exercise the pipeline end-to-end; the extraction/placeholder internals are
 * covered by the Rust unit tests.
 */
function sanitize(html: string): string {
  return sanitizeEntryHtml(html) ?? "";
}

describe("inline SVG through sanitizeEntryHtml", () => {
  it("is a no-op when there is no <svg>", () => {
    const html = "<p>hello <b>world</b></p>";
    expect(sanitize(html)).toBe(html);
  });

  it("round-trips a safe SVG, preserving camelCase attribute names", () => {
    const out = sanitize(
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
    const out = sanitize(
      '<svg><script>alert(1)</script><foreignObject><div>hi</div></foreignObject><circle r="1"/></svg>'
    );
    expect(out).not.toContain("script");
    expect(out.toLowerCase()).not.toContain("foreignobject");
    expect(out).not.toContain("<div>");
    expect(out).toContain("<circle");
  });

  it("strips event handlers and style attributes", () => {
    const out = sanitize(
      '<svg onload="x()"><rect style="fill:red" onclick="y()" width="1" height="1"/></svg>'
    );
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("style");
  });

  it("preserves the byte-verbatim text between and around SVGs", () => {
    const out = sanitize('A<svg><circle r="1"/></svg>B<svg><rect width="1" height="1"/></svg>C');
    // SVG subtrees are re-serialized with attributes in sorted order (the
    // parse loses source order); the surrounding text is byte-verbatim.
    expect(out).toBe('A<svg><circle r="1"/></svg>B<svg><rect height="1" width="1"/></svg>C');
  });

  it("does not let feed content forge a placeholder token", () => {
    // A feed guessing the placeholder shape gets inert text, never SVG —
    // the nonce is random per call.
    const guess = "inlineph000000000000000000000000";
    const out = sanitize(`<p>${guess}0${guess}</p><svg><circle r="1"/></svg>`);
    expect(out).toContain(`<p>${guess}0${guess}</p>`);
    expect(out).toContain("<circle");
  });

  it("handles nested <svg> as a single top-level subtree", () => {
    const out = sanitize('<svg><svg><circle r="1"/></svg></svg>');
    expect(out).toContain("<circle");
  });

  it("substituted SVG survives inside surrounding sanitized HTML", () => {
    const out = sanitize('<div onclick="x"><svg><circle r="1"/></svg></div>');
    expect(out).toBe('<div><svg><circle r="1"/></svg></div>');
  });
});
