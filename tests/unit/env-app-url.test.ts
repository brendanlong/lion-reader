import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppUrl } from "@/server/config/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readAppUrl", () => {
  it("uses NEXT_PUBLIC_APP_URL when set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://reader.example.com");
    expect(readAppUrl()).toBe("https://reader.example.com");
  });

  // The production build prerenders the sitemap, robots.txt and metadata
  // without NEXT_PUBLIC_APP_URL; dev's OAuth callbacks must come back to it.
  it.each([
    ["production", "https://lionreader.com"],
    ["development", "http://localhost:3000"],
  ])("falls back by NODE_ENV (%s)", (nodeEnv, expected) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
    expect(readAppUrl()).toBe(expected);
  });
});
