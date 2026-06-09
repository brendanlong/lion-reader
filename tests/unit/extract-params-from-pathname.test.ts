import { describe, expect, it } from "vitest";
import { extractParamsFromPathname } from "@/lib/navigation";

describe("extractParamsFromPathname", () => {
  it("extracts subscription id", () => {
    expect(extractParamsFromPathname("/subscription/abc-123")).toEqual({
      subscriptionId: "abc-123",
    });
  });

  it("extracts subscription id with trailing segments or query-like suffixes", () => {
    expect(extractParamsFromPathname("/subscription/abc-123/extra")).toEqual({
      subscriptionId: "abc-123",
    });
  });

  it("extracts tag id", () => {
    expect(extractParamsFromPathname("/tag/xyz")).toEqual({ tagId: "xyz" });
  });

  it("returns empty object for static routes", () => {
    expect(extractParamsFromPathname("/all")).toEqual({});
    expect(extractParamsFromPathname("/starred")).toEqual({});
    expect(extractParamsFromPathname("/settings/appearance")).toEqual({});
  });

  it("returns empty object for bare /subscription and /tag", () => {
    expect(extractParamsFromPathname("/subscription")).toEqual({});
    expect(extractParamsFromPathname("/subscription/")).toEqual({});
    expect(extractParamsFromPathname("/tag")).toEqual({});
    expect(extractParamsFromPathname("/tag/")).toEqual({});
  });

  it("strips a basePath before matching", () => {
    expect(extractParamsFromPathname("/demo/subscription/abc", "/demo")).toEqual({
      subscriptionId: "abc",
    });
    expect(extractParamsFromPathname("/demo/tag/xyz", "/demo")).toEqual({ tagId: "xyz" });
  });

  it("does not match when basePath is given but missing from the pathname", () => {
    expect(extractParamsFromPathname("/subscription/abc", "/demo")).toEqual({});
  });

  it("does not match prefixed routes without the basePath argument", () => {
    expect(extractParamsFromPathname("/demo/subscription/abc")).toEqual({});
  });
});
