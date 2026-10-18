import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vitest from "@vitest/eslint-plugin";

// "One sanctioned next/link wrapper" (see src/CLAUDE.md): PageLink is the
// only place `next/link` may be imported (it wraps `<Link prefetch={false}>`).
// Everywhere else uses PageLink for cross-SPA navigation or ClientLink for
// in-SPA pushState nav — importing `next/link` directly would reintroduce the
// default prefetching we avoid.
const NEXT_LINK = {
  name: "next/link",
  message:
    "Import PageLink (@/components/ui/page-link) or ClientLink (@/components/ui/client-link) instead of next/link — PageLink is the only sanctioned next/link wrapper.",
};

// `src/server/markdown` is the app's only entry point to the native renderer.
// Calling `@lion-reader/markdown` directly bypasses the size budgets and the
// frontmatter/title handling, and invites a second set of render options —
// i.e. a second Markdown dialect to keep in sync (see "Parsing" in CLAUDE.md).
const NATIVE_MARKDOWN = {
  name: "@lion-reader/markdown",
  message:
    "Import markdownToHtmlAsync or processMarkdown from @/server/markdown instead — that module owns the app's Markdown dialect and its size budgets.",
};

// Shared code doesn't depend on the routes: src/server and src/lib import
// nothing from src/app. Data a route and the server both need lives under
// src/lib (the demo's articles are in src/lib/demo for that reason).
const APP_LAYER = {
  group: ["@/app/*", "@/app/**"],
  message: "src/server and src/lib don't import from src/app: move what both need under src/lib.",
};

// API surfaces authenticate requests with authenticateCredential, naming the
// credential kinds they accept. A raw validator checks only that the token
// exists, so a scope check after it lets one OAuth client's token into
// another's API, which is how Wallabag accepted MCP clients' tokens.
const RAW_CREDENTIAL_MESSAGE =
  "Authenticate requests with authenticateCredential (@/server/auth/credential), which checks which client and audience a token belongs to.";
const RAW_CREDENTIAL_VALIDATORS = [
  ["oauth/service", "validateAccessToken"],
  ["auth/api-token", "validateApiToken"],
  ["auth/session", "validateSession"],
].map(([module, importName]) => ({
  group: [`@/server/${module}`, `**/${module}`, `./${module.split("/")[1]}`].flatMap((path) => [
    path,
    `${path}.js`,
  ]),
  importNames: [importName],
  message: RAW_CREDENTIAL_MESSAGE,
}));
// The request-auth code outside API_SURFACES.
const REQUEST_AUTH = ["src/server/trpc/context.ts", "src/server/auth/route-auth.ts"];

// Narration's UI has three entry points: the next/dynamic wrappers in
// index.tsx (which keep the engine out of the main chunk), the reader's
// useEntryNarration hook and the settings panel. Reaching past them couples
// the caller to narration's internals and can pull the engine into an eager
// chunk.
const NARRATION_INTERNALS = {
  group: [
    "**/components/narration/*",
    "!**/components/narration/index",
    "!**/components/narration/useEntryNarration",
    "!**/components/narration/NarrationSettings",
  ],
  message:
    "Outside src/components/narration, import @/components/narration, useEntryNarration or NarrationSettings, not narration internals.",
};

function restrictImports(paths, patterns = []) {
  return { "no-restricted-imports": ["error", { paths, patterns }] };
}

// Unread counts read the trigger-maintained counters, never a scan (see
// "Unread Counts" in src/server/CLAUDE.md): a `count(` over the per-user entry
// rows is how a badge drifts from its list (#1542). Matches a Drizzle query
// that counts from or joins `visibleEntries`/`userEntries`, and a `sql`
// template that counts and names either table. Heuristic: a count assembled
// from separate fragments slips past it.
const ENTRY_ROWS = "/^(visibleEntries|userEntries)$/";
const SQL_COUNT = "TemplateElement[value.raw=/\\bcount\\s*\\(/i]";
const NO_ENTRY_ROW_COUNT_MESSAGE =
  "Don't count visible_entries/user_entries rows: read the unread counters with countEntries (services/entries.ts) or services/counts.ts. A count that isn't an unread count (a page total, the counter reconciliation) disables no-restricted-syntax on that line, saying why.";
