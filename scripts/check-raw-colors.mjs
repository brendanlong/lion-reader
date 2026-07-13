/**
 * Guardrail: block NEW raw Tailwind color utilities in app/component code.
 *
 * The app themes color through semantic tokens (see src/components/CLAUDE.md) —
 * `text-muted`, `bg-surface`, `border-edge`, `text-danger`, `bg-primary-solid`,
 * etc. — so a raw `text-blue-500` / `bg-zinc-700` bypasses theming and reintroduces
 * the drift issues #1169/#1178 cleaned up. A handful of raw utilities are
 * *intentional* (press-state `active:bg-zinc-*`, elevation `dark:bg-zinc-800`,
 * selection borders `border-zinc-400/500`, brand chips, prose modifiers,
 * foreground-on-accent) — those are recorded in the baseline below.
 *
 * This is a RATCHET: everything currently present is allowlisted; only *new*
 * (file, utility) pairs fail. When you add a legitimate exception, run
 * `pnpm check:colors --update` and commit the baseline change (it shows up in
 * review). When you introduce a stray raw color, CI fails and points you at the
 * token to use instead.
 *
 * Usage:
 *   node scripts/check-raw-colors.mjs            # check (CI); exit 1 on new violations
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
const RE = new RegExp(`(?:[a-z][\\w-]*:)*(?:${PROPS})-(?:${COLORS})-\\d{2,3}(?:/\\d{1,3})?`, "g");

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

if (added.length === 0) {
  console.log(`✓ No new raw color utilities (${current.size} allowlisted).`);
  process.exit(0);
}

console.error(
  `\n✗ ${added.length} new raw Tailwind color utilit${added.length === 1 ? "y" : "ies"} found.\n` +
    `Use a semantic token instead (see src/components/CLAUDE.md): e.g. text-muted, bg-surface,\n` +
    `border-edge, text-danger/-success/-warning, bg-primary-solid, text-accent.\n` +
    `If this is a genuinely intentional exception, run \`pnpm check:colors --update\` and commit\n` +
    `the baseline change so it's reviewed.\n`
);
for (const entry of added) {
  const [file, util] = entry.split("\t");
  console.error(`  ${file}: ${util}`);
}
console.error("");
process.exit(1);
