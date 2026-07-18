/**
 * Guardrail: block semantic-token color utilities whose backing `@theme` variable
 * no longer exists.
 *
 * The app themes color through semantic tokens defined in `src/app/globals.css`'s
 * `@theme inline` block (`--color-surface`, `--color-body`, `--color-edge`, …).
 * Tailwind v4 only emits a utility like `bg-surface` while `--color-surface` is
 * declared; if the token is renamed or removed (as #1227 removed
 * `--color-strong`/`--color-emphasis`), the utility becomes **inert** — it still
 * appears in the DOM but produces no CSS, so the element silently loses its color
 * (see #1235: the unread dot's `bg-strong` went invisible). jsdom class-name
 * assertions can't catch this because they check the string, not the computed
 * style, so the regression sailed through CI.
 *
 * This script scans `src/**` for color utilities (`bg-*`, `text-*`, `border-*`,
 * `ring-*`, …) that reference a semantic token and fails when that token has no
 * matching `--color-*` entry in `@theme inline`. It runs at zero runtime cost and
 * catches the whole class of "valid-looking utility, dead token" bug.
 *
 * Not every `text-*`/`border-*` string is a themed color: Tailwind ships
 * structural utilities (`text-center`, `text-sm`, `border-2`, `border-dashed`,
 * `outline-none`) and CSS keywords (`bg-transparent`, `text-white`), and raw
 * palette colors (`bg-zinc-100`) are governed separately by `check:colors`. Those
 * are recognised and skipped. Comments (`//…`, `/* … *\/`, JSX `{/* … *\/}`) are
 * blanked before scanning, so token-shaped prose like the compound `text-processing`
 * in a comment doesn't trip the check (#1323). Whatever remains that is NOT a live
 * theme token is treated as a violation — except a small BASELINE of non-class noise
 * (HTML-content strings and import paths that merely look like utilities). This is a
 * RATCHET, exactly like `check:colors`: when you legitimately
 * introduce such a string, run `pnpm check:theme-tokens --update` and commit the
 * baseline change so it shows up in review.
 *
 * Usage:
 *   node scripts/check-theme-tokens.mjs            # check (CI); exit 1 on violations
 *   node scripts/check-theme-tokens.mjs --update   # regenerate the baseline
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src"];
const GLOBALS_CSS = path.join(ROOT, "src", "app", "globals.css");
const BASELINE = path.join(ROOT, "scripts", "theme-token-baseline.json");

// Color-carrying utility prefixes (mirror scripts/check-raw-colors.mjs). Longest
// first so the regex matches `border-b`/`ring-offset` before `border`/`ring`.
const PROPS = [
  "ring-offset",
  "border-t",
  "border-r",
  "border-b",
  "border-l",
  "border-x",
  "border-y",
  "border-s",
  "border-e",
  "placeholder",
  "decoration",
  "divide",
  "stroke",
  "accent",
  "border",
  "caret",
  "fill",
  "text",
  "ring",
  "from",
  "via",
  "to",
  "bg",
  "outline",
];
const PROP_ALT = PROPS.join("|");

const PALETTE =
  "zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";

// A utility occurrence: optional variant chain (dark:, hover:, …), a prefix, then
// the value (token name / keyword / size / arbitrary [..]), optional /opacity.
// Lookbehind keeps us from matching inside a longer identifier (e.g. the `text-xs`
// inside our own `ui-text-xs`).
const RE = new RegExp(
  `(?<![\\w-])(?:[a-z][\\w-]*:)*(${PROP_ALT})-([a-z0-9][a-zA-Z0-9/%-]*|\\[[^\\]]*\\])`,
  "g"
);

const PALETTE_SHADE = new RegExp(`^(?:${PALETTE})-\\d{2,3}$`);

// CSS keywords and Tailwind's non-themed color values.
const KEYWORDS = new Set([
  "transparent",
  "current",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "none",
  "auto",
  "white",
  "black",
]);

// Structural (non-color) Tailwind utilities that share a color prefix. None of
// these collide with our semantic token names, so skipping them can't hide a dead
// token. A bare value that is purely numeric / a length / a percentage is also a
// structural utility (border-2, ring-2, ring-offset-2, from-0%).
const STRUCTURAL = new Set([
  // text sizes
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  // text alignment / wrapping / overflow
  "left",
  "center",
  "right",
  "justify",
  "start",
  "end",
  "wrap",
  "nowrap",
  "balance",
  "pretty",
  "clip",
  "ellipsis",
  // border / outline styles
  "solid",
  "dashed",
  "dotted",
  "double",
  "hidden",
  // divide axes / reverse
  "x",
  "y",
  "reverse",
  // bare single-side borders (border-t/-r/-b/-l/-s/-e add a side, no color)
  "t",
  "r",
  "b",
  "l",
  "s",
  "e",
]);

function isStructural(value) {
  if (STRUCTURAL.has(value)) return true;
  // text-2xl … text-9xl
  if (/^\d+xl$/.test(value)) return true;
  // numeric widths / offsets / positions, optionally a length or percentage
  if (/^\d+(?:\.\d+)?(?:%|px|rem|em)?$/.test(value)) return true;
  return false;
}

/** Parse the `@theme inline { … }` block and return the set of `--color-*` names. */
function readThemeColors() {
  const css = fs.readFileSync(GLOBALS_CSS, "utf8");
  // Anchor on the block's opening brace (not a bare textual mention) so a comment
  // referencing `@theme inline` can't misdirect the parser.
  const at = css.match(/@theme\s+inline\s*\{/);
  if (!at) throw new Error("No `@theme inline { … }` block in globals.css");
  const open = at.index + at[0].length - 1;
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = css.slice(open + 1, end);
  const colors = new Set();
  for (const m of block.matchAll(/--color-([a-z0-9-]+)\s*:/g)) {
    colors.add(m[1]);
  }
  return colors;
}

/** @returns {string[]} every *.ts/*.tsx file under the scan dirs */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blank out comments (`//…`, `/* … *\/`, and JSX `{/* … *\/}`) so token-shaped
 * words in prose don't trip the utility regex (see #1323: the comment phrase
 * `text-processing` was flagged as a dead `text-*` color utility). We keep string
 * and template-literal content — that's where real class names live — and only
 * treat `//`/`/*` as a comment opener when it's outside a string. Comment bytes
 * are replaced with spaces (newlines preserved) so nothing merges across them.
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  // state: null (code), '"' / "'" / "`" (string of that quote)
  let quote = null;
  while (i < n) {
    const c = text[i];
    if (quote !== null) {
      out.push(c);
      if (c === "\\" && i + 1 < n) {
        // keep the escaped char verbatim
        out.push(text[i + 1]);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    // not in a string
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out.push(c);
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      // line comment: blank until end of line
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      // block comment (also covers JSX `{/* … *\/}`): blank until `*\/`
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        out.push("  "); // the closing `*\/`
        i += 2;
      }
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join("");
}

/**
 * Collect every color-prefixed utility whose value is NOT a live theme color,
 * a palette shade, a keyword, a structural utility, or an arbitrary value.
 * @returns {Map<string, Set<string>>} normalized utility -> set of relative files
 */
function collect(themeColors) {
  const found = new Map();
  for (const scanDir of SCAN_DIRS) {
    const abs = path.join(ROOT, scanDir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      const text = stripComments(fs.readFileSync(file, "utf8"));
      for (const m of text.matchAll(RE)) {
        const prop = m[1];
        let value = m[2];
        if (value.startsWith("[")) continue; // arbitrary value
        // Strip any opacity modifier: `/50`, `/12.5`, or an arbitrary `/[0.5]`
        // (the char class stops at `[`, leaving a trailing `surface/`). Token
        // names never contain `/`, so the part before it is the token.
        value = value.split("/")[0];
        if (!value) continue;
        if (PALETTE_SHADE.test(value)) continue; // governed by check:colors
        if (KEYWORDS.has(value.toLowerCase())) continue;
        if (isStructural(value)) continue;
        if (themeColors.has(value)) continue; // live semantic token — good
        const util = `${prop}-${value}`;
        if (!found.has(util)) found.set(util, new Set());
        found.get(util).add(rel);
      }
    }
  }
  return found;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(BASELINE, "utf8")));
}

