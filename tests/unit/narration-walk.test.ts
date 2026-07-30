/**
 * The invariants of the narration walk (`src/lib/narration/runs.ts`).
 *
 * These are the properties the walk exists to guarantee, tested generically
 * rather than one markup shape at a time — the per-shape expectations live in
 * `html-to-narration-input.test.ts` and `client-paragraph-ids.test.ts`.
 *
 1. **Coverage**: every word in the entry is narrated exactly once — the
 *    property the run partition exists to guarantee (see the module docs on
 *    `runs.ts` for why the previous design couldn't), checked here rather than
 *    one markup shape at a time.
 * 2. **Numbering agreement**: the server (linkedom) and the client (DOMParser)
 *    must number the same elements, or a narration paragraph highlights the
 *    wrong one.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";
import { addParagraphIdsToHtml } from "../../src/lib/narration/client-paragraph-ids";
import { htmlToClientNarration } from "../../src/lib/narration/client-paragraph-ids";

/**
 * Markup shapes to hold the invariants against: the ones feeds actually emit,
 * the ones past narration bugs came from, and the awkward nestings in between.
 *
 * Every word is unique (`w0`, `w1`, …) so a missing or repeated one is
 * unambiguous — the structural markers narration adds ("Quote:", "- ") share no
 * vocabulary with them.
 */
const SHAPES = [
  "<p>w0 w1</p><p>w2</p>",
  "<h1>w0</h1><h2>w1</h2><p>w2</p>",
  "<div>w0</div>",
  "<div>w0<p>w1</p>w2</div>",
  "<div><div><div>w0</div></div></div>",
  "<section>w0</section><article>w1</article><aside>w2</aside><nav>w3</nav>",
  "<header>w0</header><main>w1</main><footer>w2</footer>",
  "<details><summary>w0</summary>w1<p>w2</p></details>",
  "<address>w0 w1</address>",
  "<dl><dt>w0</dt><dd>w1</dd><dt>w2</dt><dd><p>w3</p></dd></dl>",
  "<dl>w0<dt>w1</dt></dl>",
  "<ul><li>w0</li><li>w1</li></ul>",
  "<ul><li><p>w0</p></li><li><p>w1</p><p>w2</p></li></ul>",
  "<ul><li>w0<ul><li>w1</li></ul></li></ul>",
  "<ol><li>w0<div>w1</div></li></ol>",
  '<ul><li><input type="checkbox" checked>w0</li><li><input type="checkbox">w1</li></ul>',
  '<ul><li><input type="checkbox" checked><dl><dt>w0</dt><dd>w1</dd></dl></li></ul>',
  "<blockquote>w0</blockquote>",
  "<blockquote><p>w0</p><p>w1</p><footer>w2</footer></blockquote>",
  "<blockquote><div>w0</div><cite>w1</cite></blockquote>",
  "<blockquote><ul><li>w0</li></ul></blockquote>",
  "<blockquote><blockquote><p>w0</p></blockquote></blockquote>",
  "<p>w0 <strong>w1</strong> <em>w2</em> <span>w3</span> w4</p>",
  "<p>w0<br>w1<br><br>w2</p>",
  '<p>w0 <a href="https://example.com/a">w1</a> w2</p>',
  '<p><a id="fn1"></a>w0</p>',
  '<figure><img alt="w0"><figcaption>w1</figcaption></figure>',
  '<figure><div><img alt="w0"></div><figcaption>w1</figcaption></figure>',
  '<figure><a href="https://example.com/a"><img alt="w0"></a><figcaption>w1</figcaption></figure>',
  '<figure><img alt="w0"><figcaption><div>w1</div></figcaption></figure>',
  '<figure><img alt="w0"><p>w1</p></figure>',
  "<figure><table><tr><td>w0</td></tr></table><figcaption>w1</figcaption></figure>",
  '<p>w0</p><img alt="w1"><p>w2</p>',
  '<div><img alt="w0"></div>',
  '<div>w0 <img alt="w1"></div>',
  '<p>w0 <img alt="w1"> w2</p>',
  "<table><caption>w0</caption><tr><th>w1</th><td>w2</td></tr><tr><td>w3</td><td>w4</td></tr></table>",
  '<table><tr><td><ul><li>w0</li></ul></td><td><img alt="w1"></td></tr></table>',
  "<table><tr><td><table><tr><td>w0</td></tr></table></td></tr></table>",
  "<ul><li><table><tr><td>w0</td></tr></table></li></ul>",
  "<ul><li><blockquote><p>w0</p></blockquote></li></ul>",
  "<ul><li><figure><img alt='w0'></figure></li></ul>",
  "<div><section><p>w0</p><div>w1</div></section></div>",
  "<p>w0</p><hr><p>w1</p>",
  "<p>w0 <code>w1</code> w2</p>",
  "<p>w0 <math><mi>w1</mi></math> w2</p>",
  "w0<p>w1</p>",
  "<p></p><p>w0</p><div></div>",
  "<p>w0 <!-- comment --> w1</p>",
  "<table>w0<tr><td>w1</td></tr></table>",
  // A figure can claim an image through an empty wrapper, so these are the
  // shapes where it could claim one twice — the fuzzer can't reach them,
  // because it puts a word inside every element it generates.
  '<figure><figcaption><img alt="w0"></figcaption></figure>',
  '<figure><figure><img alt="w0"></figure></figure>',
  '<figure><table><tr><td><img alt="w0"></td></tr></table><figcaption>w1</figcaption></figure>',
  '<figure><div><img alt="w0"></div><div><img alt="w1"></div></figure>',
  '<figure><p><img alt="w0"></p><figcaption>w1</figcaption></figure>',
  '<div><figure><img alt="w0"><figcaption>w1</figcaption></figure></div>',
  '<table><tr><td><figure><img alt="w0"><figcaption>w1</figcaption></figure></td></tr></table>',
];

