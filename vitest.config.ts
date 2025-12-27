import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use threads for faster parallel test execution
    pool: "threads",
  },
});
