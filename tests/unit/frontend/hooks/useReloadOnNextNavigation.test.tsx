/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReloadOnNextNavigation } from "@/lib/hooks/useReloadOnNextNavigation";
import { isOtherBuild } from "@/lib/build-id";

const mockPathname = vi.fn(() => "/all");
vi.mock("next/navigation", () => ({ usePathname: () => mockPathname() }));

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  mockPathname.mockReturnValue("/all");
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

describe("useReloadOnNextNavigation", () => {
  it("reloads on the first navigation after it is armed", () => {
    const { rerender } = renderHook((armed: boolean) => useReloadOnNextNavigation(armed), {
      initialProps: false,
    });
    const navigate = (pathname: string, armed: boolean) => {
      mockPathname.mockReturnValue(pathname);
      rerender(armed);
    };
    navigate("/starred", false);
    expect(reload).not.toHaveBeenCalled();

    navigate("/starred", true);
    expect(reload).not.toHaveBeenCalled();

    navigate("/saved", true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("isOtherBuild", () => {
  it("is true only when both builds are known and differ", () => {
    expect(isOtherBuild("2026-10-13T01:00:00Z", "2026-10-12T01:00:00Z")).toBe(true);
    expect(isOtherBuild("2026-10-13T01:00:00Z", "2026-10-13T01:00:00Z")).toBe(false);
    expect(isOtherBuild(undefined, "2026-10-13T01:00:00Z")).toBe(false);
    expect(isOtherBuild("", "2026-10-13T01:00:00Z")).toBe(false);
    expect(isOtherBuild("2026-10-13T01:00:00Z", "")).toBe(false);
  });
});
