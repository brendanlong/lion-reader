/**
 * Unit tests for htmlToNarrationInput function.
 *
 * Tests the paragraph marker generation and text preprocessing
 * for LLM narration generation.
 */

import { describe, it, expect } from "vitest";
import {
  htmlToNarrationInput,
  type HtmlToNarrationInputResult,
} from "../../src/lib/narration/html-to-narration-input";

/**
 * What the narration says, in order. Most of these tests are about the words;
 * which element each paragraph highlights is `o`, exercised in the "highlight
 * targets" block below and held to the server/client numbering invariant in
 * narration-walk.test.ts.
 */
function narrated(result: HtmlToNarrationInputResult): string[] {
  return result.paragraphs.map((paragraph) => paragraph.text);
}

describe("htmlToNarrationInput", () => {
  describe("basic paragraph handling", () => {
    it("extracts paragraphs with IDs and text", () => {
      const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["First paragraph.", "Second paragraph."]);
    });

    it("returns paragraphs with sequential IDs", () => {
      const html = "<p>First.</p><p>Second.</p><p>Third.</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["First.", "Second.", "Third."]);
    });

    it("handles empty HTML", () => {
      const result = htmlToNarrationInput("");

      expect(narrated(result)).toEqual([]);
    });

    it("handles HTML with only whitespace", () => {
      const result = htmlToNarrationInput("   \n\n   ");

      expect(narrated(result)).toEqual([]);
    });
  });

  describe("heading handling", () => {
    it("extracts h1 headings", () => {
      const html = "<h1>Main Title</h1>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Main Title"]);
    });

    it("extracts h2 headings", () => {
      const html = "<h2>Section Title</h2>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Section Title"]);
    });

    it("extracts h3 headings", () => {
      const html = "<h3>Subsection</h3>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Subsection"]);
    });

    it("extracts h4-h6 headings", () => {
      const html = "<h4>Minor heading</h4><h5>Smaller</h5><h6>Smallest</h6>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Minor heading", "Smaller", "Smallest"]);
    });
  });

  describe("code block handling", () => {
    it("marks code blocks with 'Code block:' prefix", () => {
      const html = "<pre><code>npm install</code></pre>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Code block: npm install End code block."]);
    });

    it("handles pre without code tag", () => {
      const html = "<pre>console.log('hello');</pre>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Code block: console.log('hello'); End code block."]);
    });

    it("handles inline code within paragraph", () => {
      const html = "<p>Use the <code>npm</code> command.</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Use the `npm` command."]);
    });
  });

  describe("blockquote handling", () => {
    it("marks blockquotes with 'Quote:' prefix", () => {
      const html = "<blockquote>A famous quote.</blockquote>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: A famous quote. End quote."]);
    });

    it("narrates a quoted paragraph once, not once per wrapper (issue #1445)", () => {
      // Every Markdown renderer emits a `>` quote in this shape.
      const html = "<blockquote><p>A famous quote.</p></blockquote>";
      const result = htmlToNarrationInput(html);

      // The quote speaks for the paragraph inside it, which keeps its own
      // paragraph index (1) but contributes no narration.
      expect(narrated(result)).toEqual(["Quote: A famous quote. End quote."]);
    });

    it("keeps a multi-paragraph quote's paragraphs apart", () => {
      // One paragraph each, so the player speaks two instead of "ab" — and each
      // highlights the <p> being read rather than the whole quote.
      const html = "<blockquote><p>a</p><p>b</p></blockquote>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: a", "b End quote."]);
      expect(result.paragraphs.map((p) => p.o)).toEqual([1, 2]);
    });

    it("reads an attribution after the quote it follows", () => {
      const html = "<blockquote><p>Quote text</p><footer>— Author</footer></blockquote>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: Quote text", "— Author End quote."]);
    });

    it("keeps structure the quote wraps", () => {
      // Descending rather than flattening to textContent, so a list inside a
      // quote keeps its bullets and a table keeps its markers.
      const html =
        "<blockquote><ul><li>a</li><li>b</li></ul></blockquote>" +
        "<blockquote><table><tr><td>A</td><td>B</td></tr></table></blockquote>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual([
        "Quote: - a",
        "- b End quote.",
        "Quote: Table: A, B End table. End quote.",
      ]);
    });

    it("still numbers the blocks that follow a quote", () => {
      // The suppressed <p> keeps its index — the client highlights by it.
      const html = "<blockquote><p>q</p></blockquote><p>after</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: q End quote.", "after"]);
    });

    it("marks a quote that is a list item's only content", () => {
      const html = "<ul><li><blockquote><p>x</p></blockquote></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Quote: x End quote."]);
    });

    it("reads through a wrapper between the quote and its paragraphs", () => {
      // The pull-quote markup WordPress-style editors emit. `<div>`/`<section>`
      // get no paragraph of their own, so the quote has to walk through them or
      // its text is narrated nowhere at all.
      const html =
        '<blockquote><div class="quote-body"><p>Be excellent.</p></div><cite>Bill</cite></blockquote>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: Be excellent.", "Bill End quote."]);
    });

    it("keeps a wrapper that only holds text in the run around it", () => {
      const html = "<blockquote>Hello <span>world</span> again</blockquote>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: Hello world again End quote."]);
    });

    it("keeps a quoted figure's caption as well as its image", () => {
      const html =
        '<blockquote><figure><img alt="A cat"><figcaption>My cat</figcaption></figure></blockquote>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: Image: A cat. My cat End quote."]);
    });

    it("keeps what a quoted figure wraps when it is not an image", () => {
      // A figure around a table announces no image — the table speaks instead.
      const html =
        "<blockquote><figure><table><tr><td>Cell A</td></tr></table>" +
        "<figcaption>Data</figcaption></figure></blockquote>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Quote: Table: Cell A End table.", "Data End quote."]);
    });

    it("narrates absurdly nested quotes instead of overflowing the stack", () => {
      // Feed HTML is not depth-limited and the content walk is recursive, so
      // past a point it flattens what is left rather than descending further.
      // Deep enough that an uncapped walk would overflow (measured: 2000 is
      // fine, 5000 throws), so removing the cap fails this test.
      const depth = 5000;
      const html = `${"<blockquote>".repeat(depth)}<p>the text</p>${"</blockquote>".repeat(depth)}`;
      const result = htmlToNarrationInput(html);

      expect(result.paragraphs).toHaveLength(1);
      expect(result.paragraphs[0].text).toContain("the text");
    });

    it("drops an empty quote instead of speaking bare markers", () => {
      const html = "<blockquote></blockquote><p>after</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["after"]);
    });
  });

  describe("image handling", () => {
    it("marks figures containing images", () => {
      const html = '<figure><img src="photo.jpg" alt="A beautiful sunset"></figure>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Image: A beautiful sunset"]);
    });

    it("narrates a figure's caption, which nothing else does", () => {
      // The caption is the description when there is no alt text, and extra
      // detail when there is — and `<figcaption>` gets no paragraph of its own.
      const html = '<figure><img alt="A cat"><figcaption>My cat</figcaption></figure>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Image: A cat. My cat"]);
    });

    it("narrates a figure whose image sits in a wrapper", () => {
      // The shape WordPress-style editors emit: a `<div>` holding nothing but
      // the image, which is the image's own paragraph rather than a block that
      // takes the image away from the figure.
      const html =
        '<figure><div class="image-block"><img alt="A cat"></div>' +
        "<figcaption>My cat</figcaption></figure>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Image: A cat. My cat"]);
    });

    it("does not announce an image for a figure that holds none", () => {
      // A figure around a table is not an image; the table speaks for itself,
      // and the caption reads after it, where it is written.
      const html =
        "<figure><table><tr><td>Cell</td></tr></table><figcaption>Data</figcaption></figure>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Cell End table.", "Data"]);
    });

    it("handles inline images within paragraphs", () => {
      const html = '<p>Look at this: <img src="photo.jpg" alt="A photo"></p>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Look at this: Image: A photo"]);
    });
  });

  describe("link handling", () => {
    it("preserves link text", () => {
      const html = '<p>Check out <a href="https://example.com">this link</a>.</p>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Check out this link."]);
    });

    it("converts URL-only links to domain mention", () => {
      const html = '<p>Visit <a href="https://example.com">https://example.com</a>.</p>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Visit [link to example.com]."]);
    });

    it("converts empty link text to domain mention", () => {
      const html = '<p>Visit <a href="https://example.com"></a> for more.</p>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Visit [link to example.com] for more."]);
    });

    it("does not announce an anchor that has no href", () => {
      // `<a id="fn1">` is a link target, not a link — it goes nowhere.
      const html = '<p><a id="fn1"></a>Footnote text</p>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Footnote text"]);
    });
  });

  describe("list handling", () => {
    it("marks list containers and items", () => {
      const html = "<ul><li>First item</li><li>Second item</li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- First item", "- Second item"]);
    });

    it("handles ordered lists", () => {
      const html = "<ol><li>Step one</li><li>Step two</li></ol>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Step one", "- Step two"]);
    });

    it("speaks task-list state, which the checkbox alone carries (issue #1439)", () => {
      // The checkbox contributes no text, so without this a done item and a
      // not-done item are read aloud identically.
      const html =
        '<ul><li><input type="checkbox" checked="" disabled=""> done</li>' +
        '<li><input type="checkbox" disabled=""> todo</li></ul>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Done: done", "- Not done: todo"]);
    });

    it("speaks task-list state for loose lists (checkbox inside the item's <p>)", () => {
      // cmark-gfm/GitHub shape, which arrives via feed HTML. The item has no
      // text of its own, so the marker rides along on its <p> (issue #1441).
      const html = '<ul><li><p><input type="checkbox" checked="" disabled=""> done</p></li></ul>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Done: done"]);
    });

    it("narrates a loose list item once, not once per wrapper (issue #1441)", () => {
      // Any list with blank lines between items comes out of cmark-gfm/GitHub
      // in this shape, so it is common in feed HTML.
      const html = "<ul><li><p>hello</p></li></ul>";
      const result = htmlToNarrationInput(html);

      // ul is 0 and li is 1; both are containers here, so only the <p> speaks.
      expect(narrated(result)).toEqual(["- hello"]);
    });

    it("keeps a multi-paragraph item's paragraphs separate", () => {
      const html = "<ul><li><p>a</p><p>b</p></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- a", "b"]);
    });

    it("narrates an item's own text and its block children separately", () => {
      const html = "<ul><li>intro<p>more</p></li></ul>";
      const result = htmlToNarrationInput(html);

      // The item speaks its own marker, so the <p> inherits none.
      expect(narrated(result)).toEqual(["- intro", "more"]);
    });

    it("hands the marker to the first child that actually speaks", () => {
      // Parking it on a leading empty <p> would lose it altogether.
      const html = "<ul><li><p></p><p>text</p></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- text"]);
    });

    it("keeps the task-list state when the item leads with an empty block", () => {
      // The checkbox is the item's only cue that it is done (#1439), so losing
      // the marker here would lose the state with it.
      const html = '<ul><li><p><input type="checkbox" checked=""></p><p>Ship it</p></li></ul>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Done: Ship it"]);
    });

    it("marks the item's own paragraph when it opens with a sublist", () => {
      // A nested list narrates only through its items, which mark themselves.
      const html = "<ul><li><ul><li>sub</li></ul><p>after</p></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- sub", "- after"]);
    });

    it("marks through a non-block wrapper inside the item", () => {
      // <div>/<section> get no paragraph of their own, so they are transparent.
      const html = "<ul><li><div><p>x</p></div></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- x"]);
    });

    it("does not let an empty link target take the item's marker", () => {
      const html = '<ul><li><a id="fn1"></a><p>Footnote text</p></li></ul>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Footnote text"]);
    });

    it("marks through a figure that announces no image", () => {
      // The figure speaks nothing of its own, so it owns nothing: the table
      // inside it carries the item's marker (issue #1441's invariant).
      const html = "<ul><li><figure><table><tr><td>x</td></tr></table></figure></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Table: x End table."]);
    });

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

    it("does not repeat a nested list's items in its parent item", () => {
      const html = "<ul><li>Parent<ul><li>Child</li></ul></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Parent", "- Child"]);
    });

    it("keeps an inline image in the item that contains it", () => {
      // A nested image gets no paragraph of its own, so its alt text has to
      // come from the enclosing block.
      const html = '<ul><li>Item with <img alt="icon"> image</li></ul>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Item with Image: icon image"]);
    });

    it("leaves a checkbox mid-item alone (not a task list)", () => {
      // `firstElementChild` would skip the leading text and misread this as a
      // task item, announcing a state the author never wrote.
      const html = '<ul><li>see <input type="checkbox" disabled=""> here</li></ul>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- see here"]);
    });
  });

  describe("table handling", () => {
    it("marks tables with 'Table:' prefix", () => {
      const html = "<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Cell 1, Cell 2 End table."]);
    });

    it("narrates a cell's paragraph only as part of the table (issue #1445)", () => {
      const html = "<table><tr><td><p>Cell 1</p></td><td>Cell 2</td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Cell 1, Cell 2 End table."]);
    });

    it("says what a silenced cell block would have said", () => {
      // The blocks in a cell stay silent for the table's sake, so anything they
      // would have narrated — an image's alt text, a list's bullets — has to
      // come through in the cell instead of being lost.
      const html =
        '<table><tr><td><figure><img alt="Sales chart"><figcaption>Fig 1</figcaption></figure></td>' +
        "<td><ul><li>a</li><li>b</li></ul></td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Image: Sales chart. Fig 1, - a - b End table."]);
    });

    it("narrates the caption, which no one else will (issue #1445)", () => {
      // `<caption>` is outside the row walk, and its blocks are silenced for
      // the table's sake — so if the table skips it, it is narrated nowhere.
      const html =
        "<table><caption><p>Table 1. Revenue by quarter</p></caption>" +
        "<tr><th>Q</th></tr><tr><td>1</td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Table 1. Revenue by quarter. Q. 1 End table."]);
    });

    it("reads a nested table as a cell of the outer one, once", () => {
      // More than one inner cell, so cells run together rather than being
      // separated would fail this too.
      const html =
        "<table><tr><td><table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>" +
        "</td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Table: A, B. C End table. End table."]);
    });

    it("keeps the space inside a cell's inline markup", () => {
      const html = "<table><tr><td><b>Name:</b><span> John</span></td></tr></table>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Table: Name: John End table."]);
    });
  });

  describe("mixed content", () => {
    it("processes elements in document order", () => {
      const html = `
        <h1>Title</h1>
        <p>Introduction paragraph.</p>
        <pre><code>example code</code></pre>
        <p>Another paragraph.</p>
      `;
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual([
        "Title",
        "Introduction paragraph.",
        "Code block: example code End code block.",
        "Another paragraph.",
      ]);
    });

    it("handles complex article structure", () => {
      const html = `
        <h1>Article Title</h1>
        <p>By Dr. Smith</p>
        <h2>Introduction</h2>
        <p>This is the introduction.</p>
        <ul>
          <li>Point one</li>
          <li>Point two</li>
        </ul>
        <blockquote>A memorable quote.</blockquote>
        <p>Final thoughts.</p>
      `;
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual([
        "Article Title",
        "By Dr. Smith",
        "Introduction",
        "This is the introduction.",
        "- Point one",
        "- Point two",
        "Quote: A memorable quote. End quote.",
        "Final thoughts.",
      ]);
    });
  });

  describe("HTML entity handling", () => {
    it("decodes common HTML entities", () => {
      const html = "<p>Tom &amp; Jerry &lt;3 ice cream &quot;yum&quot;</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(['Tom & Jerry <3 ice cream "yum"']);
    });

    it("handles nbsp", () => {
      const html = "<p>Hello&nbsp;World</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Hello World"]);
    });
  });

  describe("whitespace normalization", () => {
    it("collapses multiple spaces", () => {
      const html = "<p>Too    many    spaces</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Too many spaces"]);
    });

    it("handles multiple paragraphs", () => {
      const html = "<p>First</p>\n\n\n\n<p>Second</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["First", "Second"]);
    });

    it("trims whitespace", () => {
      const html = "<p>  Trimmed content  </p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Trimmed content"]);
    });
  });

  describe("wrapper handling", () => {
    it("does not add separate entries for divs (they are containers)", () => {
      const html = "<div><p>Content inside div</p></div>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Content inside div"]);
    });

    it("narrates a wrapper that holds only text (issue #1451)", () => {
      // What an editor that doesn't emit `<p>` leaves in a feed.
      const html = "<div>Some text</div>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Some text"]);
    });

    it("narrates each sectioning wrapper that holds only text", () => {
      const html = "<section>First</section><article>Second</article><aside>Third</aside>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["First", "Second", "Third"]);
    });

    it("narrates the innermost wrapper only", () => {
      const html = "<div><div>Some text</div></div>";
      const result = htmlToNarrationInput(html);

      // The outer wrapper is structural, so only the inner one speaks.
      expect(narrated(result)).toEqual(["Some text"]);
    });

    it("leaves a wrapper around a standalone image to the image", () => {
      // How most editors emit a standalone image; the wrapper saying the alt
      // text too would narrate it twice.
      const html = '<div><img alt="A cat"></div>';
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Image: A cat"]);
    });

    it("narrates a wrapper that holds text alongside an image", () => {
      const html = '<div>Credit: <img alt="A cat"></div>';
      const result = htmlToNarrationInput(html);

      // One paragraph, on the wrapper: the image is read within its run rather
      // than as a paragraph of its own, so nothing is said twice.
      expect(narrated(result)).toEqual(["Credit: Image: A cat"]);
    });

    it("narrates a wrapper's loose text as well as its blocks, each once", () => {
      const html = "<div>Intro<p>Body</p>Outro</div>";
      const result = htmlToNarrationInput(html);

      // Three runs: the wrapper's own text either side of the paragraph, which
      // speaks for itself. The loose runs highlight the wrapper (0), the
      // paragraph highlights itself (1).
      expect(narrated(result)).toEqual(["Intro", "Body", "Outro"]);
      expect(result.paragraphs.map((p) => p.o)).toEqual([0, 1, 0]);
    });

    it("keeps a wrapper inside a blockquote in the quote", () => {
      const html = "<blockquote><div>Quoted text</div></blockquote>";
      const result = htmlToNarrationInput(html);

      // The blockquote speaks its whole subtree, so the wrapper stays silent.
      expect(narrated(result)).toEqual(["Quote: Quoted text End quote."]);
    });

    it("gives a wrapper in a list item the item's marker", () => {
      const html = "<ul><li><div>Item text</div></li></ul>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["- Item text"]);
    });
  });

  describe("definition lists", () => {
    it("narrates terms and definitions (issue #1451)", () => {
      const html = "<dl><dt>Term</dt><dd>Definition</dd></dl>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Term", "Definition"]);
    });

    it("does not repeat a definition's own paragraphs", () => {
      const html = "<dl><dt>Term</dt><dd><p>First</p><p>Second</p></dd></dl>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Term", "First", "Second"]);
    });
  });

  describe("br handling", () => {
    it("reads a line break as a break, not as a word join", () => {
      const html = "<p>Line one<br>Line two</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Line one Line two"]);
    });

    it("speaks a blank line's worth of breaks as separate paragraphs", () => {
      // The `<br><br>` articles are written in; both halves highlight the <p>.
      const html = "<p>Line one<br><br>Line two</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Line one", "Line two"]);
      expect(result.paragraphs.map((p) => p.o)).toEqual([0, 0]);
    });

    it("does not let source formatting break a paragraph", () => {
      // A blank line in the markup is whitespace, not a paragraph break.
      const html = "<p>Line one\n\nLine two</p>";
      const result = htmlToNarrationInput(html);

      expect(narrated(result)).toEqual(["Line one Line two"]);
    });
  });
});
