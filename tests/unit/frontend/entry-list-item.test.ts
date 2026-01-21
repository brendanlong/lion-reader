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
      // Unread has darker border and background
      expect(classes).toContain("border-zinc-300");
      expect(classes).toContain("bg-zinc-50");
      expect(classes).toContain("hover:bg-zinc-100");
      expect(classes).toContain("active:bg-zinc-200");
      // Dark mode variants
      expect(classes).toContain("dark:border-zinc-700");
      expect(classes).toContain("dark:bg-zinc-800");
    });
  });

  describe("read, not selected", () => {
    it("returns read styling classes", () => {
      const classes = getItemClasses(true, false);

      expect(classes).toContain(baseClasses);
      // Read has lighter border and white background
      expect(classes).toContain("border-zinc-200");
      expect(classes).toContain("bg-white");
      expect(classes).toContain("hover:bg-zinc-50");
      expect(classes).toContain("active:bg-zinc-100");
      // Dark mode variants
      expect(classes).toContain("dark:border-zinc-800");
      expect(classes).toContain("dark:bg-zinc-900");
    });
  });

  describe("unread, selected", () => {
    it("returns selected styling with unread background", () => {
      const classes = getItemClasses(false, true);

      expect(classes).toContain(baseClasses);
      // Selected state has blue ring
      expect(classes).toContain("border-blue-500");
      expect(classes).toContain("ring-2");
      expect(classes).toContain("ring-blue-500");
      expect(classes).toContain("ring-offset-1");
      // Unread background within selected state
      expect(classes).toContain("bg-zinc-50");
      // Dark mode variants
      expect(classes).toContain("dark:border-blue-400");
      expect(classes).toContain("dark:ring-blue-400");
      expect(classes).toContain("dark:bg-zinc-800");
    });
  });

  describe("read, selected", () => {
    it("returns selected styling with read background", () => {
      const classes = getItemClasses(true, true);

      expect(classes).toContain(baseClasses);
      // Selected state has blue ring
      expect(classes).toContain("border-blue-500");
      expect(classes).toContain("ring-2");
      expect(classes).toContain("ring-blue-500");
      expect(classes).toContain("ring-offset-1");
      // Read background within selected state
      expect(classes).toContain("bg-white");
      // Dark mode variants
      expect(classes).toContain("dark:border-blue-400");
      expect(classes).toContain("dark:ring-blue-400");
      expect(classes).toContain("dark:bg-zinc-900");
    });
  });

  describe("selected state priority", () => {
    it("prioritizes selected styling over read/unread styling", () => {
      const selectedUnread = getItemClasses(false, true);
      const selectedRead = getItemClasses(true, true);

      // Both should have the blue ring (selected indicator)
      expect(selectedUnread).toContain("ring-blue-500");
      expect(selectedRead).toContain("ring-blue-500");

      // Neither should have hover states that conflict with selection
      expect(selectedUnread).not.toContain("hover:bg-zinc-100");
      expect(selectedRead).not.toContain("hover:bg-zinc-50");
    });
  });
});
