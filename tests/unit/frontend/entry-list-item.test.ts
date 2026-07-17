/**
 * Unit tests for EntryListItem utility functions.
 *
 * Tests the getItemClasses function which determines CSS classes based on read
 * state and density. Selection is intentionally NOT reflected here: the keyboard
 * cursor and Tab focus are unified onto the browser's single `:focus-visible`
 * outline (the selected row is the focused row), so getItemClasses must never
 * emit a ring/border of its own.
 */

import { describe, it, expect } from "vitest";
import { getItemClasses } from "@/components/entries/entryItemClasses";

describe("getItemClasses", () => {
  const baseClasses =
    "group relative cursor-pointer rounded-lg border p-3 transition-colors sm:p-4";

  describe("unread", () => {
    it("returns unread styling classes", () => {
      const classes = getItemClasses(false);

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

  describe("read", () => {
    it("returns read styling classes", () => {
      const classes = getItemClasses(true);

      expect(classes).toContain(baseClasses);
      // Read recedes into the page canvas with a faint hairline border
      expect(classes).toContain("border-edge");
      expect(classes).toContain("bg-canvas");
      // Lifts to a surface fill on hover to signal it's still clickable
      expect(classes).toContain("hover:bg-surface");
      expect(classes).toContain("active:bg-surface-muted");
    });
  });

  describe("selection is the focus outline, not a class", () => {
    it("never emits a ring or accent border in any density/read combination", () => {
      for (const read of [false, true]) {
        for (const density of ["comfortable", "compact"] as const) {
          const classes = getItemClasses(read, density);
          expect(classes).not.toContain("ring-2");
          expect(classes).not.toContain("ring-accent");
          expect(classes).not.toContain("ring-offset");
          expect(classes).not.toContain("border-accent");
          // And no per-component focus utilities (the global :focus-visible
          // outline is the only focus/selection indicator).
          expect(classes).not.toContain("focus:");
        }
      }
    });
  });

  describe("compact density", () => {
    it("defaults to comfortable when density is omitted", () => {
      // The explicit "comfortable" and the default must produce identical output.
      expect(getItemClasses(false)).toBe(getItemClasses(false, "comfortable"));
      expect(getItemClasses(true)).toBe(getItemClasses(true, "comfortable"));
    });

    it("drops the per-card border and rounding but keeps the color language", () => {
      const unread = getItemClasses(false, "compact");
      const read = getItemClasses(true, "compact");

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
  });
});
