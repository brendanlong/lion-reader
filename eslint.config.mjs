import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import vitest from "@vitest/eslint-plugin";

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
  // Enforce the "one sanctioned next/link wrapper" rule (see src/CLAUDE.md):
  // PageLink is the only place `next/link` may be imported (it wraps
  // `<Link prefetch={false}>`). Everywhere else uses PageLink for cross-SPA
  // navigation or ClientLink for in-SPA pushState nav — importing `next/link`
  // directly would reintroduce the default prefetching we avoid.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/page-link.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/link",
              message:
                "Import PageLink (@/components/ui/page-link) or ClientLink (@/components/ui/client-link) instead of next/link — PageLink is the only sanctioned next/link wrapper.",
            },
          ],
        },
      ],
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
  ]),
]);

export default eslintConfig;
