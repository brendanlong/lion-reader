/**
 * Unit tests for EntryListItem utility functions.
 *
 * Tests the getItemClasses function which determines CSS classes
 * based on read and selected state.
 */

import { describe, it, expect } from "vitest";
import { getItemClasses } from "@/components/entries/EntryListItem";

describe("getItemClasses", () => {
  const baseClasses =
    "group relative cursor-pointer rounded-lg border p-3 transition-colors sm:p-4";

  describe("unread, not selected", () => {
    it("returns unread styling classes", () => {
      const classes = getItemClasses(false, false);

      expect(classes).toContain(baseClasses);
      // Unread stands out: raised surface card with a distinctly stronger border
      expect(classes).toContain("border-edge-input");
      expect(classes).toContain("bg-surface");
      expect(classes).toContain("hover:bg-surface-muted");
      expect(classes).toContain("active:bg-zinc-100");
      // Dark mode variants (active press step is still a raw pair)
      expect(classes).toContain("dark:active:bg-zinc-700");
      // E-paper (all fills white) leans on a darker border for card separation
      expect(classes).toContain("epaper:border-zinc-500");
    });
  });

  describe("read, not selected", () => {
    it("returns read styling classes", () => {
      const classes = getItemClasses(true, false);

      expect(classes).toContain(baseClasses);
      // Read recedes into the page canvas with a faint hairline border
      expect(classes).toContain("border-edge");
      expect(classes).toContain("bg-canvas");
      // Lifts to a surface fill on hover to signal it's still clickable
      expect(classes).toContain("hover:bg-surface");
      expect(classes).toContain("active:bg-surface-muted");
    });
  });

  describe("unread, selected", () => {
    it("returns selected styling with unread background", () => {
      const classes = getItemClasses(false, true);

      expect(classes).toContain(baseClasses);
      // Selected state has accent ring
      expect(classes).toContain("border-accent");
      expect(classes).toContain("ring-2");
      expect(classes).toContain("ring-accent");
      expect(classes).toContain("ring-offset-1");
      // Unread background within selected state (raised surface)
      expect(classes).toContain("bg-surface");
      // Dark mode variants
      expect(classes).toContain("dark:ring-offset-zinc-900");
    });
  });

  describe("read, selected", () => {
    it("returns selected styling with read background", () => {
      const classes = getItemClasses(true, true);

      expect(classes).toContain(baseClasses);
      // Selected state has accent ring
      expect(classes).toContain("border-accent");
      expect(classes).toContain("ring-2");
      expect(classes).toContain("ring-accent");
      expect(classes).toContain("ring-offset-1");
      // Read background within selected state recedes into the canvas
      expect(classes).toContain("bg-canvas");
      // Dark mode variants
      expect(classes).toContain("dark:ring-offset-zinc-900");
    });
  });

  describe("selected state priority", () => {
    it("prioritizes selected styling over read/unread styling", () => {
      const selectedUnread = getItemClasses(false, true);
      const selectedRead = getItemClasses(true, true);

      // Both should have the accent ring (selected indicator)
      expect(selectedUnread).toContain("ring-accent");
      expect(selectedRead).toContain("ring-accent");

      // Neither should have hover states that conflict with selection
      expect(selectedUnread).not.toContain("hover:bg-surface-muted");
      expect(selectedRead).not.toContain("hover:bg-surface");
    });
  });
});
