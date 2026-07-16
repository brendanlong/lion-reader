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

  it("runs a real argon2 verify on the absent-hash path (timing equalization, #1267)", async () => {
    // The whole point of the null path is to still pay the argon2 cost so a
    // missing/passwordless user isn't measurably faster than a real check. We
    // can't assert absolute latency reliably, but the decoy verify should take
    // meaningfully longer than a bare early return, and comparably to a real
    // verify against a stored hash.
    const hash = await argon2.hash("some password");

    const startReal = process.hrtime.bigint();
    await verifyPassword(hash, "wrong password");
    const realMs = Number(process.hrtime.bigint() - startReal) / 1e6;

    const startDecoy = process.hrtime.bigint();
    await verifyPassword(null, "wrong password");
    const decoyMs = Number(process.hrtime.bigint() - startDecoy) / 1e6;

    // argon2 with default params is many milliseconds; a skipped verify would
    // be sub-millisecond. Assert the decoy path is in the same ballpark as a
    // real verify (at least a quarter of it) rather than near-instant.
    expect(decoyMs).toBeGreaterThan(realMs / 4);
  });
});
