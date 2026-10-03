/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for client-side navigation helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MouseEvent } from "react";
import { handleClientNav, handleContentLinkClick } from "@/lib/navigation";

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

describe("handleContentLinkClick", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/demo/all?entry=welcome");
    document.body.innerHTML = "";
  });

  /** Clicks a link rendered inside article content mounted at `basePath`; returns whether the browser was left to handle it. */
  function clickContentLink(
    html: string,
    basePath: string,
    init: MouseEventInit = {}
  ): { browserHandled: boolean } {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    container.addEventListener("click", (e) => handleContentLinkClick(e, basePath));
    const target = container.querySelector("a span") ?? container.querySelector("a")!;
    const event = new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return { browserHandled: !event.defaultPrevented };
  }

  it("soft-navigates a link to another entry inside the mount, from a nested element", () => {
    const result = clickContentLink(
      '<p><a href="/demo/all?entry=opml"><span>imports</span></a></p>',
      "/demo"
    );

    expect(result.browserHandled).toBe(false);
    expect(window.location.pathname + window.location.search).toBe("/demo/all?entry=opml");
  });

  it("soft-navigates dynamic entry-list routes in the root mount", () => {
    const result = clickContentLink('<a href="/tag/abc?entry=x">tag</a>', "");

    expect(result.browserHandled).toBe(false);
    expect(window.location.pathname + window.location.search).toBe("/tag/abc?entry=x");
  });

  it.each([
    ["another origin", '<a href="https://example.com/demo/all">x</a>', "/demo"],
    ["a route outside the mount", '<a href="/all?entry=x">x</a>', "/demo"],
    ["a standalone page in the root mount", '<a href="/login">x</a>', ""],
    ["a hash-only change (footnote)", '<a href="#fn1">x</a>', "/demo"],
    ["target=_blank", '<a href="/demo/all?entry=opml" target="_blank">x</a>', "/demo"],
  ])("leaves %s to the browser", (_label, html, basePath) => {
    const result = clickContentLink(html, basePath);

    expect(result.browserHandled).toBe(true);
    expect(window.location.pathname + window.location.search).toBe("/demo/all?entry=welcome");
  });

  it("leaves a click another handler already claimed alone", () => {
    const container = document.createElement("div");
    container.innerHTML = '<a href="/demo/all?entry=opml">x</a>';
    document.body.appendChild(container);
    container.querySelector("a")!.addEventListener("click", (e) => e.preventDefault());
    container.addEventListener("click", (e) => handleContentLinkClick(e, "/demo"));

    container.querySelector("a")!.click();

    expect(window.location.pathname + window.location.search).toBe("/demo/all?entry=welcome");
  });

  it("doesn't push a duplicate history entry for a link to the current page", () => {
    const lengthBefore = window.history.length;

    const result = clickContentLink('<a href="/demo/all?entry=welcome">x</a>', "/demo");

    expect(result.browserHandled).toBe(false);
    expect(window.history.length).toBe(lengthBefore);
  });
});
