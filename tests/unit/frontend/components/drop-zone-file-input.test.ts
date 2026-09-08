/**
 * The class string shared by every file input that covers a drop zone.
 *
 * Both drop zones render this one string, so the properties that make the zone
 * keyboard-usable are pinned here rather than re-asserted per component: the
 * component tests cover what is theirs (the input is rendered, named, and in
 * the tab order).
 */

import { describe, it, expect } from "vitest";
import { DROP_ZONE_FILE_INPUT_CLASSES } from "@/components/ui/drop-zone-file-input";

const classes = DROP_ZONE_FILE_INPUT_CLASSES.split(/\s+/);

describe("DROP_ZONE_FILE_INPUT_CLASSES", () => {
  it("hides the input without hiding its focus outline", () => {
    // `opacity-0` paints the outline away too, leaving a focusable control with
    // no focus indicator (#1571, #1573); `hidden` (display: none) would drop it
    // out of the tab order entirely. The input is hidden with transparent text
    // plus `file:hidden` on its file-selector button instead.
    expect(classes).not.toContain("opacity-0");
    expect(classes).not.toContain("hidden");
    expect(classes).toContain("text-transparent");
    expect(classes).toContain("file:hidden");
  });

  it("stretches the input over the whole zone", () => {
    // A file input is a replaced element, so `inset-0` alone leaves it at its
    // intrinsic width and only part of the zone is clickable.
    expect(classes).toEqual(expect.arrayContaining(["absolute", "inset-0", "h-full", "w-full"]));
  });

  it("adds no per-component focus styling", () => {
    // The global :focus-visible outline is the only focus indicator (#1292).
    expect(classes.filter((c) => c.startsWith("focus:"))).toEqual([]);
  });
});
