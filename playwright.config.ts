import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E test configuration.
 *
 * Run with `pnpm test:e2e` so that .env.test is loaded (the tests and the app
 * server both need the test database and Redis). Requires the docker-compose
 * Postgres and Redis services to be running, like the integration tests.
 *
 * The web server is started automatically against the test database. Tests
 * seed their own users/feeds directly in the database (see tests/e2e/helpers.ts)
 * and inject a session cookie, so no UI login flow is needed.
 */

const PORT = process.env.E2E_PORT ? parseInt(process.env.E2E_PORT, 10) : 4983;
const BASE_URL = `http://localhost:${PORT}`;

// In CI, run against the production build (`pnpm build && pnpm build:server`
// must have run first) so the deployed code path — next build output served by
// dist/server.js with the compression wrapper — is what gets tested. Locally,
// default to the dev server for fast iteration; set E2E_PRODUCTION=true to
// test the production build locally instead.
const useProductionBuild = !!process.env.CI || process.env.E2E_PRODUCTION === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  // Tests share one database and one app server; run serially to avoid
  // cross-test interference (matches vitest's fileParallelism: false).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Generous timeouts: the Next.js dev server compiles routes on first request.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: BASE_URL,
    navigationTimeout: 120_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: useProductionBuild ? "pnpm start" : "pnpm dev:next",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      PORT: String(PORT),
      // .env.test sets NODE_ENV=test, but the app server should run in
      // development or production mode (DATABASE_URL/REDIS_URL still come
      // from .env.test via inherited process env, which Next.js never
      // overrides).
      NODE_ENV: useProductionBuild ? "production" : "development",
    },
  },
});
