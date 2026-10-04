import { describe, it, expect } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { TRPCError } from "@trpc/server";
import { errors } from "../../src/server/trpc/errors";
import { toMcpError } from "../../src/server/mcp/tools";

const GENERIC = "An internal error occurred";

describe("toMcpError", () => {
  it("forwards app errors' messages and codes for non-client tRPC codes (#1834)", () => {
    const rateLimited = errors.upstreamRateLimited("https://example.com/");
    expect(toMcpError(rateLimited)).toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining(rateLimited.message),
      data: { code: "UPSTREAM_RATE_LIMITED" },
    });
    expect(toMcpError(errors.siteBlocked("https://example.com/", 403))).toMatchObject({
      data: { code: "SITE_BLOCKED" },
    });
  });

  it("maps client-input app errors to InvalidParams with their code", () => {
    expect(toMcpError(errors.entryNotFound())).toMatchObject({
      code: ErrorCode.InvalidParams,
      message: expect.stringContaining("Entry not found"),
      data: { code: "ENTRY_NOT_FOUND" },
    });
  });

  it("hides the message of internal server errors (#1266)", () => {
    const internal = toMcpError(errors.feedFetchError("https://example.com/", "secret detail"));
    expect(internal).toBeInstanceOf(McpError);
    expect((internal as McpError).message).not.toContain("secret detail");
    expect(internal).toMatchObject({ code: ErrorCode.InternalError, data: undefined });
  });

  it("hides the message of non-client TRPCErrors not built by errors.*", () => {
    const raw = new TRPCError({ code: "TOO_MANY_REQUESTS", message: "secret detail" });
    const mapped = toMcpError(raw) as McpError;
    expect(mapped.message).not.toContain("secret detail");
    expect(mapped.message).toContain(GENERIC);
  });
});
