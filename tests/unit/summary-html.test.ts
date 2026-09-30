// @vitest-environment jsdom
// The browser's own parser decides what the summary leaves open.
import { describe, it, expect } from "vitest";
import { sanitizeSummaryHtml } from "@/server/services/summarization";

/** Whether nothing the summary opens is still open after it. */
function closesEverything(html: string): boolean {
  const doc = new DOMParser().parseFromString(
    `<div id="s">${html}</div><p id="after">x</p>`,
    "text/html"
  );
  const after = doc.getElementById("after");
  return after?.parentElement === doc.body && !after.closest("b, a, table");
}

describe("sanitizeSummaryHtml", () => {
  it.each([
    ["an unclosed formatting element", "<p>Uses <b>bold"],
    ["an unclosed link", '<p>See <a href="https://example.com/">this'],
    ["an unclosed table", "<table><tr><td>cell"],
    ["an unclosed details inside a list", "<ul><li>two <details></li></ul>"],
  ])("closes %s", (_name, html) => {
    const summary = sanitizeSummaryHtml(html);
    expect(closesEverything(summary)).toBe(true);
  });

  it("still sanitizes", () => {
    const summary = sanitizeSummaryHtml('<p onclick="x()">Text</p><script>alert(1)</script>');
    expect(summary).toContain("Text");
    expect(summary).not.toContain("<script");
    expect(summary.toLowerCase()).not.toContain("onclick");
  });

  it("keeps well-formed summaries as they are", () => {
    expect(sanitizeSummaryHtml("<ul><li>One</li><li>Two</li></ul>")).toBe(
      "<ul><li>One</li><li>Two</li></ul>"
    );
  });
});
