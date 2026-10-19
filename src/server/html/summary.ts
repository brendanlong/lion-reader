/**
 * Plain-text entry summaries (list-view previews).
 *
 * One streaming parse turns the opening of the HTML into a list of text runs,
 * each tagged with the markup context it came from. The parse decides nothing;
 * {@link SUMMARY_RULES} then rewrite the run list one after another, and the
 * survivors are joined and truncated. A rule that needs markup (is this "1" a
 * footnote marker or a section number?) reads it from the run's context
 * instead of tracking parser state.
 */

import { Parser } from "htmlparser2";
import { BLOCK_TAGS, SKIP_TAGS, truncateAtWord, truncateText } from "./strip-html";

/** Longest summary (entry preview text) we generate, in characters. */
export const SUMMARY_MAX_LENGTH = 300;

/**
 * Text we read past {@link SUMMARY_MAX_LENGTH} before stopping, so rules that
 * drop text (footnote markers, a footer paragraph) still leave a full summary,
 * and the element the limit falls in is read to its end.
 */
const READ_AHEAD = 500;

/**
 * Most text, labels included, we read before stopping, so a document of
 * nothing but headings (or empty markup the parse turns into runs) can't make
 * a summary cost more than this.
 */
const MAX_TEXT_READ = 20_000;

/**
 * Elements whose text is a label around the prose rather than prose:
 * "Summary", "Abstract", column headers. Read inline they fuse into the
 * sentence that follows, so a summary leaves them out unless they're all there
 * is. Table cells stay, `<th>` included: emails lay out their whole body in
 * tables, and Foundation for Emails puts it in `<th class="columns">`.
 */
const LABEL_TAGS: ReadonlySet<string> = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "caption",
  "figcaption",
]);

/** A link to somewhere on the same page, which may be a footnote reference. */
interface InPageLink {
  /** `role="doc-noteref"`. */
  noteRef: boolean;
}

/** One super- or subscript element; its runs are transliterated together. */
interface Script {
  kind: "sup" | "sub";
  /** The script this one is nested in. */
  parent?: Script;
}

/** A text run and the markup it sits in. Context objects are shared by identity. */
interface Run {
  text: string;
  /** Runs in different blocks are joined with a space. */
  block: number;
  /** The `<p>` the run is in, if any. */
  paragraph?: object;
  label: boolean;
  link?: InPageLink;
  script?: Script;
  /** Parentheses and slash the parse adds around fraction operands. */
  fraction?: { operand: object; edge: "open" | "close" | "slash" };
}

interface Context {
  hidden: boolean;
  label: boolean;
  paragraph?: object;
  link?: InPageLink;
  script?: Script;
}

interface Frame {
  tag: string;
  context: Context;
  childCount: number;
  /** Set on an `<mfrac>` child: the operand its closing parenthesis ends. */
  fractionOperand?: object;
}

/** The script a MathML element's `childIndex`-th child (1-based) is set in. */
function mathScriptKind(parent: string, childIndex: number): Script["kind"] | undefined {
  if (parent === "msup") return childIndex === 2 ? "sup" : undefined;
  if (parent === "msub") return childIndex === 2 ? "sub" : undefined;
  if (parent === "msubsup") return childIndex === 2 ? "sub" : childIndex === 3 ? "sup" : undefined;
  return undefined;
}

/** An alt that describes the image, not a filename or URL standing in for one. */
function isDescriptiveAlt(alt: string): boolean {
  return /\s/.test(alt) && !/^(?:https?:)?\/\//i.test(alt);
}

interface ParsedSummary {
  runs: Run[];
  /**
   * Longest descriptive image alt, for documents with no text. Longest,
   * because the main image is described and navigation buttons ("Next Page")
   * are only labelled.
   */
  imageAlt: string | null;
}

