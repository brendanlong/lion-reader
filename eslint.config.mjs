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
