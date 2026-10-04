import { describe, it, expect } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { TRPCError } from "@trpc/server";
import { errors } from "../../src/server/trpc/errors";
import { toMcpError } from "../../src/server/mcp/tools";

describe("toMcpError", () => {
  it("forwards app errors' messages and codes for non-client tRPC codes (#1834)", () => {
    const rateLimited = errors.upstreamRateLimited("https://example.com/");
    expect(toMcpError(rateLimited)).toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining(rateLimited.message),
      data: { code: "UPSTREAM_RATE_LIMITED" },
    });
  });

  it("forwards hand-built service errors that carry a cause code", () => {
    const needsSignin = new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sign in with Google to save this doc.",
      cause: { code: "NEEDS_GOOGLE_SIGNIN", details: { url: "https://docs.google.com/x" } },
    });
    expect(toMcpError(needsSignin)).toMatchObject({
      message: expect.stringContaining(needsSignin.message),
      data: { code: "NEEDS_GOOGLE_SIGNIN" },
    });
  });

  it("maps client-input app errors to InvalidParams with their code", () => {
    expect(toMcpError(errors.entryNotFound())).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Entry not found"),
      data: { code: "ENTRY_NOT_FOUND" },
    });
  });

  it("forwards client-input TRPCErrors without an app code as InvalidParams", () => {
    expect(
      toMcpError(new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" }))
    ).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Invalid cursor"),
      data: undefined,
    });
  });

  it("hides the message of internal server errors even with an app code (#1266)", () => {
    const mapped = toMcpError(errors.feedFetchError("https://example.com/", "secret detail"));
    expect(mapped).toMatchObject({ code: ErrorCode.InternalError, data: undefined });
    expect((mapped as Error).message).not.toContain("secret detail");
  });

  it("hides the message of non-client TRPCErrors without an app code", () => {
    const mapped = toMcpError(
      new TRPCError({ code: "TOO_MANY_REQUESTS", message: "secret detail" })
    );
    expect(mapped).toMatchObject({ code: ErrorCode.InternalError, data: undefined });
    expect((mapped as Error).message).not.toContain("secret detail");
  });
});
