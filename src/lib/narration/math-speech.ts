/**
 * Presentation MathML as words, so neither the TTS engine nor the narration
 * LLM has to guess at structure that flat text loses: `<msup><mn>10</mn><mn>12</mn></msup>`
 * has text "1012" (issue #2310). Covers the layout elements the sanitizer keeps
 * (`ALLOWED_TAGS` in `native/sanitizer/core/src/sanitize.rs`); anything else is
 * read as its children, in order.
 *
 * @module narration/math-speech
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const SYMBOL_WORDS: Record<string, string> = {
  "×": "times",
  "·": "times",
  "⋅": "times",
  "∗": "times",
  "+": "plus",
  "-": "minus",
  "−": "minus",
  "±": "plus or minus",
  "/": "over",
  "÷": "divided by",
  "=": "equals",
  "≠": "is not equal to",
  "≈": "is approximately",
  "<": "is less than",
  ">": "is greater than",
  "≤": "is less than or equal to",
  "≥": "is greater than or equal to",
  "→": "to",
  "∈": "in",
  "∝": "is proportional to",
  "∞": "infinity",
  "∑": "the sum",
  "∏": "the product",
  "∫": "the integral",
  "′": "prime",
  "″": "double prime",
};

const TOKENS = new Set(["mi", "mn", "mo", "mtext", "ms"]);
const SILENT = new Set(["mphantom", "mspace", "mprescripts"]);

/** What a `<math>` element says, as words. `depthLeft` bounds the recursion. */
export function mathSpeech(math: Element, depthLeft: number): string {
  return speak(math, depthLeft).replace(/\s+/g, " ").trim();
}

function speak(el: Element, depthLeft: number): string {
  const tagName = el.tagName.toLowerCase();
  if (SILENT.has(tagName)) return "";
  if (TOKENS.has(tagName) || depthLeft <= 0) {
    // NFKC folds the mathematical alphanumerics MathJax emits ("𝑁") into
    // letters a TTS engine knows how to say.
    const text = (el.textContent ?? "").trim().normalize("NFKC");
    return SYMBOL_WORDS[text] ?? text;
  }

  const parts = Array.from(el.children).map((child) => speak(child, depthLeft - 1));
  const [first, second, third] = parts;
  if (parts.length === 2) {
    if (tagName === "msup") return power(first, second);
    if (tagName === "msub") return `${first} sub ${second}`;
    if (tagName === "mfrac") return `${first} over ${second}`;
    if (tagName === "mroot") return `the ${rootName(second)} root of ${first}`;
  }
  if (parts.length === 3) {
    if (tagName === "msubsup") return power(`${first} sub ${second}`, third);
    if (tagName === "munderover") return `${first} from ${second} to ${third}`;
  }
  if (tagName === "msqrt") return `the square root of ${parts.join(" ")}`;
  if (tagName === "mtable") return parts.join(", ");

  // Text sitting directly in a layout element: whitespace, or a malformed feed's words.
  let child = 0;
  return Array.from(el.childNodes)
    .map((node) => {
      if (node.nodeType === ELEMENT_NODE) return parts[child++];
      return node.nodeType === TEXT_NODE ? (node.textContent ?? "") : "";
    })
    .join(" ");
}

function power(base: string, exponent: string): string {
  if (exponent === "2") return `${base} squared`;
  if (exponent === "3") return `${base} cubed`;
  if (exponent.endsWith("prime")) return `${base} ${exponent}`;
  return `${base} to the power of ${exponent}`;
}

function rootName(index: string): string {
  if (index === "2") return "square";
  if (index === "3") return "cube";
  return `${index}th`;
}
