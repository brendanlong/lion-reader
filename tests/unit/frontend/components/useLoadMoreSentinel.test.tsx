/**
 * @vitest-environment jsdom
 */

/**
 * useLoadMoreSentinel fetches the next page when its sentinel nears the view,
 * including a sentinel that mounts after the hook (a list whose first entries
 * arrive later).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useLoadMoreSentinel } from "@/components/ui/infinite-scroll-footer";

/** The browser's observer, recording what's observed so a test can scroll it into view. */
class RecordingIntersectionObserver {
  static instances: RecordingIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    RecordingIntersectionObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observed.add(element);
  }
  unobserve(element: Element) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
  takeRecords() {
    return [];
  }
}

/** Brings `element` into view for every observer watching it. */
function scrollIntoView(element: Element) {
  for (const observer of RecordingIntersectionObserver.instances) {
    if (!observer.observed.has(element)) continue;
    const entry = { isIntersecting: true, target: element } as IntersectionObserverEntry;
    observer["callback"]([entry], observer as unknown as IntersectionObserver);
  }
}

function List({
  showSentinel,
  fetchNextPage,
}: {
  showSentinel: boolean;
  fetchNextPage: () => void;
}) {
  const sentinelRef = useLoadMoreSentinel<HTMLDivElement>({
    hasNextPage: true,
    isFetchingNextPage: false,
    fetchNextPage,
  });
  return showSentinel ? <div data-testid="sentinel" ref={sentinelRef} /> : <p>No entries</p>;
}

describe("useLoadMoreSentinel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    RecordingIntersectionObserver.instances = [];
  });

  it("observes a sentinel that mounts after the hook, and fetches when it comes into view", () => {
    vi.stubGlobal("IntersectionObserver", RecordingIntersectionObserver);
    const fetchNextPage = vi.fn();
    const { rerender, getByTestId } = render(
      <List showSentinel={false} fetchNextPage={fetchNextPage} />
    );

    rerender(<List showSentinel fetchNextPage={fetchNextPage} />);
    act(() => scrollIntoView(getByTestId("sentinel")));

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
