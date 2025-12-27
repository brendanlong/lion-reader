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
  },
});
