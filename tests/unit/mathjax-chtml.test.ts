import { describe, it, expect } from "vitest";
import { convertMathJaxChtmlToMathml } from "@/server/html/mathjax-chtml";
import { sanitizeEntryHtml } from "@/server/html/sanitize";

// Real MathJax v3 CHTML samples taken from a LessWrong post's GraphQL `contents.html`.
// LessWrong delivers math pre-rendered as CHTML (custom <mjx-*> elements whose
// glyphs come from CSS via `mjx-c<HEX>` class names), not as MathML or LaTeX.
const MJX_X = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-math></mjx-container>`;

// y-hat: <mover> with the accent (^) over the base (y).
const MJX_YHAT = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-texatom texclass="ORD"><mjx-mover><mjx-over><mjx-mo class="mjx-n"><mjx-c class="mjx-c5E"></mjx-c></mjx-mo></mjx-over><mjx-base><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D466 TEX-I"></mjx-c></mjx-mi></mjx-base></mjx-mover></mjx-texatom></mjx-math></mjx-container>`;

// theta-prime: <msup> with base theta and superscript prime.
const MJX_THETA_PRIME = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-msup><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D703 TEX-I"></mjx-c></mjx-mi><mjx-script><mjx-mo class="mjx-var" size="s"><mjx-c class="mjx-c2032"></mjx-c></mjx-mo></mjx-script></mjx-msup></mjx-math></mjx-container>`;

// y subscript (|x), display style.
const MJX_Y_SUB = `<mjx-container class="MathJax" jax="CHTML" display="true"><mjx-math display="true" class=" MJX-TEX"><mjx-msub><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D466 TEX-I"></mjx-c></mjx-mi><mjx-script><mjx-texatom size="s" texclass="ORD"><mjx-mo class="mjx-n"><mjx-c class="mjx-c7C"></mjx-c></mjx-mo><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-texatom></mjx-script></mjx-msub></mjx-math></mjx-container>`;

// Multi-character identifier "log".
const MJX_LOG = `<mjx-container class="MathJax" jax="CHTML"><mjx-math class=" MJX-TEX"><mjx-mi class="mjx-n"><mjx-c class="mjx-c6C"></mjx-c><mjx-c class="mjx-c6F"></mjx-c><mjx-c class="mjx-c67"></mjx-c></mjx-mi></mjx-math></mjx-container>`;

describe("convertMathJaxChtmlToMathml", () => {
  it("leaves content without MathJax CHTML untouched", () => {
    const html = "<p>Just <em>regular</em> text with no math.</p>";
    expect(convertMathJaxChtmlToMathml(html)).toBe(html);
  });

  it("converts a single identifier to <math><mi>", () => {
    const out = convertMathJaxChtmlToMathml(MJX_X);
    expect(out).toContain("<math");
    expect(out).toContain("<mi>\u{1D465}</mi>"); // 𝑥
    expect(out).not.toContain("mjx-");
    expect(out).not.toContain("<style");
  });

  it("converts an over-accent (y-hat) preserving base-then-over order", () => {
    const out = convertMathJaxChtmlToMathml(MJX_YHAT);
    // <mover> children must be [base, over]: y then ^
    expect(out).toMatch(/<mover><mi>\u{1D466}<\/mi><mo>\^<\/mo><\/mover>/u);
  });

  it("converts a superscript (theta') as <msup>[base, sup]", () => {
    const out = convertMathJaxChtmlToMathml(MJX_THETA_PRIME);
    expect(out).toContain("<msup>");
    expect(out).toMatch(/<msup><mi>\u{1D703}<\/mi><mo>\u{2032}<\/mo><\/msup>/u);
  });

  it("converts a subscript as <msub>[base, sub]", () => {
    const out = convertMathJaxChtmlToMathml(MJX_Y_SUB);
    expect(out).toContain("<msub>");
    // base y, then subscript group (| x)
    expect(out).toMatch(/<msub><mi>\u{1D466}<\/mi><mrow><mo>\|<\/mo><mi>\u{1D465}<\/mi><\/mrow>/u);
  });

  it('marks display math with display="block"', () => {
    const out = convertMathJaxChtmlToMathml(MJX_Y_SUB);
    expect(out).toContain('display="block"');
  });

  it("flattens multi-character identifiers into one token", () => {
    const out = convertMathJaxChtmlToMathml(MJX_LOG);
    expect(out).toContain("<mi>log</mi>");
  });

  it("unwraps unknown <mjx-*> wrappers so inner glyphs survive", () => {
    const html = `<mjx-container><mjx-math><mjx-unknown-wrapper><mjx-mi><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi></mjx-unknown-wrapper></mjx-math></mjx-container>`;
    const out = convertMathJaxChtmlToMathml(html);
    expect(out).toContain("<mi>\u{1D465}</mi>");
    expect(out).not.toContain("mjx-");
  });
});

describe("sanitizeEntryHtml with MathJax CHTML", () => {
  it("preserves converted MathML through sanitization", () => {
    const out = sanitizeEntryHtml(`<p>Let ${MJX_X} be the context.</p>`);
    expect(out).toContain("<math");
    expect(out).toContain("<mi>\u{1D465}</mi>");
    expect(out).not.toContain("mjx-");
    expect(out).not.toContain("<style");
  });
});