function writeBaseline(utils) {
  const sorted = [...utils].sort();
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n");
  return sorted.length;
}

const themeColors = readThemeColors();
const current = collect(themeColors);

if (process.argv.includes("--update")) {
  const n = writeBaseline(current.keys());
  console.log(`Wrote ${path.relative(ROOT, BASELINE)} with ${n} allowlisted non-token utilities.`);
  process.exit(0);
}

const baseline = readBaseline();
const violations = [...current.keys()].filter((u) => !baseline.has(u)).sort();

if (violations.length === 0) {
  console.log(
    `✓ No dead theme-token utilities (${themeColors.size} tokens, ${current.size} allowlisted).`
  );
  process.exit(0);
}

console.error(
  `\n✗ ${violations.length} color utilit${violations.length === 1 ? "y" : "ies"} reference a token that has no ` +
    `matching --color-* entry in globals.css's @theme inline block.\n` +
    `Tailwind v4 emits no CSS for these, so the color silently renders as nothing (see #1235).\n` +
    `Fix the utility to use a live semantic token (see src/components/CLAUDE.md), or add the token.\n` +
    `If this is genuinely not a Tailwind class (an SVG attribute, CSS property, or content string),\n` +
    `run \`pnpm check:theme-tokens --update\` and commit the baseline change so it's reviewed.\n`
);
for (const util of violations) {
  const files = [...current.get(util)].sort();
  console.error(`  ${util}  (${files.join(", ")})`);
}
console.error("");
process.exit(1);
