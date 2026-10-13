/**
 * Unit tests for EntryListItem utility functions.
 *
 * Tests the getItemClasses function which determines CSS classes based on read
 * state (density is styled by CSS variants; tests/e2e/ssr-entry-list.spec.ts
 * renders it). Selection is intentionally NOT reflected here: the keyboard
 * cursor and Tab focus are unified onto the browser's single `:focus-visible`
 * outline (the selected row is the focused row), so getItemClasses must never
 * emit a ring/border of its own.
 */

import { describe, it, expect } from "vitest";
import { getItemClasses } from "@/components/entries/entryItemClasses";

describe("getItemClasses", () => {
  const baseClasses = "group relative cursor-pointer transition-colors";

  describe("unread", () => {
    it("returns unread styling classes", () => {
      const classes = getItemClasses(false);

      expect(classes).toContain(baseClasses);
      // Unread stands out: raised surface card with a distinctly stronger border
      expect(classes).toContain("comfortable:border-edge-input");
      expect(classes).toContain("bg-surface");
      expect(classes).toContain("hover:bg-surface-muted");
      expect(classes).toContain("active:bg-zinc-100");
      // Press step is intentionally a raw zinc pair (one step darker than surface-muted hover)
      expect(classes).toContain("dark:active:bg-zinc-700");
      // E-paper: unread keeps the theme's black edge (no e-paper override)
      expect(classes).not.toContain("epaper:border");
    });
  });

  describe("read", () => {
    it("returns read styling classes", () => {
      const classes = getItemClasses(true);

      expect(classes).toContain(baseClasses);
      // Read recedes into the page canvas with a faint hairline border. E-paper
      // paints every edge black, so the hairline there is the theme's gray level.
      expect(classes).toContain("comfortable:border-edge");
      expect(classes).toContain("comfortable:epaper:border-fill-muted");
      expect(classes).toContain("bg-canvas");
      // Lifts to a surface fill on hover to signal it's still clickable
      expect(classes).toContain("hover:bg-surface");
      expect(classes).toContain("active:bg-surface-muted");
    });
  });

  describe("selection is the focus outline, not a class", () => {
    it("never emits a ring or accent border in either read state", () => {
      for (const read of [false, true]) {
        const classes = getItemClasses(read);
        expect(classes).not.toContain("ring-2");
        expect(classes).not.toContain("ring-accent");
        expect(classes).not.toContain("ring-offset");
        expect(classes).not.toContain("border-accent");
        // And no per-component focus utilities (the global :focus-visible
        // outline is the only focus/selection indicator).
        expect(classes).not.toContain("focus:");
      }
    });
  });
});
