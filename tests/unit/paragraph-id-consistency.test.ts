/**
 * Server and client must number elements identically.
 *
 * Narration is derived server-side (the LLM path) but highlighted client-side:
 * the server hands back a paragraph map of element numbers and the client marks
 * elements with `data-para-id="para-{n}"`. If the two number differently, every
 * paragraph highlights the wrong thing.
 *
 * Both sides call `narrationTargets`, so the risk left isn't the numbering rule
 * — it's that they parse the same HTML into different trees (parse5 + linkedom
 * server-side, `DOMParser` in the browser). That is what these tests pin down;
 * the coverage invariants live in narration-walk.test.ts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { narrationTargets } from "../../src/lib/narration/block-elements";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";
import { parseBodyAsBrowser } from "../../src/lib/narration/parse-html";
import { LLM_INPUT_VOICE, narrationRuns } from "../../src/lib/narration/runs";
import { addParagraphIdsToHtml } from "../../src/lib/narration/client-paragraph-ids";

/** The elements the server numbers, as tag names in numbering order. */
function serverTargets(html: string): string[] {
  return narrationTargets(parseBodyAsBrowser(html)).map((el) => el.tagName.toLowerCase());
}

/** The elements the client marks, as tag names in the order it marked them. */
function clientTargets(html: string): string[] {
  const marked = addParagraphIdsToHtml(html).html;
  return [...marked.matchAll(/<(\w+)(?=[^>]*\sdata-para-id)/g)].map((match) =>
    match[1].toLowerCase()
  );
}

/** What the server says to narrate, paragraph by paragraph. */
function serverParagraphs(html: string): string[] {
  return htmlToNarrationInput(html).paragraphs.map(
    (paragraph) => `${paragraph.o}: ${paragraph.text}`
  );
}

/** The same walk over the browser's tree — what the server has to match. */
function clientParagraphs(html: string): string[] {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    "text/html"
  );
  return narrationRuns(doc.body, LLM_INPUT_VOICE).map((run) => `${run.o}: ${run.text}`);
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

/**
 * Shapes a spec tree builder rearranges, which is where the two sides used to
 * part company (issue #1453). A `<table>` can't hold prose, so a browser
 * foster-parents it out to just before the table; it also closes an open `<p>`,
 * and an `<a>` inside an `<a>` closes the outer one. None of it survives the
 * sanitizer's streaming rewrite, so narration is what has to agree about it.
 */
const TREE_CONSTRUCTION_SHAPES = [
  "<p>x</p><table><div>h</div><tr><td>c</td></tr></table><p>y</p>",
  '<table><img alt="Hoisted"><tr><td>c</td></tr></table>',
  "<table>Loose text<tr><td>c</td></tr></table>",
  "<table><p>Para</p><tr><td>c</td></tr></table>",
  "<table><tr><td>c</td></tr><div>After the rows</div></table>",
  "<p>a<table><tr><td>b</td></tr></table>c</p>",
  '<a href="https://out.com/"><a href="https://in.com/"></a></a>',
  "<p>x<b>y</p>z</b>",
  "<form><p>a</p><form><p>b</p></form></form>",
];

const ALL_SHAPES = [...SHAPES, ...TREE_CONSTRUCTION_SHAPES];

/**
 * The shape jsdom can't be the oracle for. Foster-parented *text* goes before
 * the table in parse5 and in a real browser (checked in Chromium), but jsdom
 * appends it after — its own bug, and only jsdom's: the numbering is unaffected
 * (text isn't an element), so it costs this one comparison. The server's output
 * is pinned directly below instead.
 */
const JSDOM_FOSTER_PARENTS_TEXT_WRONG = "<table>Loose text<tr><td>c</td></tr></table>";

describe("paragraph ID consistency between server and client", () => {
  it.each(ALL_SHAPES)("numbers the same elements: %s", (html) => {
    expect(clientTargets(html)).toEqual(serverTargets(html));
  });

  // Same tree, so the same words in the same order too: where the trees used to
  // differ the server would also read a moved `<table>` sibling in the wrong
  // place, or announce the wrong one of two nested links.
  it.each(ALL_SHAPES.filter((html) => html !== JSDOM_FOSTER_PARENTS_TEXT_WRONG))(
    "narrates the same paragraphs: %s",
    (html) => {
      expect(serverParagraphs(html)).toEqual(clientParagraphs(html));
    }
  );

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
    for (const html of ALL_SHAPES) {
      const marked = clientTargets(html).length;
      for (const paragraph of htmlToNarrationInput(html).paragraphs) {
        expect(paragraph.o, `para-${paragraph.o} of ${marked} marked in ${html}`).toBeLessThan(
          marked
        );
      }
    }
  });

  // The shape issue #1453 was filed for, spelled out: the numbers are the
  // hoisted <div>'s, not the table's, and everything after it shifts with it.
  it("numbers foster-parented content where a browser puts it", () => {
    const html = "<p>x</p><table><div>h</div><tr><td>c</td></tr></table><p>y</p>";

    expect(serverTargets(html)).toEqual(["p", "div", "table", "p"]);
    expect(highlightedTags(html)).toEqual(["p", "div", "table", "p"]);
  });

  // Same, for the text a table can't hold — read before the table, not after.
  it("reads text foster-parented out of a table before the table", () => {
    expect(serverParagraphs(JSDOM_FOSTER_PARENTS_TEXT_WRONG)).toEqual([
      "-1: Loose text",
      "0: Table: c End table.",
    ]);
  });
});
