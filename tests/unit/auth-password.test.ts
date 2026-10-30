import { describe, it, expect } from "vitest";
import * as argon2 from "argon2";

import { verifyPassword } from "@/server/auth/password";

describe("verifyPassword", () => {
  it("returns true for a matching password", async () => {
    const hash = await argon2.hash("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
  });

  it("returns false for a non-matching password", async () => {
    const hash = await argon2.hash("correct horse battery staple");
    expect(await verifyPassword(hash, "wrong password")).toBe(false);
  });

  it("returns false (without throwing) when the stored hash is null", async () => {
    expect(await verifyPassword(null, "any password")).toBe(false);
  });

  it("returns false (without throwing) when the stored hash is undefined", async () => {
    expect(await verifyPassword(undefined, "any password")).toBe(false);
  });
});
