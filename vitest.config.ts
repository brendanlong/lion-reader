import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    // Use threads for faster parallel test execution
    pool: "threads",
    // Setup file for test matchers (jest-dom for jsdom tests)
    setupFiles: ["./tests/setup.ts"],
    // Note: Frontend tests use @vitest-environment jsdom comment at the top of files
    // to specify jsdom environment. This keeps backend tests in node environment.
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.{ts,tsx}"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.{ts,tsx}"],
          // The files share one database, and one file's cleanup would
          // delete rows another is using.
          fileParallelism: false,
        },
      },
    ],
  },
});
