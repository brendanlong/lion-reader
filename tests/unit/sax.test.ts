import { describe, it, expect } from "vitest";
import { createSaxParser, MAX_SAX_DEPTH } from "@/server/html/sax";
import { stripHtml } from "@/server/html/strip-html";
import { generateSummary } from "@/server/html/summary";

function nested(tag: string, depth: number, text: string): string {
  return `<${tag}>`.repeat(depth) + text + `</${tag}>`.repeat(depth);
}

function parse(html: string): { text: string; opened: number; closed: number } {
  let text = "";
  let opened = 0;
  let closed = 0;
  const parser = createSaxParser({
    onopentagname: () => opened++,
    onclosetag: () => closed++,
    ontext: (data) => (text += data),
  });
  parser.write(html);
  parser.end();
  return { text, opened, closed };
}

describe("createSaxParser", () => {
  it("reads markup nested to the depth limit", () => {
    expect(parse(nested("div", MAX_SAX_DEPTH, "deep") + "after")).toEqual({
      text: "deepafter",
      opened: MAX_SAX_DEPTH,
      closed: MAX_SAX_DEPTH,
    });
  });

  it("stops at the first element past the depth limit", () => {
    expect(parse("before" + nested("div", MAX_SAX_DEPTH + 1, "deep") + "after")).toEqual({
      text: "before",
      opened: MAX_SAX_DEPTH,
      closed: 0,
    });
  });

  it("counts void and implied-closed elements as closed", () => {
    const html = "<br><img>".repeat(MAX_SAX_DEPTH) + "<p>a<p>b".repeat(MAX_SAX_DEPTH) + "end";
    expect(parse(html).text).toBe("ab".repeat(MAX_SAX_DEPTH) + "end");
  });
});

// #2031: each took over a second when htmlparser2 parsed the whole depth.
describe("deeply nested untrusted markup", () => {
  const DEPTH = 80_000;
  const BUDGET_MS = 200;

  it.each(["div", "sup"])("<%s> nesting is cut off quickly", (tag) => {
    const html = "<p>Lead paragraph.</p>" + nested(tag, DEPTH, "text");
    const start = performance.now();
    expect(stripHtml(html, 300)).toBe("Lead paragraph.");
    expect(generateSummary(html)).toBe("Lead paragraph.");
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });
});
