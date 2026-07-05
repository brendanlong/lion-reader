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
  // Using top-level await to ensure matchers are registered before tests run
  await import("@testing-library/jest-dom/vitest");

  // jsdom doesn't implement IntersectionObserver, which several components use
  // for infinite scroll / sticky controls. Provide a no-op stub so those
  // components mount in component tests without a ReferenceError.
  if (typeof globalThis.IntersectionObserver === "undefined") {
    class IntersectionObserverStub implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin: string = "";
      readonly scrollMargin: string = "";
      readonly thresholds: ReadonlyArray<number> = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    globalThis.IntersectionObserver =
      IntersectionObserverStub as unknown as typeof IntersectionObserver;
  }

  // Import cleanup and set it up
  const { cleanup } = await import("@testing-library/react");
  // Cleanup after each test to prevent memory leaks and test pollution
  afterEach(() => {
    cleanup();
  });
}
