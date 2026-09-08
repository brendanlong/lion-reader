/**
 * @vitest-environment jsdom
 */

/**
 * The app-relative location hooks let one reader tree run under two mount
 * points (the app root and `/demo`). These tests pin:
 *   - base stripping / prefixing (useAppPathname, useAppHref, ClientLink),
 *   - the prerendered-location override, which must hold through the hydration
 *     render and then release to the live URL.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";

let mockPathname = "/demo/tag/features";
let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// The override is released once hydration commits; emulate the server /
// hydration render by reporting "not hydrated".
let mockHydrated = true;
vi.mock("@/lib/hooks/useIsHydrated", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/useIsHydrated")>();
  return { ...actual, useIsHydrated: () => mockHydrated };
});

const { AppLocationProvider, useAppPathname, useAppSearchParams, useAppHref, useRouteBase } =
  await import("@/lib/hooks/useAppLocation");
const { ClientLink } = await import("@/components/ui/client-link");

function demo(children: ReactNode, ssrLocation?: { pathname: string; search: string }) {
  return (
    <AppLocationProvider basePath="/demo" ssrLocation={ssrLocation}>
      {children}
    </AppLocationProvider>
  );
}

beforeEach(() => {
  mockPathname = "/demo/tag/features";
  mockSearch = "";
  mockHydrated = true;
});

describe("useAppPathname", () => {
  it("returns the browser pathname unchanged with no provider (the app root)", () => {
    mockPathname = "/tag/features";
    expect(renderHook(() => useAppPathname()).result.current).toBe("/tag/features");
  });

  it("strips the route base under a mount", () => {
    const { result } = renderHook(() => useAppPathname(), {
      wrapper: ({ children }) => demo(children),
    });
    expect(result.current).toBe("/tag/features");
  });

  it("treats the bare base as the root and leaves unrelated paths alone", () => {
    mockPathname = "/demo";
    expect(
      renderHook(() => useAppPathname(), { wrapper: ({ children }) => demo(children) }).result
        .current
    ).toBe("/");
    mockPathname = "/demonstration";
    expect(
      renderHook(() => useAppPathname(), { wrapper: ({ children }) => demo(children) }).result
        .current
    ).toBe("/demonstration");
  });
});

describe("prerendered location override", () => {
  const ssr = { pathname: "/all", search: "entry=welcome" };

  it("reports the prerendered location until hydration has committed", () => {
    mockHydrated = false;
    mockPathname = "/demo/entry/welcome";
    const { result } = renderHook(() => [useAppPathname(), useAppSearchParams().get("entry")], {
      wrapper: ({ children }) => demo(children, ssr),
    });
    expect(result.current).toEqual(["/all", "welcome"]);
  });

  it("hands over to the live URL after hydration", () => {
    mockHydrated = true;
    mockPathname = "/demo/tag/features";
    mockSearch = "entry=tags";
    const { result } = renderHook(() => [useAppPathname(), useAppSearchParams().get("entry")], {
      wrapper: ({ children }) => demo(children, ssr),
    });
    expect(result.current).toEqual(["/tag/features", "tags"]);
  });
});

describe("hrefs", () => {
  it("useAppHref/useRouteBase prefix SPA-relative paths with the base", () => {
    const { result } = renderHook(() => [useRouteBase(), useAppHref()("/all?entry=x")] as const, {
      wrapper: ({ children }) => demo(children),
    });
    expect(result.current).toEqual(["/demo", "/demo/all?entry=x"]);
  });

  it("is a no-op prefix at the app root", () => {
    const { result } = renderHook(() => useAppHref()("/starred"));
    expect(result.current).toBe("/starred");
  });

  it("ClientLink renders the prefixed href but reports the SPA-relative one to callbacks", () => {
    const onNavigate = vi.fn();
    render(
      demo(
        <ClientLink href="/starred" onNavigate={onNavigate}>
          Starred
        </ClientLink>
      )
    );
    const link = screen.getByRole("link", { name: "Starred" });
    expect(link).toHaveAttribute("href", "/demo/starred");

    const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
    link.click();
    expect(pushState).toHaveBeenCalledWith(null, "", "/demo/starred");
    expect(onNavigate).toHaveBeenCalledWith("/starred");
    pushState.mockRestore();
  });
});
