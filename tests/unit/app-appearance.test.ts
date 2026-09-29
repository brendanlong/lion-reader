import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_APPEARANCE_PATH, renderAppAppearance } from "../../scripts/export-app-appearance";

describe("native app appearance tokens", () => {
  it("match the web's appearance config (run `pnpm app:appearance`)", () => {
    expect(readFileSync(APP_APPEARANCE_PATH, "utf8")).toBe(renderAppAppearance());
  });
});
