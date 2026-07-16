import { describe, it, expect } from "vitest";
import { sanitizeEntryHtml } from "@/server/html/sanitize";
import fixtures from "./fixtures/mathjax-chtml-v3.json";

/**
 * MathJax CHTML → MathML conversion now runs inside the native sanitizer
 * (native/sanitizer/core/src/mathjax.rs) as the first stage of
 * `sanitizeEntryHtml`, so these tests exercise the full pipeline. Fixtures
 * in mathjax-chtml-v3.json are REAL mathjax-full 3.2.2 output, generated
 * with the exact configuration LessWrong's ForumMagnum uses; the `assistive`
 * fixture additionally enables AssistiveMmlHandler.
 */

// Hand-made samples matching the markup observed in LessWrong GraphQL
// `contents.html` (post-serialization, lowercase tags).
const MJX_X = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-math></mjx-container>`;

const MJX_YHAT = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-texatom texclass="ORD"><mjx-mover><mjx-over><mjx-mo class="mjx-n"><mjx-c class="mjx-c5E"></mjx-c></mjx-mo></mjx-over><mjx-base><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D466 TEX-I"></mjx-c></mjx-mi></mjx-base></mjx-mover></mjx-texatom></mjx-math></mjx-container>`;

const MJX_THETA_PRIME = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-msup><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D703 TEX-I"></mjx-c></mjx-mi><mjx-script><mjx-mo class="mjx-var" size="s"><mjx-c class="mjx-c2032"></mjx-c></mjx-mo></mjx-script></mjx-msup></mjx-math></mjx-container>`;

const MJX_Y_SUB = `<mjx-container class="MathJax" jax="CHTML" display="true"><mjx-math display="true" class=" MJX-TEX"><mjx-msub><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D466 TEX-I"></mjx-c></mjx-mi><mjx-script><mjx-texatom size="s" texclass="ORD"><mjx-mo class="mjx-n"><mjx-c class="mjx-c7C"></mjx-c></mjx-mo><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-texatom></mjx-script></mjx-msub></mjx-math></mjx-container>`;

