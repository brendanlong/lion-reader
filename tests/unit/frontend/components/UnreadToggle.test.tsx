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
    [true, "true"],
    [false, "false"],
  ] as const)("with showUnreadOnly=%s, is pressed=%s", (showUnreadOnly, pressed) => {
    render(<UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Unread only" })).toHaveAttribute(
      "aria-pressed",
      pressed
    );
  });

  describe("toggle callback", () => {
    it("calls onToggle when clicked", () => {
      const onToggle = vi.fn();
      render(<UnreadToggle showUnreadOnly={false} onToggle={onToggle} />);

      fireEvent.click(screen.getByRole("button"));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });
});
