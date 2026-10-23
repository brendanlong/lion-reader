/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for UnreadToggle component.
 *
 * Tests the toggle button for showing/hiding read entries.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnreadToggle } from "@/components/entries/UnreadToggle";

describe("UnreadToggle", () => {
  it.each([
    [true, "Unread only", "Show read items", "false"],
    [false, "Show all", "Hide read items", "true"],
  ] as const)(
    "with showUnreadOnly=%s, names the %s state in its tooltip and offers to %s",
    (showUnreadOnly, title, ariaLabel, pressed) => {
      render(<UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={vi.fn()} />);
      const button = screen.getByRole("button", { name: ariaLabel });
      expect(button).toHaveAttribute("title", title);
      expect(button).toHaveAttribute("aria-pressed", pressed);
    }
  );

  describe("toggle callback", () => {
    it("calls onToggle when clicked", () => {
      const onToggle = vi.fn();
      render(<UnreadToggle showUnreadOnly={false} onToggle={onToggle} />);

      fireEvent.click(screen.getByRole("button"));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe("styling", () => {
    it("applies custom className", () => {
      render(<UnreadToggle showUnreadOnly={false} onToggle={vi.fn()} className="custom-class" />);
      expect(screen.getByRole("button")).toHaveClass("custom-class");
    });
  });
});
