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
  describe("showUnreadOnly=true state", () => {
    it("displays 'Unread only' label when showUnreadOnly is true", () => {
      render(<UnreadToggle showUnreadOnly={true} onToggle={vi.fn()} />);
      expect(screen.getByText("Unread only")).toBeInTheDocument();
    });

    it("has aria-label 'Show read items' when showing unread only", () => {
      render(<UnreadToggle showUnreadOnly={true} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Show read items");
    });

    it("has aria-pressed='false' when showUnreadOnly is true", () => {
      // isPressed is !showUnreadOnly, so when showUnreadOnly=true, isPressed=false
      render(<UnreadToggle showUnreadOnly={true} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    });

    it("has title matching aria-label for tooltip", () => {
      render(<UnreadToggle showUnreadOnly={true} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("title", "Show read items");
    });
  });

  describe("showUnreadOnly=false state", () => {
    it("displays 'Show all' label when showUnreadOnly is false", () => {
      render(<UnreadToggle showUnreadOnly={false} onToggle={vi.fn()} />);
      expect(screen.getByText("Show all")).toBeInTheDocument();
    });

    it("has aria-label 'Hide read items' when showing all", () => {
      render(<UnreadToggle showUnreadOnly={false} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Hide read items");
    });

    it("has aria-pressed='true' when showUnreadOnly is false", () => {
      // isPressed is !showUnreadOnly, so when showUnreadOnly=false, isPressed=true
      render(<UnreadToggle showUnreadOnly={false} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    });
  });

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
