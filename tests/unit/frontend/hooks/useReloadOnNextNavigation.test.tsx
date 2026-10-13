/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReloadOnNextNavigation } from "@/lib/hooks/useReloadOnNextNavigation";

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

  it("reloads when unmounted while armed, as leaving its layout", () => {
    const { rerender, unmount } = renderHook((armed: boolean) => useReloadOnNextNavigation(armed), {
      initialProps: true,
    });
    rerender(true);
    expect(reload).not.toHaveBeenCalled();
    unmount();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("doesn't reload when unmounted unarmed", () => {
    renderHook(() => useReloadOnNextNavigation(false)).unmount();
    expect(reload).not.toHaveBeenCalled();
  });
});
