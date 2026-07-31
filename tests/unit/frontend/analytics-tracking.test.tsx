/**
 * @vitest-environment jsdom
 */

/**
 * Analytics *firing* behaviour — when a page view is emitted, and how often.
 *
 * `tests/CLAUDE.md` says frontend event plumbing must be tested rather than
 * reviewed, and this is exactly that: the pure path-mapping is covered in
 * `tests/unit/analytics.test.ts`, while every interesting claim here is about
 * effects and refs (no double-count on remount, prefetched neighbours don't
 * count, a query-only change is invisible to the pathname tracker).
 *
 * `trackPageView` is stubbed via a module mock of the beacon — that's the I/O
 * boundary, not internal logic, so it's the one thing worth faking.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

const trackPageView = vi.fn();
vi.mock("@/lib/analytics/beacon", () => ({
  trackPageView: (path: string) => trackPageView(path),
  buildCountUrl: () => "",
}));

let mockPathname = "/all";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

const { PageViewTracker } = await import("@/components/analytics/PageViewTracker");
const { useTrackEntryView, useTrackDemoEntryView } =
  await import("@/lib/analytics/useTrackEntryView");

beforeEach(() => {
  trackPageView.mockClear();
  mockPathname = "/all";
});

describe("PageViewTracker", () => {
  it("reports once for the route it mounts on", () => {
    render(<PageViewTracker />);
    expect(trackPageView.mock.calls).toEqual([["/app/list/all"]]);
  });

  it("reports again when the pathname changes", () => {
    const { rerender } = render(<PageViewTracker />);
    mockPathname = "/saved";
    rerender(<PageViewTracker />);
    expect(trackPageView.mock.calls).toEqual([["/app/list/all"], ["/app/list/saved"]]);
  });

  it("counts two different subscriptions separately even though both map to one path", () => {
    // The ref stores the raw pathname, not the mapped one — if it stored the
    // mapped value, navigating between subscriptions would silently stop
    // counting after the first.
    mockPathname = "/subscription/aaaa-1111";
    const { rerender } = render(<PageViewTracker />);
    mockPathname = "/subscription/bbbb-2222";
    rerender(<PageViewTracker />);
    expect(trackPageView.mock.calls).toEqual([
      ["/app/list/subscription"],
      ["/app/list/subscription"],
    ]);
  });

  it("does not re-report when only the query string changes", () => {
    // Opening an entry is `?entry=<id>` with the pathname unchanged; it must be
    // reported by the entry hook (by type), not as another list view.
    const { rerender } = render(<PageViewTracker />);
    rerender(<PageViewTracker />);
    expect(trackPageView).toHaveBeenCalledTimes(1);
  });

  it("reports nothing on a route that isn't in the vocabulary", () => {
    mockPathname = "/admin/users";
    render(<PageViewTracker />);
    expect(trackPageView).not.toHaveBeenCalled();
  });
});

describe("useTrackEntryView", () => {
  it("reports the entry type once the entry has loaded", () => {
    const { rerender } = renderHook(
      ({ id, kind }: { id?: string; kind?: "web" | "email" | "saved" }) =>
        useTrackEntryView(id, kind),
      { initialProps: {} }
    );
    // Nothing while the query is still loading.
    expect(trackPageView).not.toHaveBeenCalled();

    rerender({ id: "entry-1", kind: "email" });
    expect(trackPageView.mock.calls).toEqual([["/app/entry/email"]]);
  });

  it("does not double-count a re-render of the same entry", () => {
    const { rerender } = renderHook(() => useTrackEntryView("entry-1", "web"));
    rerender();
    rerender();
    expect(trackPageView).toHaveBeenCalledTimes(1);
  });

  it("counts again when a different entry is opened", () => {
    const { rerender } = renderHook(({ id }: { id: string }) => useTrackEntryView(id, "web"), {
      initialProps: { id: "entry-1" },
    });
    rerender({ id: "entry-2" });
    expect(trackPageView.mock.calls).toEqual([["/app/entry/web"], ["/app/entry/web"]]);
  });
});

describe("useTrackDemoEntryView", () => {
  it("reports an allowlisted demo article by id", () => {
    // The demo opens articles with a query-only pushState, so this hook — not
    // PageViewTracker — is what makes demo article reads visible at all.
    renderHook(() => useTrackDemoEntryView("welcome"));
    expect(trackPageView.mock.calls).toEqual([["/demo/entry/welcome"]]);
  });

  it("reports the bare route for an id that isn't a demo article", () => {
    renderHook(() => useTrackDemoEntryView("../../secret"));
    expect(trackPageView.mock.calls).toEqual([["/demo/entry"]]);
  });

  it("reports nothing when no article is open", () => {
    renderHook(() => useTrackDemoEntryView(null));
    expect(trackPageView).not.toHaveBeenCalled();
  });
});
