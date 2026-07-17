/**
 * ScrollContainerContext
 *
 * Provides a reference to the current scroll container for components
 * that need to observe scroll position (e.g., infinite scroll, image prefetch).
 *
 * This is needed because the app uses scrollable containers rather than
 * viewport scrolling, so IntersectionObserver needs to use the container
 * as its root instead of the viewport.
 *
 * Supports nesting: use ScrollContainer to create a nested scroll context
 * that overrides the parent for its children.
 */

"use client";

import {
  createContext,
  useContext,
  useRef,
  useCallback,
  type RefObject,
  type ReactNode,
} from "react";

type ScrollContainerContextValue = RefObject<HTMLElement | null>;

const ScrollContainerContext = createContext<ScrollContainerContextValue | null>(null);

/**
 * Hook to get the scroll container ref.
 * Returns null if not within a ScrollContainerProvider.
 */
export function useScrollContainer(): RefObject<HTMLElement | null> | null {
  return useContext(ScrollContainerContext);
}

interface ScrollContainerProviderProps {
  children: ReactNode;
}

/**
 * Provider that creates and exposes a ref to the scroll container.
 */
export function ScrollContainerProvider({ children }: ScrollContainerProviderProps) {
  const scrollRef = useRef<HTMLElement | null>(null);
  return (
    <ScrollContainerContext.Provider value={scrollRef}>{children}</ScrollContainerContext.Provider>
  );
}

interface MainScrollContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * The main scrollable container component (renders <main>).
 * Registers itself with the ScrollContainerContext so other components
 * (like infinite scroll) can use it as the IntersectionObserver root.
 */
export function MainScrollContainer({ children, className }: MainScrollContainerProps) {
  const contextRef = useContext(ScrollContainerContext);

  // Callback ref that sets both the context ref and handles the element
  const setRef = useCallback(
    (element: HTMLElement | null) => {
      if (contextRef) {
        contextRef.current = element;
      }
    },
    [contextRef]
  );

  return (
    // tabIndex={-1} keeps this scroll region out of the sequential tab order.
    // Firefox (and Chrome for childless scrollers) otherwise makes any scrollable
    // element keyboard-focusable, adding a stray tab stop that renders as a focus
    // outline "line" across the top of the content. The region is full of
    // focusable controls (buttons, entries), so a tab stop on the container
    // itself is redundant; keyboard users still reach and scroll it via those.
    <main ref={setRef} tabIndex={-1} className={className}>
      {children}
    </main>
  );
}

interface ScrollContainerProps {
  children: ReactNode;
  className?: string;
}

/**
 * A nested scrollable container that provides its own scroll context.
 * Use this for components that have their own scroll container (like EntryContent)
 * so that children can observe scroll position relative to this container.
 */
export function ScrollContainer({ children, className }: ScrollContainerProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <ScrollContainerContext.Provider value={scrollRef}>
      <div ref={scrollRef} className={className}>
        {children}
      </div>
    </ScrollContainerContext.Provider>
  );
}
