/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for PageLink component.
 *
 * PageLink wraps `<Link prefetch={false}>` for navigation to standalone routes
 * outside the SPA shell. The contract that matters here: it renders a real anchor
 * with the given href (so browser affordances like open-in-new-tab work) and it
 * forwards arbitrary anchor props through. The prefetch={false} / soft-nav
 * behavior is a Next.js concern exercised in the browser, not asserted in jsdom.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageLink } from "@/components/ui/page-link";

describe("PageLink", () => {
  it("renders a plain anchor with the given href and children", () => {
    render(<PageLink href="/login">Sign in</PageLink>);
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/login");
  });

  it("forwards className and arbitrary anchor attributes", () => {
    render(
      <PageLink href="/register" className="text-body" aria-label="Create an account">
        Create one
      </PageLink>
    );
    const link = screen.getByRole("link");
    expect(link.className).toContain("text-body");
    expect(link).toHaveAttribute("aria-label", "Create an account");
  });
});