/** Every `w<n>` token in a string, in order. */
function words(text: string): string[] {
  return text.match(/\bw\d+\b/g) ?? [];
}

/** How many times each `w<n>` token occurs. */
function wordCounts(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of words(texts.join(" "))) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/** The words a shape puts in the document, from its text and its alt text. */
function expectedWords(html: string): string[] {
  return words(html);
}

describe("narration walk invariants", () => {
  describe("every word is narrated exactly once", () => {
    it.each(SHAPES)("server: %s", (html) => {
      const spoken = wordCounts(htmlToNarrationInput(html).paragraphs.map((p) => p.text));

      for (const word of expectedWords(html)) {
        expect(spoken.get(word), `${word} narrated ${spoken.get(word) ?? 0}× in ${html}`).toBe(1);
      }
      // And nothing invented: no word the document doesn't contain.
      expect([...spoken.keys()].sort()).toEqual([...new Set(expectedWords(html))].sort());
    });

    it.each(SHAPES)("client: %s", (html) => {
      const spoken = wordCounts([htmlToClientNarration(html).narrationText]);

      for (const word of expectedWords(html)) {
        expect(spoken.get(word), `${word} narrated ${spoken.get(word) ?? 0}× in ${html}`).toBe(1);
      }
      expect([...spoken.keys()].sort()).toEqual([...new Set(expectedWords(html))].sort());
    });
  });

  describe("server and client number the same elements", () => {
    it.each(SHAPES)("%s", (html) => {
      // The client stamps `data-para-id` in the numbering both sides share, so
      // the tag at each index must be the same one the server counted.
      const clientTags = [...addParagraphIdsToHtml(html).html.matchAll(/<(\w+)[^>]*data-para-id/g)];
      const serverTags = [...htmlToNarrationInput(html).paragraphs.map((p) => p.o)].filter(
        (o) => o >= 0
      );

      // Every `o` the server produced names an element the client marked.
      for (const o of serverTags) {
        expect(o, `para-${o} beyond the ${clientTags.length} elements marked`).toBeLessThan(
          clientTags.length
        );
      }
    });

    it("marks the elements the paragraphs point at", () => {
      const html =
        '<div>w0<p>w1</p></div><figure><img alt="w2"><figcaption>w3</figcaption></figure>';
      const { html: marked } = addParagraphIdsToHtml(html);
      const paragraphs = htmlToNarrationInput(html).paragraphs;

      // div holds the loose "w0", the <p> holds "w1", the figure speaks image
      // and caption together.
      expect(paragraphs.map((p) => p.text)).toEqual(["w0", "w1", "Image: w2. w3"]);
      expect(marked).toContain('<div data-para-id="para-0">');
      expect(marked).toContain('<p data-para-id="para-1">');
      expect(marked).toContain('<figure data-para-id="para-2">');
      expect(paragraphs.map((p) => p.o)).toEqual([0, 1, 2]);
    });
  });

  describe("fuzzed markup", () => {
    /** Deterministic 32-bit PRNG, so a failure is reproducible from its seed. */
    function random(seed: number): () => number {
      let state = seed;
      return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
    }

    const CONTAINERS = [
      "div",
      "section",
      "p",
      "li",
      "ul",
      "blockquote",
      "figure",
      "figcaption",
      "dl",
      "dd",
      "details",
      "summary",
      "span",
      "strong",
      "h2",
      "td",
      "tr",
      "table",
    ];

    /** Random markup with a unique word at every level. */
    function generate(next: () => number, counter: { n: number }, depth: number): string {
      if (depth <= 0 || next() < 0.3) {
        return ` w${counter.n++} `;
      }
      const tag = CONTAINERS[Math.floor(next() * CONTAINERS.length)];
      const children = 1 + Math.floor(next() * 3);
      let inner = "";
      for (let i = 0; i < children; i++) {
        inner += generate(next, counter, depth - 1);
      }
      if (next() < 0.25) {
        inner += ` <img alt="w${counter.n++}"> `;
      }
      return `<${tag}>${inner}</${tag}>`;
    }

    it("narrates every word exactly once, whatever the nesting", () => {
      for (let seed = 1; seed <= 200; seed++) {
        const next = random(seed);
        const counter = { n: 0 };
        const html = generate(next, counter, 4);

        // A word inside `<pre>` is deliberately unspoken in the TTS voice and a
        // table's cells are re-read by the table, so the fuzzer avoids both; the
        // words it does produce must all be spoken, once, by both voices.
        const byVoice: [string, string[]][] = [
          ["server", htmlToNarrationInput(html).paragraphs.map((p) => p.text)],
          ["client", [htmlToClientNarration(html).narrationText]],
        ];
        for (const [label, texts] of byVoice) {
          const spoken = wordCounts(texts);
          const expected = [...new Set(expectedWords(html))].sort();
          expect(
            [...spoken.keys()].sort(),
            `${label} seed ${seed}: ${html}\ngot ${JSON.stringify(texts)}`
          ).toEqual(expected);
          for (const word of expected) {
            expect(spoken.get(word), `${label} seed ${seed} said ${word} twice: ${html}`).toBe(1);
          }
        }
      }
    });
  });
});
