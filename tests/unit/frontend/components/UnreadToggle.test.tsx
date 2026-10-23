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
    it("names the 'Unread only' state in its tooltip", () => {
      render(<UnreadToggle showUnreadOnly={true} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("title", "Unread only");
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
  });

  describe("showUnreadOnly=false state", () => {
    it("names the 'Show all' state in its tooltip", () => {
      render(<UnreadToggle showUnreadOnly={false} onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("title", "Show all");
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
