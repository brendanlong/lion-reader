/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for client-side navigation helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MouseEvent } from "react";
import { handleClientNav, isSpaPath } from "@/lib/navigation";

interface FakeEventOptions {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
  target?: string | null;
  download?: boolean;
}

function makeEvent(opts: FakeEventOptions = {}): {
  event: MouseEvent<HTMLAnchorElement>;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  const anchor = {
    getAttribute: (name: string) => (name === "target" ? (opts.target ?? null) : null),
    hasAttribute: (name: string) => name === "download" && !!opts.download,
  };
  const event = {
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    button: opts.button ?? 0,
    currentTarget: anchor,
    preventDefault,
  } as unknown as MouseEvent<HTMLAnchorElement>;
  return { event, preventDefault };
}

describe("handleClientNav", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/start");
  });

  it("navigates via pushState on a plain primary click", () => {
    const { event, preventDefault } = makeEvent();
    const callback = vi.fn();

    handleClientNav(event, "/all", callback);

    expect(preventDefault).toHaveBeenCalled();
    expect(window.location.pathname).toBe("/all");
    expect(callback).toHaveBeenCalled();
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle-click", { button: 1 }],
  ])("falls through to the browser for %s clicks", (_label, opts) => {
    const { event, preventDefault } = makeEvent(opts);
    const callback = vi.fn();

    handleClientNav(event, "/all", callback);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/start");
    expect(callback).not.toHaveBeenCalled();
  });

  it("falls through for anchors with target=_blank", () => {
    const { event, preventDefault } = makeEvent({ target: "_blank" });

    handleClientNav(event, "/all");

    expect(preventDefault).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/start");
  });

  it("still navigates for target=_self", () => {
    const { event, preventDefault } = makeEvent({ target: "_self" });

    handleClientNav(event, "/all");

    expect(preventDefault).toHaveBeenCalled();
    expect(window.location.pathname).toBe("/all");
  });

  it("falls through for download anchors", () => {
    const { event, preventDefault } = makeEvent({ download: true });

    handleClientNav(event, "/file");

    expect(preventDefault).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/start");
  });
});

describe("isSpaPath", () => {
  it.each([
    "/all",
    "/save",
    "/settings",
    "/settings?tab=account",
    "/admin/overview",
    "/tag/123",
    "/subscription/abc#top",
    "/demo/all?entry=welcome",
    "/",
  ])("treats %s as an in-SPA path", (path) => {
    expect(isSpaPath(path)).toBe(true);
  });

  it.each([
    "/login",
    "/login?error=callback_failed",
    "/register",
    "/complete-signup",
    "/privacy",
    "/terms",
    "/auth/oauth/callback?code=x",
  ])("treats %s as a standalone (non-SPA) path", (path) => {
    expect(isSpaPath(path)).toBe(false);
  });

  it("does not match a prefix that is only a partial segment", () => {
    // "/registered" starts with "/register" as a string but is a different route.
    expect(isSpaPath("/registered")).toBe(true);
    expect(isSpaPath("/loginfoo")).toBe(true);
  });
});