function parseRuns(html: string): ParsedSummary {
  const runs: Run[] = [];
  let imageAlt: string | null = null;
  let block = 0;
  let proseRead = 0;
  let textRead = 0;
  const root: Frame = {
    tag: "",
    context: { hidden: false, label: false },
    childCount: 0,
  };
  const stack: Frame[] = [root];

  const emit = (fullText: string, context: Context, fraction?: Run["fraction"]) => {
    // One text event can be a whole paragraph; keep only what the budget can
    // use, so no rule ever sees more than that.
    const budget = context.label
      ? MAX_TEXT_READ - textRead
      : Math.min(MAX_TEXT_READ - textRead, SUMMARY_MAX_LENGTH + READ_AHEAD - proseRead);
    const text = fullText.slice(0, Math.max(budget, 0) + 1);
    runs.push({
      text,
      block,
      paragraph: context.paragraph,
      label: context.label,
      link: context.link,
      script: context.script,
      fraction,
    });
    textRead += text.length;
    if (!context.label) proseRead += text.length;
    if (proseRead > SUMMARY_MAX_LENGTH + READ_AHEAD || textRead > MAX_TEXT_READ) {
      parser.pause();
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        const parent = stack[stack.length - 1];
        const inherited = parent.context;
        const context: Context = { ...inherited };
        const frame: Frame = { tag, context, childCount: 0 };

        if (BLOCK_TAGS.has(tag)) block++;
        if (SKIP_TAGS.has(tag)) context.hidden = true;
        // Position among the visible children, which is what MathML means
        if (!context.hidden) parent.childCount++;
        if (LABEL_TAGS.has(tag)) context.label = true;
        if (tag === "p") context.paragraph = {};

        if (tag === "a") {
          const href = attribs.href ?? "";
          context.link = href.startsWith("#")
            ? { noteRef: attribs.role === "doc-noteref" }
            : undefined;
        }
        const kind =
          tag === "sup" || tag === "sub" ? tag : mathScriptKind(parent.tag, parent.childCount);
        if (kind) context.script = { kind, parent: inherited.script };

        if (parent.tag === "mfrac" && parent.childCount <= 2 && !context.hidden) {
          frame.fractionOperand = {};
          if (parent.childCount === 2) {
            emit("/", inherited, { operand: frame.fractionOperand, edge: "slash" });
          }
          emit("(", inherited, { operand: frame.fractionOperand, edge: "open" });
        }

        if (tag === "img" && !context.hidden) {
          const alt = attribs.alt?.trim().replace(/\s+/g, " ") ?? "";
          if (isDescriptiveAlt(alt) && alt.length > (imageAlt?.length ?? 0)) imageAlt = alt;
        }
        stack.push(frame);
      },
      ontext(text) {
        const { context } = stack[stack.length - 1];
        if (!context.hidden) emit(text, context);
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        // htmlparser2 closes every element it opens (void, implied and at EOF),
        // so the stack stays balanced.
        const frame = stack.pop();
        if (frame?.fractionOperand) {
          emit(")", stack[stack.length - 1].context, {
            operand: frame.fractionOperand,
            edge: "close",
          });
        }
        if (BLOCK_TAGS.has(tag)) block++;
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();
  return { runs, imageAlt };
}

/** Joins runs, with a space between blocks, and normalizes whitespace. */
function joinRuns(runs: readonly Run[]): string {
  let text = "";
  let block: number | undefined;
  for (const run of runs) {
    if (block !== undefined && run.block !== block) text += " ";
    text += run.text;
    block = run.block;
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Groups runs by a shared context object, in first-seen order. */
function groupBy(runs: readonly Run[], key: (run: Run) => object | undefined): Map<object, Run[]> {
  const groups = new Map<object, Run[]>();
  for (const run of runs) {
    const k = key(run);
    if (!k) continue;
    const group = groups.get(k);
    if (group) group.push(run);
    else groups.set(k, [run]);
  }
  return groups;
}

/** Drops the runs of every group whose joined text `shouldDrop`. */
function dropGroups(
  runs: Run[],
  key: (run: Run) => object | undefined,
  shouldDrop: (text: string, group: Run[]) => boolean
): Run[] {
  const dropped = new Set<object>();
  for (const [k, group] of groupBy(runs, key)) {
    if (shouldDrop(joinRuns(group), group)) dropped.add(k);
  }
  return dropped.size === 0 ? runs : runs.filter((run) => !dropped.has(key(run) ?? {}));
}

/**
 * In-page links whose text is a footnote marker. `[12]`, `*` and `†` are
 * markers on their own, but a bare `1` is as likely a section link unless it's
 * set as a superscript (inside or around the link) or marked up as a note
 * reference.
 */
function dropFootnoteMarkers(runs: Run[]): Run[] {
  return dropGroups(
    runs,
    (run) => run.link,
    (text, group) =>
      /^(?:\[\d{1,3}\]|[*†‡§])$/.test(text) ||
      ((group[0].link!.noteRef || group.some((run) => run.script?.kind === "sup")) &&
        /^\d{1,3}$/.test(text))
  );
}

/** The footer Yoast/WordPress appends to every feed item. */
const WORDPRESS_FEED_FOOTER = /^The post .+ appeared first on .+\.$/;

/**
 * Longest footer we test for: a title and a site name. Also keeps the
 * backtracking regex off long paragraphs.
 */
const MAX_FOOTER_LENGTH = 500;

function dropWordPressFooter(runs: Run[]): Run[] {
  return dropGroups(
    runs,
    (run) => run.paragraph,
    (text) => text.length <= MAX_FOOTER_LENGTH && WORDPRESS_FEED_FOOTER.test(text)
  );
}

const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPTS: Readonly<Record<string, string>> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
};

/** Longest super/subscript we transliterate; real ones are an exponent or an index. */
const MAX_SCRIPT_LENGTH = 8;

/**
 * Rewrites each super/subscript in Unicode (`x²`, `H₂O`) when every character
 * has a form; anything else (`19th`) stays plain text. Nested scripts stay
 * too: `10²³` would read as one exponent.
 */
function transliterateScripts(runs: Run[]): Run[] {
  const nesting = new Set<Script>();
  for (const run of runs) {
    if (run.script?.parent) nesting.add(run.script.parent);
  }
  const replaced = new Map<object, string>();
  for (const [script, group] of groupBy(runs, (run) => run.script)) {
    if ((script as Script).parent || nesting.has(script as Script)) continue;
    const text = joinRuns(group);
    if (text.length === 0 || text.length > MAX_SCRIPT_LENGTH) continue;
    const table = (script as Script).kind === "sup" ? SUPERSCRIPTS : SUBSCRIPTS;
    const chars = [...text].map((char) => table[char]);
    if (chars.every((char) => char !== undefined)) replaced.set(script, chars.join(""));
  }
  if (replaced.size === 0) return runs;

  const result: Run[] = [];
  for (const run of runs) {
    const text = run.script && replaced.get(run.script);
    if (text === undefined) {
      result.push(run);
    } else if (text !== "") {
      result.push({ ...run, text });
      replaced.set(run.script!, ""); // the whole script goes in its first run
    }
  }
  return result;
}

/**
 * Longest fraction operand we check, in runs; longer ones keep their
 * parentheses. Counting runs rather than characters also bounds operands of
 * nested empty fractions, whose runs are all dropped parentheses.
 */
const MAX_OPERAND_RUNS = 40;

/**
 * The parse wraps every fraction operand in parentheses (`(1)/(x+1)`); keep
 * them only where "/" would otherwise misgroup, so `a/b` and `1/(x+1)`.
 */
function simplifyFractions(runs: Run[]): Run[] {
  const opens = new Map<object, number>();
  const drop = new Set<number>();
  for (let i = 0; i < runs.length; i++) {
    const fraction = runs[i].fraction;
    if (fraction?.edge === "open") opens.set(fraction.operand, i);
    if (fraction?.edge !== "close") continue;
    const open = opens.get(fraction.operand);
    if (open === undefined) continue;
    opens.delete(fraction.operand);
    const operand = operandText(runs, open + 1, i, drop);
    if (operand !== null && ([...operand].length <= 1 || /^[\d.]+$/.test(operand))) {
      drop.add(open);
      drop.add(i);
    }
  }
  // An operand the parse stopped inside never closed.
  for (const open of opens.values()) drop.add(open);
  return drop.size === 0 ? runs : runs.filter((_, i) => !drop.has(i));
}

/** The operand's text, or null when it spans more than {@link MAX_OPERAND_RUNS}. */
function operandText(
  runs: readonly Run[],
  from: number,
  to: number,
  dropped: ReadonlySet<number>
): string | null {
  if (to - from > MAX_OPERAND_RUNS) return null;
  let text = "";
  for (let i = from; i < to; i++) {
    if (!dropped.has(i)) text += runs[i].text;
  }
  return text.replace(/\s+/g, "");
}

/** Applied in order; each sees the previous one's output. */
const SUMMARY_RULES: ReadonlyArray<(runs: Run[]) => Run[]> = [
  dropFootnoteMarkers,
  dropWordPressFooter,
  transliterateScripts,
  simplifyFractions,
];

/**
 * Generates a plain-text summary (entry preview) from HTML content, truncated
 * to {@link SUMMARY_MAX_LENGTH} characters at a word boundary.
 *
 * Labels (headings, table headers, captions) are left out unless they're all
 * the text there is, and an image-only document (a comic) is summarized by its
 * longest descriptive alt text unless `imageAlt` is false. The rules applied
 * on top are {@link SUMMARY_RULES}.
 */
export function generateSummary(html: string, { imageAlt = true } = {}): string {
  if (!html) {
    return "";
  }
  const parsed = parseRuns(html);
  let runs = parsed.runs;
  for (const rule of SUMMARY_RULES) {
    runs = rule(runs);
  }
  const text = joinRuns(runs.filter((run) => !run.label)) || joinRuns(runs);
  if (text) {
    return truncateAtWord(text, SUMMARY_MAX_LENGTH);
  }
  return imageAlt && parsed.imageAlt ? truncateText(parsed.imageAlt, SUMMARY_MAX_LENGTH) : "";
}

/**
 * Builds a plain-text summary from already-cleaned (Readability) content.
 *
 * This is the single source of truth for turning cleaned content into an
 * excerpt, shared by every surface that runs Readability then needs a preview
 * (saved articles, uploaded HTML/docx). It prefers the page's description
 * when it's substantial — that's usually a hand-written `og:description` /
 * meta description and reads better than a truncated first paragraph — and
 * otherwise summarizes the cleaned article HTML with {@link generateSummary}.
 *
 * The ≥50-char guard keeps a junk/empty meta tag from winning. A page that sets
 * a site-wide (rather than per-article) description is a site problem, not
 * something to detect here.
 *
 * Pure (no DB/network/native), so it can be unit-tested directly.
 */
export function summarizeCleanedContent(cleaned: { excerpt: string; content: string }): string {
  if (cleaned.excerpt && cleaned.excerpt.length >= 50) {
    return truncateText(cleaned.excerpt, SUMMARY_MAX_LENGTH);
  }
  return generateSummary(cleaned.content);
}
