import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Use threads for faster parallel test execution
    pool: "threads",
    // Disable file parallelism for integration tests that share database state.
    // This prevents race conditions where one test's beforeEach cleanup
    // deletes data that another test is using.
    fileParallelism: false,
    // Setup file for test matchers (jest-dom for jsdom tests)
    setupFiles: ["./tests/setup.ts"],
    // Note: Frontend tests use @vitest-environment jsdom comment at the top of files
    // to specify jsdom environment. This keeps backend tests in node environment.
  },
});