const NO_ENTRY_ROW_COUNT = [
  {
    selector: `CallExpression[callee.property.name=/^(from|innerJoin|leftJoin|rightJoin|fullJoin)$/][arguments.0.name=${ENTRY_ROWS}]:matches(:has(${SQL_COUNT}), :has(CallExpression[callee.name=/^count(Distinct)?$/]))`,
    message: NO_ENTRY_ROW_COUNT_MESSAGE,
  },
  {
    selector: `CallExpression[callee.property.name="$count"][arguments.0.name=${ENTRY_ROWS}]`,
    message: NO_ENTRY_ROW_COUNT_MESSAGE,
  },
  {
    selector: `TaggedTemplateExpression[tag.name="sql"]:has(${SQL_COUNT}):matches(:has(TemplateElement[value.raw=/\\b(visible_entries|user_entries)\\b/]), :has(Identifier[name=${ENTRY_ROWS}]))`,
    message: NO_ENTRY_ROW_COUNT_MESSAGE,
  },
];

// API surfaces stay thin adapters over the services ("Services Layer" in
// src/server/CLAUDE.md): a write to a core table outside services/ skips
// whatever the service does around it (locks, updated_at, the SSE publish,
// fetch jobs), which is how the Google Reader routes drifted (#1935). Matches
// `.insert/.update/.delete(table)` on these tables; raw SQL slips past it.
const CORE_TABLES =
  "/^(subscriptions|subscriptionTags|subscriptionEntries|userEntries|entries|feeds|tags)$/";
const NO_SURFACE_CORE_WRITE = [
  {
    selector: `CallExpression[callee.property.name=/^(insert|update|delete)$/][arguments.0.name=${CORE_TABLES}]`,
    message:
      "Write subscriptions, tags, entries and feeds through a service in src/server/services/, which every surface shares.",
  },
];
const API_SURFACES = [
  "src/app/api/**/*.ts",
  "src/server/trpc/routers/**/*.ts",
  "src/server/google-reader/**/*.ts",
  "src/server/wallabag/**/*.ts",
  "src/server/mcp/**/*.ts",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Guard against accidentally committed focused tests (`it.only`/`describe.only`),
  // which silently skip every other test in a file. Playwright's `forbidOnly` covers
  // e2e; this covers the vitest unit/integration suites.
  {
    files: ["tests/**/*.{ts,tsx}"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": ["error", { fixable: false }],
    },
  },
  // Restricted imports for all of src/. They share one block (plus one
  // override per exempt file or directory) because a later
  // `no-restricted-imports` block for the same files replaces an earlier one's
  // paths instead of merging: each override re-lists the rules it keeps.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: restrictImports([NEXT_LINK, NATIVE_MARKDOWN], [NARRATION_INTERNALS]),
  },
  {
    files: ["src/components/narration/**/*.{ts,tsx}"],
    rules: restrictImports([NEXT_LINK, NATIVE_MARKDOWN]),
  },
  {
    files: ["src/server/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: restrictImports([NEXT_LINK, NATIVE_MARKDOWN], [APP_LAYER, NARRATION_INTERNALS]),
  },
  {
    files: ["src/components/ui/page-link.tsx"],
    rules: restrictImports([NATIVE_MARKDOWN], [NARRATION_INTERNALS]),
  },
  {
    files: ["src/server/markdown/index.ts"],
    rules: restrictImports([NEXT_LINK], [APP_LAYER, NARRATION_INTERNALS]),
  },
  {
    files: API_SURFACES.filter((glob) => glob.startsWith("src/app/")),
    rules: restrictImports(
      [NEXT_LINK, NATIVE_MARKDOWN],
      [NARRATION_INTERNALS, ...RAW_CREDENTIAL_VALIDATORS]
    ),
  },
  {
    files: [...API_SURFACES.filter((glob) => glob.startsWith("src/server/")), ...REQUEST_AUTH],
    rules: restrictImports(
      [NEXT_LINK, NATIVE_MARKDOWN],
      [APP_LAYER, NARRATION_INTERNALS, ...RAW_CREDENTIAL_VALIDATORS]
    ),
  },
  // A later block setting no-restricted-syntax for a subset of src/ replaces
  // these selectors there (flat config doesn't merge them): include them.
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...NO_ENTRY_ROW_COUNT] },
  },
  {
    files: API_SURFACES,
    rules: {
      "no-restricted-syntax": ["error", ...NO_ENTRY_ROW_COUNT, ...NO_SURFACE_CORE_WRITE],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Build output
    "dist/**",
    // Vendored ONNX Runtime WASM/JS files
    "public/onnx/**",
    // Generated PWA service worker (next-pwa output from `pnpm build`)
    "public/sw.js",
    "public/workbox-*.js",
    "public/worker-*.js",
    // Kotlin Multiplatform app (Gradle build output)
    "kmp/**",
  ]),
]);

export default eslintConfig;
