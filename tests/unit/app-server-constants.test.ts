import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  APP_SERVER_CONSTANTS_PATH,
  renderAppServerConstants,
} from "../../scripts/export-app-server-constants";

describe("native app server constants", () => {
  it("match the server's (run `pnpm app:server-constants`)", () => {
    expect(readFileSync(APP_SERVER_CONSTANTS_PATH, "utf8")).toBe(renderAppServerConstants());
  });
});
