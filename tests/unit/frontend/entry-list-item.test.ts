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
      // Press step is intentionally a raw zinc pair (one step darker than surface-muted hover)
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
      // Ring-offset uses the surface token (was dark:ring-offset-zinc-900)
      expect(classes).toContain("ring-offset-surface");
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
      // Ring-offset uses the surface token (was dark:ring-offset-zinc-900)
      expect(classes).toContain("ring-offset-surface");
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

  describe("compact density", () => {
    it("defaults to comfortable when density is omitted", () => {
      // The explicit "comfortable" and the default must produce identical output.
      expect(getItemClasses(false, false)).toBe(getItemClasses(false, false, "comfortable"));
      expect(getItemClasses(true, true)).toBe(getItemClasses(true, true, "comfortable"));
    });

    it("drops the per-card border and rounding but keeps the color language", () => {
      const unread = getItemClasses(false, false, "compact");
      const read = getItemClasses(true, false, "compact");

      // Borderless rows: the surrounding list supplies divide-edge separators.
      expect(unread).not.toContain("rounded-lg");
      expect(unread).not.toContain(" border ");
      expect(unread).not.toContain("border-edge-input");
      // The e-paper per-card border fallback is dropped (dividers separate rows).
      expect(unread).not.toContain("epaper:border-zinc-500");
      expect(read).not.toContain("border-edge");

      // Tighter vertical padding for more items per screen.
      expect(unread).toContain("py-2.5");
      expect(unread).not.toContain("p-3");

      // Unread/read background language is unchanged.
      expect(unread).toContain("bg-surface");
      expect(unread).toContain("hover:bg-surface-muted");
      expect(read).toContain("bg-canvas");
      expect(read).toContain("hover:bg-surface");
    });

    it("keeps the selection ring but no border in compact", () => {
      const selected = getItemClasses(false, true, "compact");

      expect(selected).toContain("ring-2");
      expect(selected).toContain("ring-accent");
      expect(selected).not.toContain("border-accent");
      expect(selected).toContain("bg-surface");
    });
  });
});
