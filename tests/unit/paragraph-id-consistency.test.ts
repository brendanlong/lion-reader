/**
 * Server and client must number elements identically.
 *
 * Narration is derived server-side (the LLM path) but highlighted client-side:
 * the server hands back a paragraph map of element numbers and the client marks
 * elements with `data-para-id="para-{n}"`. If the two number differently, every
 * paragraph highlights the wrong thing.
 *
 * Both sides call `narrationTargets`, so the risk left isn't the numbering rule
 * — it's that they parse the same HTML into different trees (linkedom
 * server-side, `DOMParser` in the browser). That is what these tests pin down;
 * the coverage invariants live in narration-walk.test.ts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { parseHTML } from "linkedom";
import { narrationTargets } from "../../src/lib/narration/block-elements";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";
import { addParagraphIdsToHtml } from "../../src/lib/narration/client-paragraph-ids";

/** The elements the server numbers, as tag names in numbering order. */
function serverTargets(html: string): string[] {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  return narrationTargets(document.body).map((el) => el.tagName.toLowerCase());
}

/** The elements the client marks, as tag names in the order it marked them. */
function clientTargets(html: string): string[] {
  const marked = addParagraphIdsToHtml(html).html;
  return [...marked.matchAll(/<(\w+)(?=[^>]*\sdata-para-id)/g)].map((match) =>
    match[1].toLowerCase()
  );
}

/** The tag each narrated paragraph highlights, per the server's numbering. */
function highlightedTags(html: string): string[] {
  const targets = serverTargets(html);
  return htmlToNarrationInput(html).paragraphs.map((paragraph) =>
    paragraph.o < 0 ? "(none)" : targets[paragraph.o]
  );
}

const SHAPES = [
  '<p>1</p><img alt="2"><p>3</p>',
  '<h2>Title</h2><p>First</p><img alt="pic"><p>Second</p>',
  '<p>Text <img alt="inline"> more text</p><p>Next</p>',
  '<p>Before</p><figure><img alt="fig"><figcaption>Cap</figcaption></figure><p>After</p>',
  "<dl><dt>Term</dt><dd>Definition</dd></dl>",
  "<div>Text an editor put in a div</div>",
  '<div class="wrapper"><p>Wrapped</p></div>',
  '<div><img alt="A cat"></div>',
  "<ul><li>One</li><li><p>Two</p></li></ul>",
  "<blockquote><p>Quoted</p><footer>Author</footer></blockquote>",
  "<table><caption>C</caption><tr><th>H</th><td>Cell</td></tr></table>",
  "<pre><code>const x = 1;</code></pre>",
  "<details><summary>More</summary><p>Body</p></details>",
  "<section><header>Head</header><p>Body</p><footer>Foot</footer></section>",
  "<p>Unclosed<div>next</div>",
  "<dt>Orphan term</dt><dd>Orphan definition</dd>",
  "<div>a<p>b</p>c</div>",
];

describe("paragraph ID consistency between server and client", () => {
  it.each(SHAPES)("numbers the same elements: %s", (html) => {
    expect(clientTargets(html)).toEqual(serverTargets(html));
  });

  it("points each paragraph at the element that holds it", () => {
    const html =
      "<h2>Title</h2>" +
      "<div>Loose text<p>Paragraph</p></div>" +
      '<figure><img alt="A cat"><figcaption>My cat</figcaption></figure>' +
      "<dl><dt>Term</dt><dd>Definition</dd></dl>" +
      "<ul><li><p>Item</p></li></ul>" +
      '<div><img alt="Standalone"></div>';

    expect(highlightedTags(html)).toEqual([
      "h2", // the heading
      "div", // the wrapper's own loose text
      "p", // its paragraph
      "figure", // the image and its caption, together
      "dt",
      "dd",
      "p", // the loose list item's paragraph carries the bullet
      "img", // an image alone in its run highlights itself
    ]);
  });

  it("marks every element a paragraph can point at", () => {
    for (const html of SHAPES) {
      const marked = clientTargets(html).length;
      for (const paragraph of htmlToNarrationInput(html).paragraphs) {
        expect(paragraph.o, `para-${paragraph.o} of ${marked} marked in ${html}`).toBeLessThan(
          marked
        );
      }
    }
  });

  // Content that isn't allowed inside a table (text, a stray <div>) is
  // foster-parented out of it by a browser's parser but left where it was
  // written by linkedom, so the two number the elements around it differently.
  // Pre-existing and not narration's doing — see issue #1453.
  it.skip("numbers the same elements for foster-parented content", () => {
    const html = "<p>x</p><table><div>h</div><tr><td>c</td></tr></table><p>y</p>";

    expect(clientTargets(html)).toEqual(serverTargets(html));
  });
});
