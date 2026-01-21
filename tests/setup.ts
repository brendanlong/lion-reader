/**
 * Vitest setup file.
 *
 * This file runs before all tests and sets up global configuration.
 * DOM-specific setup (jest-dom matchers, cleanup) only runs in jsdom environment.
 */

import { afterEach } from "vitest";

// Only import DOM-related setup when running in jsdom environment
// This check works because jsdom sets up a window object
if (typeof window !== "undefined") {
  // Import jest-dom matchers for DOM assertions
  import("@testing-library/jest-dom/vitest");

  // Import cleanup and set it up
  import("@testing-library/react").then(({ cleanup }) => {
    // Cleanup after each test to prevent memory leaks and test pollution
    afterEach(() => {
      cleanup();
    });
  });
}
