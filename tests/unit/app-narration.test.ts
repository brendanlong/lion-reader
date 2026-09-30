import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_NARRATION_PATH, renderAppNarration } from "../../scripts/export-app-narration";

describe("native app narration script", () => {
  it("is built from the web's narration code (run `pnpm app:narration`)", () => {
    expect(readFileSync(APP_NARRATION_PATH, "utf8")).toBe(renderAppNarration());
  });
});
