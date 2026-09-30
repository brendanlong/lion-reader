/**
 * Unit tests for the list-dependent favicon variants.
 */

import { describe, it, expect } from "vitest";
import {
  bookColorMap,
  buildFaviconSvg,
  faviconUrl,
  faviconVariantForPathname,
  mixHex,
  parseFaviconFileName,
  stripSeamStrokes,
} from "../../src/lib/favicon/dynamic-favicon";
import { readFileSync } from "node:fs";
import { GET } from "../../src/app/api/favicon/[name]/route";

const LOGO = readFileSync("public/logo.svg", "utf8");
const LOGO_SVG = stripSeamStrokes(LOGO);

const TAG_ID = "0190d1a8-7b3c-7000-8000-000000000001";

function tagColored(color: string | null): (tagId: string) => string | null | undefined {
  return (tagId) => (tagId === TAG_ID ? color : undefined);
}

describe("mixHex", () => {
  it("returns the endpoints at 0 and 1", () => {
    expect(mixHex("#8b5cf6", "#000000", 0)).toBe("#8b5cf6");
    expect(mixHex("#8b5cf6", "#ffffff", 1)).toBe("#ffffff");
  });

  it("mixes each channel", () => {
    expect(mixHex("#204060", "#000000", 0.5)).toBe("#102030");
  });
});

describe("faviconVariantForPathname", () => {
  it("stars the Starred list", () => {
    expect(faviconVariantForPathname("/starred", tagColored(null))).toEqual({ kind: "starred" });
  });

  it("colors a tag list with its tag's color", () => {
    expect(faviconVariantForPathname(`/tag/${TAG_ID}`, tagColored("#8b5cf6"))).toEqual({
      kind: "tag",
      color: "#8b5cf6",
    });
  });

  it.each([
    "/all",
    "/saved",
    "/recently-read",
    "/uncategorized",
    "/tag/uncategorized",
    "/subscription/abc",
  ])("keeps the default favicon on %s", (pathname) => {
    expect(faviconVariantForPathname(pathname, tagColored("#8b5cf6"))).toBeNull();
  });

  it("keeps the default for tags that are unknown, uncolored, or not a hex color", () => {
    expect(faviconVariantForPathname("/tag/unknown", tagColored("#8b5cf6"))).toBeNull();
    expect(faviconVariantForPathname(`/tag/${TAG_ID}`, tagColored(null))).toBeNull();
    expect(faviconVariantForPathname(`/tag/${TAG_ID}`, tagColored('red" onload="x'))).toBeNull();
  });
});

describe("faviconUrl / parseFaviconFileName", () => {
  it.each([{ kind: "starred" as const }, { kind: "tag" as const, color: "#8b5cf6" }])(
    "round-trips %o",
    (variant) => {
      const name = faviconUrl(variant).split("/").pop() ?? "";
      expect(parseFaviconFileName(name)).toEqual(variant);
    }
  );

  it("canonicalizes the tag color so one color has one URL", () => {
    const variant = faviconVariantForPathname(`/tag/${TAG_ID}`, tagColored("#8B5CF6"));
    expect(variant && faviconUrl(variant)).toBe("/api/favicon/tag-8b5cf6.svg");
  });

  it.each([
    "starred",
    "starred.png",
    "tag-8b5cf6",
    "tag-8B5CF6.svg",
    "tag-8b5cf.svg",
    "tag-8b5cf6a.svg",
    'tag-8b5cf6" onload="x.svg',
    "../starred.svg",
  ])("rejects %s", (name) => {
    expect(parseFaviconFileName(name)).toBeNull();
  });
});

describe("stripSeamStrokes", () => {
  it("removes every seam stroke and nothing else", () => {
    expect(LOGO).toContain('vector-effect="non-scaling-stroke"');
    expect(LOGO_SVG).not.toContain("vector-effect");
    expect(LOGO_SVG).not.toMatch(/stroke="/);
    expect(LOGO_SVG.match(/<path /g)?.length).toBe(
      (LOGO.match(/<path /g)?.length ?? 0) - (LOGO.match(/vector-effect=/g)?.length ?? 0)
    );
  });
});

describe("buildFaviconSvg", () => {
  it("replaces every book color in the logo", () => {
    const svg = buildFaviconSvg(LOGO_SVG, { kind: "tag", color: "#8b5cf6" });
    for (const [from, to] of Object.entries(bookColorMap("#8b5cf6"))) {
      expect(LOGO_SVG).toContain(`fill="${from}"`);
      expect(svg).not.toContain(`fill="${from}"`);
      expect(svg).toContain(`fill="${to}"`);
    }
  });

  it("adds a star inside the svg for Starred", () => {
    const svg = buildFaviconSvg(LOGO_SVG, { kind: "starred" });
    expect(svg).toMatch(/<polygon [^>]+\/><\/svg>$/);
    expect(svg.replace(/<polygon [^>]+\/>/, "")).toBe(LOGO_SVG);
  });
});

describe("GET /api/favicon/[name]", () => {
  const get = (name: string): Promise<Response> =>
    GET(new Request(`http://localhost/api/favicon/${name}`), {
      params: Promise.resolve({ name }),
    });

  it("serves the logo without its seam strokes as the default favicon", async () => {
    const response = await get("default.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(await response.text()).toBe(LOGO_SVG);
  });

  it("serves variants", async () => {
    const response = await get("starred.svg");
    expect(await response.text()).toBe(buildFaviconSvg(LOGO_SVG, { kind: "starred" }));
  });

  it("404s unknown names", async () => {
    expect((await get("tag-zzzzzz.svg")).status).toBe(404);
  });
});