const MJX_LOG = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-mi class="mjx-n"><mjx-c class="mjx-c6C"></mjx-c><mjx-c class="mjx-c6F"></mjx-c><mjx-c class="mjx-c67"></mjx-c></mjx-mi></mjx-math></mjx-container>`;

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

function convert(html: string): string {
  return sanitizeEntryHtml(html) ?? "";
}

/** Strip whitespace for structural assertions. */
const compact = (s: string) => s.replace(/\s+/g, "");

describe("MathJax CHTML conversion through sanitizeEntryHtml", () => {
  describe("no-op paths", () => {
    it("leaves content without MathJax CHTML untouched", () => {
      const html = "<p>Just <em>regular</em> text with no math.</p>";
      expect(convert(html)).toBe(html);
    });

    it("returns input unchanged when '<mjx-container' appears only in text/attributes", () => {
      const html = `<p title="about &lt;mjx-container&gt;">discussing <code>&lt;mjx-container&gt;</code> markup</p>`;
      expect(convert(html)).toBe(html);
      // attribute value containing the raw substring (matches the string guard
      // but yields no elements) must also pass through byte-identical
      const attrHtml = `<p data-x="<mjx-container">text</p>`;
      expect(convert(attrHtml)).toBe(attrHtml);
    });
  });

  describe("content preservation", () => {
    it("preserves content after a stray </body> close tag", () => {
      const html = `<p>x ${MJX_X}</p></body><p>tail1</p><p>tail2</p>`;
      const out = convert(html);
      expect(out).toContain("<p>tail1</p>");
      expect(out).toContain("<p>tail2</p>");
      expect(out).toContain("<math");
    });

    it("handles full-document input (saved LessWrong articles)", () => {
      const html = `<!DOCTYPE html><html><head><title>T</title></head><body><p>Let ${MJX_X} be it.</p></body></html>`;
      const out = convert(html);
      expect(out).toContain("<mi>\u{1D465}</mi>");
      expect(out).not.toContain("mjx-");
    });

    it("splices surrounding markup through verbatim (no full-document reserialize)", () => {
      // Odd-but-valid markup a full DOM reserialize would normalize (unquoted
      // attributes, uppercase tags, entities). Only the math block is
      // rewritten (and the sanitizer's own attribute transforms applied);
      // everything else must be byte-identical.
      const before = `<DIV class=box id=a><P>Fish &amp; chips`;
      const after = `</P><br>tail`;
      const out = convert(`${before}${MJX_X}${after}`);
      expect(out.startsWith(before)).toBe(true);
      expect(out.endsWith(after)).toBe(true);
      expect(out).toContain("<mi>\u{1D465}</mi>");
      expect(out).not.toContain("mjx-");
    });

    it("converts every container and preserves the text between them", () => {
      const html = `<p>a ${MJX_X} b ${MJX_LOG} c</p>`;
      const out = convert(html);
      expect(out).toBe(
        `<p>a <math xmlns="${MATHML_NS}"><mi>\u{1D465}</mi></math> b ` +
          `<math xmlns="${MATHML_NS}"><mi>log</mi></math> c</p>`
      );
      expect(out).not.toContain("mjx-");
    });

    it("keeps the ancestor close tag that implicitly closes an unclosed container", () => {
      // The container is missing its own `</mjx-container>`; recovery must
      // keep the `</div>` and the trailing text.
      const unclosed = MJX_X.replace("</mjx-container>", "");
      const out = convert(`<div>${unclosed}</div>after`);
      expect(out).toBe(`<div><math xmlns="${MATHML_NS}"><mi>\u{1D465}</mi></math></div>after`);
      expect(out).not.toContain("mjx-");
    });

    it("recovers article content absorbed into an unclosed container (EOF)", () => {
      // Unclosed container at EOF: HTML parsing pulls the trailing `<p>` into
      // the container as a child. The converter keeps only the math, so the
      // absorbed content must be spliced back verbatim rather than dropped.
      const unclosed = MJX_X.replace("</mjx-container>", "");
      const out = convert(`<p>before</p>${unclosed}<p>rest of article</p>`);
      expect(out).toBe(
        `<p>before</p><math xmlns="${MATHML_NS}"><mi>\u{1D465}</mi></math>` +
          `<p>rest of article</p>`
      );
      expect(out).not.toContain("mjx-");
    });

    it("recovers content absorbed between the math and an ancestor close", () => {
      const unclosed = MJX_X.replace("</mjx-container>", "");
      const out = convert(`<div>${unclosed}<p>stuff</p></div>after`);
      expect(out).toBe(
        `<div><math xmlns="${MATHML_NS}"><mi>\u{1D465}</mi></math>` + `<p>stuff</p></div>after`
      );
      expect(out).not.toContain("mjx-");
    });

    it("recovers content absorbed when </mjx-math> is only implicitly closed", () => {
      // Both `</mjx-math>` and `</mjx-container>` are missing, so the
      // trailing `<p>text</p>` is parsed as a child of the container and the
      // closes are all implied. The recovery boundary must NOT advance on an
      // implied close (that position is the absorbed content, not the math).
      // The math still converts; the absorbed content survives (its residual
      // mjx markup is stripped by the sanitize pass).
      const unclosedMath = MJX_X.replace("</mjx-math></mjx-container>", "");
      const sanitized = convert(`<div>${unclosedMath}<p>text</p></div>tail`);
      expect(sanitized).toContain("text");
      expect(sanitized).toContain("tail");
      expect(sanitized).toContain("<math");
      expect(sanitized).not.toContain("mjx-");
    });
  });

  describe("basic tokens and structures (LessWrong-serialized samples)", () => {
    it("converts a single identifier to <math><mi>", () => {
      const out = convert(MJX_X);
      expect(out).toContain("<math");
      expect(out).toContain("<mi>\u{1D465}</mi>"); // 𝑥
      expect(out).not.toContain("mjx-");
    });

    it("converts an over-accent (y-hat) preserving base-then-over order", () => {
      const out = convert(MJX_YHAT);
      expect(out).toMatch(/<mover><mi>\u{1D466}<\/mi><mo>\^<\/mo><\/mover>/u);
    });

    it("converts a superscript (theta') as <msup>[base, sup]", () => {
      const out = convert(MJX_THETA_PRIME);
      expect(out).toMatch(/<msup><mi>\u{1D703}<\/mi><mo>\u{2032}<\/mo><\/msup>/u);
    });

    it("converts a subscript as <msub>[base, sub]", () => {
      const out = convert(MJX_Y_SUB);
      expect(out).toMatch(
        /<msub><mi>\u{1D466}<\/mi><mrow><mo>\|<\/mo><mi>\u{1D465}<\/mi><\/mrow>/u
      );
    });

    it('marks display math with display="block"', () => {
      const out = convert(MJX_Y_SUB);
      expect(out).toContain('display="block"');
    });

    it("flattens multi-character identifiers into one token", () => {
      const out = convert(MJX_LOG);
      expect(out).toContain("<mi>log</mi>");
    });

    it("unwraps unknown <mjx-*> wrappers so inner glyphs survive", () => {
      const html = `<mjx-container><mjx-math><mjx-unknown-wrapper><mjx-mi><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-unknown-wrapper></mjx-math></mjx-container>`;
      const out = convert(html);
      expect(out).toContain("<mi>\u{1D465}</mi>");
      expect(out).not.toContain("mjx-");
    });

    it("rejects surrogate codepoints in glyph classes", () => {
      const html = `<mjx-container><mjx-math><mjx-mi><mjx-c class="mjx-cD800"></mjx-c></mjx-mi></mjx-math></mjx-container>`;
      const out = convert(html);
      expect(out).not.toContain("\ud800");
      expect(out).toContain("<mi></mi>");
    });
  });

  describe("real mathjax-full 3.2.2 output (ForumMagnum configuration)", () => {
    it("display \\sum: places limits under/over the operator", () => {
      const out = compact(convert(fixtures.displaySum));
      // munderover(base=∑, under=i=1, over=n)
      expect(out).toContain(
        "<munderover><mo>\u{2211}</mo><mrow><mi>\u{1D456}</mi><mo>=</mo><mn>1</mn></mrow><mi>\u{1D45B}</mi></munderover>"
      );
      expect(out).toContain('display="block"');
    });

    it("inline \\sum (limits=false, script layout): still emits munderover(base, under, over)", () => {
      const out = compact(convert(fixtures.inlineSum));
      expect(out).toContain(
        "<munderover><mo>\u{2211}</mo><mrow><mi>\u{1D456}</mi><mo>=</mo><mn>1</mn></mrow><mi>\u{1D45B}</mi></munderover>"
      );
    });

    it("x_i^2: emits msubsup(base, sub, sup) from the stacked script", () => {
      const out = compact(convert(fixtures.msubsup));
      expect(out).toContain("<msubsup><mi>\u{1D465}</mi><mi>\u{1D456}</mi><mn>2</mn></msubsup>");
    });

    it("nested fractions with \\left( \\right): delimiters survive and fractions pair correctly", () => {
      const out = compact(convert(fixtures.stretchyParens));
      expect(out).toContain("<mo>(</mo>");
      expect(out).toContain("<mo>)</mo>");
      // (a/b)/c: outer mfrac's numerator is the inner mfrac, denominator is c
      expect(out).toContain(
        "<mfrac><mfrac><mi>\u{1D44E}</mi><mi>\u{1D44F}</mi></mfrac><mi>\u{1D450}</mi></mfrac>"
      );
    });

    it("tall stretchy delimiters (glyph assembly): reads the codepoint from the stretchy element", () => {
      const out = compact(convert(fixtures.tallStretchy));
      expect(out).toContain("<mo>(</mo>");
      expect(out).toContain("<mo>)</mo>");
    });

    it("\\text with non-TeX-font characters: mjx-utext text survives", () => {
      const out = convert(fixtures.utext);
      expect(out).toContain("日本 x");
    });

    it("\\quad spacing: emits <mspace> with its width", () => {
      const out = convert(fixtures.mspace);
      expect(out).toMatch(/<mspace width="[^"]+"[^>]*>/);
    });

    it("pmatrix: emits mtable/mtr/mtd structure with cells intact", () => {
      const out = compact(convert(fixtures.pmatrix));
      expect(out).toContain(
        "<mtable><mtr><mtd><mi>\u{1D44E}</mi></mtd><mtd><mi>\u{1D44F}</mi></mtd></mtr><mtr><mtd><mi>\u{1D450}</mi></mtd><mtd><mi>\u{1D451}</mi></mtd></mtr></mtable>"
      );
    });

    it("\\sqrt[3]{x}: emits mroot(base, index)", () => {
      const out = compact(convert(fixtures.mroot));
      expect(out).toContain("<mroot><mi>\u{1D465}</mi><mn>3</mn></mroot>");
    });

    it("plain \\sqrt: emits msqrt without the CHTML surd glyph", () => {
      const out = compact(convert(fixtures.sqrtPlain));
      expect(out).toContain("<msqrt>");
      // the radical sign is drawn by MathML; the CHTML √ glyph must not leak
      expect(out).not.toContain("\u{221A}");
    });

    it("cases environment: converts to a table without dropping cells", () => {
      const out = convert(fixtures.cases);
      expect(out).toContain("<mtable>");
      expect(out).toContain("<mn>1</mn>");
      expect(out).toContain("<mn>0</mn>");
      expect(out).toContain("else");
    });
  });

  describe("assistive MathML preference", () => {
    it("uses embedded <mjx-assistive-mml> MathML verbatim instead of reconstructing", () => {
      const out = convert(fixtures.assistive);
      // The assistive MathML uses plain ASCII identifiers (<mi>y</mi>), while
      // reconstruction would decode mathematical-italic codepoints (𝑦) — so
      // ASCII y here proves the exact MathML was preferred.
      expect(compact(out)).toContain("<mover><mi>y</mi><mo");
      expect(out).not.toContain("\u{1D466}");
      // no CHTML elements remain (data-mjx-* attributes from the exact MathML are fine)
      expect(out).not.toContain("<mjx-");
    });

    it("keeps assistive MathML for a container even without an mjx-math child", () => {
      const html = `<p>x: <mjx-container class="MathJax"><mjx-assistive-mml><math xmlns="${MATHML_NS}"><mi>x</mi><mo>+</mo><mn>1</mn></math></mjx-assistive-mml></mjx-container></p>`;
      const out = convert(html);
      expect(compact(out)).toContain("<mi>x</mi><mo>+</mo><mn>1</mn>");
    });

    it("removes a container with neither mjx-math nor assistive MathML", () => {
      const html = `<p>a <mjx-container class="MathJax"></mjx-container>b</p>`;
      const out = convert(html);
      expect(out).not.toContain("mjx-container");
      expect(out).not.toContain("<math");
      expect(out).toContain("<p>a b</p>");
    });
  });

  describe("MathML survives the sanitize pass", () => {
    it("preserves converted MathML through sanitization", () => {
      const out = convert(`<p>Let ${MJX_X} be the context.</p>`);
      expect(out).toContain("<math");
      expect(out).toContain("<mi>\u{1D465}</mi>");
      expect(out).not.toContain("mjx-");
      expect(out).not.toContain("<style");
    });

    it("preserves table structures through sanitization", () => {
      const out = convert(fixtures.pmatrix);
      expect(out).toContain("<mtable>");
      expect(out).toContain("<mtr>");
      expect(out).toContain("<mtd>");
    });
  });
});
