/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for PageLink component.
 *
 * PageLink renders a plain <a> for full-page navigation to standalone routes
 * outside the SPA shell. The contract that matters: it is a real anchor with the
 * given href (so the browser does a full document navigation, not a Next.js RSC
 * soft-nav) and it forwards arbitrary anchor props through.
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
