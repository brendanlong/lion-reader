/**
 * Unit tests for the Postgres error helpers.
 *
 * `isDisconnectError` decides whether an error raised on an idle pool connection
 * is reported to Sentry, so both directions matter: routine disconnects must be
 * recognized (or Sentry drowns in them), and anything else must not be.
 */

import { describe, it, expect } from "vitest";
import { isUniqueViolation, isDisconnectError } from "../../src/server/db/errors";

/** Builds an Error carrying a `code`, the way `pg` surfaces SQLSTATE and socket errors. */
function errorWithCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("isUniqueViolation", () => {
  it("detects a direct unique violation", () => {
    expect(isUniqueViolation(errorWithCode("duplicate key", "23505"))).toBe(true);
  });

  it("detects a unique violation wrapped by Drizzle", () => {
    const wrapped = new Error("Failed query", { cause: errorWithCode("duplicate key", "23505") });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("ignores other Postgres errors and non-errors", () => {
    expect(isUniqueViolation(errorWithCode("not null", "23502"))).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe("isDisconnectError", () => {
  it("detects the message pg synthesizes when the far end hangs up", () => {
    // pg attaches no `code` to this one, so the message is all we have to match on.
    expect(isDisconnectError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("detects socket teardown", () => {
    expect(isDisconnectError(errorWithCode("read ECONNRESET", "ECONNRESET"))).toBe(true);
    expect(isDisconnectError(errorWithCode("write EPIPE", "EPIPE"))).toBe(true);
    expect(isDisconnectError(errorWithCode("timeout", "ETIMEDOUT"))).toBe(true);
  });

  it("detects a server-side connection termination", () => {
    expect(
      isDisconnectError(
        errorWithCode("terminating connection due to administrator command", "57P01")
      )
    ).toBe(true);
  });

  it("does not treat an ordinary query error as a disconnect", () => {
    expect(isDisconnectError(errorWithCode("duplicate key", "23505"))).toBe(false);
    expect(isDisconnectError(errorWithCode("out of memory", "53200"))).toBe(false);
  });

  it("does not treat an unrecognized error as a disconnect", () => {
    expect(isDisconnectError(new Error("Connection terminated"))).toBe(false);
    expect(isDisconnectError(new Error("something went wrong"))).toBe(false);
  });
});
