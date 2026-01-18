/**
 * useInfiniteScrollConfig Hook
 *
 * Provides viewport-aware configuration for infinite scroll.
 * Calculates optimal page size and scroll trigger distance based on
 * what's visible in the viewport.
 */

"use client";

import { useMemo, useSyncExternalStore } from "react";

/**
 * Configuration for infinite scroll behavior.
 */
export interface InfiniteScrollConfig {
  /**
   * Number of entries to fetch per page.
   * Calculated as ~2x what fits in the viewport.
   */
  pageSize: number;

  /**
   * CSS value for IntersectionObserver rootMargin.
   * Distance from viewport edge to trigger loading.
   * Calculated based on viewport height for smooth scrolling.
   */
  rootMargin: string;

  /**
   * Whether the viewport has been measured (client-side only).
   * On SSR, this will be false and defaults are used.
   */
  isConfigured: boolean;
}

/**
 * Options for the useInfiniteScrollConfig hook.
 */
export interface UseInfiniteScrollConfigOptions {
  /**
   * Estimated height of a single entry item in pixels.
   * Used to calculate how many entries fit in the viewport.
   * @default 100
   */
  estimatedEntryHeight?: number;

  /**
   * Default page size to use before viewport is measured (SSR and initial render).
   * @default 10
   */
  defaultPageSize?: number;

  /**
   * Multiplier for how many viewport-heights worth of entries to fetch.
   * E.g., 2 means fetch enough entries to fill 2x the viewport.
   * @default 2
   */
  pageSizeMultiplier?: number;

  /**
   * Multiplier for rootMargin relative to viewport height.
   * E.g., 0.5 means trigger loading when half a viewport away from bottom.
   * @default 0.5
   */
  rootMarginMultiplier?: number;

  /**
   * Minimum page size regardless of viewport calculation.
   * @default 5
   */
  minPageSize?: number;

  /**
   * Maximum page size regardless of viewport calculation.
   * @default 50
   */
  maxPageSize?: number;
}

// Subscribe to window resize events
function subscribeToResize(callback: () => void) {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

// Get current viewport height, returning 0 during SSR
function getViewportHeight() {
  return typeof window !== "undefined" ? window.innerHeight : 0;
}

// Server snapshot always returns 0 (viewport unknown during SSR)
function getServerSnapshot() {
  return 0;
}

// No-op subscribe function for client detection
function emptySubscribe() {
  return () => {};
}

/**
 * Hook that provides viewport-aware configuration for infinite scroll.
 *
 * On the server and during initial client render, returns sensible defaults.
 * After client hydration, measures the viewport and calculates optimal settings.
 *
 * @param options - Configuration options
 * @returns Infinite scroll configuration
 */
export function useInfiniteScrollConfig(
  options: UseInfiniteScrollConfigOptions = {}
): InfiniteScrollConfig {
  const {
    estimatedEntryHeight = 100,
    defaultPageSize = 10,
    pageSizeMultiplier = 2,
    rootMarginMultiplier = 0.5,
    minPageSize = 5,
    maxPageSize = 50,
  } = options;

  // Use useSyncExternalStore to safely subscribe to viewport height changes
  // This avoids the "setState in effect" anti-pattern
  const viewportHeight = useSyncExternalStore(
    subscribeToResize,
    getViewportHeight,
    getServerSnapshot
  );

  // Detect if we're on the client using useSyncExternalStore
  // Returns true on client, false on server - avoids hydration mismatches
  const isClient = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

  // Calculate config based on viewport height
  const config = useMemo((): InfiniteScrollConfig => {
    // Not on client yet - return defaults
    if (!isClient || viewportHeight === 0) {
      return {
        pageSize: defaultPageSize,
        rootMargin: "400px", // ~50% of typical viewport before actual measurement
        isConfigured: false,
      };
    }

    // Calculate how many entries fit in the viewport
    const entriesPerViewport = Math.max(1, Math.floor(viewportHeight / estimatedEntryHeight));

    // Page size: fetch enough to fill pageSizeMultiplier viewports
    const calculatedPageSize = Math.round(entriesPerViewport * pageSizeMultiplier);
    const pageSize = Math.min(maxPageSize, Math.max(minPageSize, calculatedPageSize));

    // Root margin: trigger loading when rootMarginMultiplier viewports from bottom
    // This ensures smooth scrolling by loading well before reaching the end
    const rootMarginPx = Math.round(viewportHeight * rootMarginMultiplier);
    const rootMargin = `${rootMarginPx}px`;

    return {
      pageSize,
      rootMargin,
      isConfigured: true,
    };
  }, [
    isClient,
    viewportHeight,
    estimatedEntryHeight,
    defaultPageSize,
    pageSizeMultiplier,
    rootMarginMultiplier,
    minPageSize,
    maxPageSize,
  ]);

  return config;
}
