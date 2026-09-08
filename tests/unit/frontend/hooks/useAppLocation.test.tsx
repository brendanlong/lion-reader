/**
 * @vitest-environment jsdom
 */

/**
 * The app-relative location hooks let one reader tree run under two mount
 * points (the app root and `/demo`). These tests pin:
 *   - base stripping / prefixing (useAppPathname, useAppHref, ClientLink),
 *   - the prerendered-location override, which holds while the mount supplies
 *     it and releases to the live URL when it is cleared.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { PrerenderedCacheProvider, useCanRenderFromCache } from "@/lib/hooks/useIsHydrated";

let mockPathname = "/demo/tag/features";
let mockSearch = "";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const { AppLocationProvider, useAppPathname, useAppSearchParams, useAppHref, useRouteBase } =
  await import("@/lib/hooks/useAppLocation");
const { ClientLink } = await import("@/components/ui/client-link");

function demo(children: ReactNode, ssrLocation?: { pathname: string; search: string } | null) {
  return (
    <AppLocationProvider basePath="/demo" ssrLocation={ssrLocation}>
      {children}
    </AppLocationProvider>
  );
}

beforeEach(() => {
  mockPathname = "/demo/tag/features";
  mockSearch = "";
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

  it("reports the prerendered location while the mount supplies it", () => {
    mockPathname = "/demo/entry/welcome";
    const { result } = renderHook(() => [useAppPathname(), useAppSearchParams().get("entry")], {
      wrapper: ({ children }) => demo(children, ssr),
    });
    expect(result.current).toEqual(["/all", "welcome"]);
  });

  it("hands over to the live URL once it is cleared", () => {
    mockPathname = "/demo/tag/features";
    mockSearch = "entry=tags";
    function Probe() {
      return (
        <span data-testid="loc">{`${useAppPathname()}|${useAppSearchParams().get("entry")}`}</span>
      );
    }
    const { rerender } = render(demo(<Probe />, ssr));
    expect(screen.getByTestId("loc")).toHaveTextContent("/all|welcome");
    rerender(demo(<Probe />, null));
    expect(screen.getByTestId("loc")).toHaveTextContent("/tag/features|tags");
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

describe("useCanRenderFromCache", () => {
  it("is true from the first render under a PrerenderedCacheProvider", () => {
    // Outside the provider it tracks hydration (true here: the hook mounts
    // client-side in jsdom, with no hydration pass).
    const plain = renderHook(() => useCanRenderFromCache());
    expect(plain.result.current).toBe(true);

    const seen: boolean[] = [];
    renderHook(
      () => {
        seen.push(useCanRenderFromCache());
      },
      { wrapper: ({ children }) => <PrerenderedCacheProvider>{children}</PrerenderedCacheProvider> }
    );
    expect(seen[0]).toBe(true);
  });
});
