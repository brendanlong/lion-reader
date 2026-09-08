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

  it("expects an app-relative pathname (a mount prefix is stripped by useAppPathname)", () => {
    expect(extractParamsFromPathname("/demo/subscription/abc")).toEqual({});
  });
});
