/**
 * Tests for htmlToPlainText, the text AI summarization is given.
 */

import { describe, it, expect } from "vitest";
import { htmlToPlainText } from "@/server/html/strip-html";

describe("htmlToPlainText", () => {
  it("leaves out script, style and noscript contents", () => {
    // None of it is text the reader sees, so none of it belongs in the prompt.
    const html =
      "<style>.a { color: red; }</style><p>Kept.</p>" +
      "<script>var x = '<p>no</p>';</script><noscript><p>Enable JS</p></noscript><p>Also kept.</p>";
    expect(htmlToPlainText(html)).toBe("Kept.\n\nAlso kept.");
  });

  it("separates blocks with a blank line and collapses whitespace inside them", () => {
    const html =
      "<h1>Title</h1>\n  <p>Some <b>bold</b>&nbsp;text\n  here.</p><ul><li>a</li><li>b</li></ul>";
    expect(htmlToPlainText(html)).toBe("Title\n\nSome bold text here.\n\na\n\nb");
  });

  it("keeps the line breaks of preformatted text", () => {
    expect(htmlToPlainText("<pre>line one\nline two</pre>")).toBe("line one\nline two");
  });

  it("breaks definition lists into blocks and keeps a table row's cells on one line", () => {
    const html =
      "<dl><dt>Term</dt><dd>Meaning</dd></dl>" +
      "<table><tr><th>A</th><td>1</td></tr><tr><th>B</th><td>2</td></tr></table>";
    expect(htmlToPlainText(html)).toBe("Term\n\nMeaning\n\nA 1\n\nB 2");
  });

  it("gives each standalone image a paragraph of its alt text", () => {
    const html = '<p>1</p><img alt="A chart"><img src="x.jpg"><p>3</p>';
    expect(htmlToPlainText(html)).toBe("1\n\nImage: A chart\n\nImage\n\n3");
  });
});
