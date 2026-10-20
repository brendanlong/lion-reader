/**
 * Guardrail: block NEW raw Tailwind color utilities in app/component code.
 *
 * The app themes color through semantic tokens (see src/components/CLAUDE.md) —
 * `text-muted`, `bg-surface`, `border-edge`, `text-danger`, `bg-primary-solid`,
 * etc. — so a raw `text-blue-500` / `bg-zinc-700` / `bg-white` bypasses theming
 * (including e-paper, which `dark:` pairs never reach) and reintroduces the
 * drift issues #1169/#1178 cleaned up.
 *
 * The baseline (`raw-color-baseline.json`) holds the only exceptions, each
 * because the color must NOT follow the theme:
 *
 *   - Brand buttons: third-party colors we don't own — the Apple sign-in button
 *     (black/white per Apple's guidelines), the Chrome/Firefox store links
 *     (blue/orange) and the Discord invite (indigo).
 *   - Article prose: `prose-*` modifiers that set Tailwind Typography's palette.
 *   - Scrims: the `bg-black/50` backdrop behind a modal or drawer.
 *   - QR codes: the white quiet zone a scanner needs in every theme.
 *
 * Anything else — a surface, a button background, a hover or press state, a
 * border — has a token in `src/app/globals.css`; if none fits the role, add one
 * there rather than a baseline entry.
 *
 * This is a RATCHET in both directions: a (file, utility) pair that isn't in
 * the baseline fails, and so does a baseline entry the code no longer has, so
 * the baseline shrinks as fixes land. For a new exception in one of the
 * categories above, or after removing one, run `pnpm check:colors --update`
 * and commit the baseline change (it shows up in review).
 *
 * Usage:
 *   node scripts/check-raw-colors.mjs            # check (CI); exit 1 on a new or stale entry
 *   node scripts/check-raw-colors.mjs --update   # regenerate the baseline
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["src"];
const BASELINE = path.join(ROOT, "scripts", "raw-color-baseline.json");

const COLORS =
  "zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PROPS =
  "text|bg|border|border-[trblxyse]|ring-offset|ring|divide|from|via|to|fill|stroke|placeholder|caret|accent|decoration|outline";
// Optional variant chain (dark:, hover:, active:, prose-headings:, …) + property-color-shade + optional /opacity.
const RE = new RegExp(
  `(?:[a-z][\\w-]*:)*(?:${PROPS})-(?:(?:${COLORS})-\\d{2,3}|white|black)(?:/\\d{1,3})?(?![\\w-])`,
  "g"
);

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

/** @returns {Set<string>} sorted-insertion set of "relativePath\tutility" occurrences */
function collect() {
  const found = new Set();
  for (const scanDir of SCAN_DIRS) {
    const abs = path.join(ROOT, scanDir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(RE)) {
        found.add(`${rel}\t${m[0]}`);
      }
    }
  }
  return found;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(BASELINE, "utf8")));
}

function writeBaseline(set) {
  const sorted = [...set].sort();
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + "\n");
  return sorted.length;
}

const current = collect();

if (process.argv.includes("--update")) {
  const n = writeBaseline(current);
  console.log(
    `Wrote ${path.relative(ROOT, BASELINE)} with ${n} allowlisted raw-color occurrences.`
  );
  process.exit(0);
}

const baseline = readBaseline();
const added = [...current].filter((x) => !baseline.has(x)).sort();
const stale = [...baseline].filter((x) => !current.has(x)).sort();

if (added.length === 0 && stale.length === 0) {
  console.log(`✓ No new raw color utilities (${current.size} allowlisted).`);
  process.exit(0);
}

/** @param {string[]} entries */
function printEntries(entries) {
  for (const entry of entries) {
    const [file, util] = entry.split("\t");
    console.error(`  ${file}: ${util}`);
  }
  console.error("");
}

if (added.length > 0) {
  console.error(
    `\n✗ ${added.length} new raw Tailwind color utilit${added.length === 1 ? "y" : "ies"} found.\n` +
      `Use a semantic token instead (see src/components/CLAUDE.md): e.g. text-muted, bg-surface,\n` +
      `border-edge, text-danger/-success/-warning, bg-primary-solid, text-accent.\n` +
      `If it falls under one of the exceptions in this script's header, run\n` +
      `\`pnpm check:colors --update\` and commit the baseline change so it's reviewed.\n`
  );
  printEntries(added);
}

if (stale.length > 0) {
  console.error(
    `\n✗ ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} no longer in the code.\n` +
      `Run \`pnpm check:colors --update\` and commit the smaller baseline, so the same raw\n` +
      `color can't quietly come back.\n`
  );
  printEntries(stale);
}

process.exit(1);
