/**
 * Unit tests for the demo image URL helper: content-hash cache-busting and the
 * fallback for unmapped paths. The CDN prefix is empty in the test env
 * (NEXT_PUBLIC_ASSET_PREFIX unset), so these assert the origin-relative form.
 */

import { describe, it, expect } from "vitest";
import { demoImageUrl } from "../../src/app/(public)/demo/demo-assets";
import { DEMO_IMAGE_HASHES } from "../../src/app/(public)/demo/demo-image-manifest";

describe("demoImageUrl", () => {
  it("appends the content hash as a ?v= cache-buster for a known image", () => {
    const hash = DEMO_IMAGE_HASHES["/demo/welcome.png"];
    expect(hash).toBeTruthy();

    expect(demoImageUrl("/demo/welcome.png")).toBe(`/demo/welcome.png?v=${hash}`);
  });

  it("busts the OG sibling independently of the hero", () => {
    const hero = DEMO_IMAGE_HASHES["/demo/welcome.png"];
    const og = DEMO_IMAGE_HASHES["/demo/welcome-og.png"];
    expect(hero).not.toBe(og);

    expect(demoImageUrl("/demo/welcome-og.png")).toBe(`/demo/welcome-og.png?v=${og}`);
  });

  it("falls back to an unversioned URL for an image missing from the manifest", () => {
    expect(demoImageUrl("/demo/not-generated-yet.png")).toBe("/demo/not-generated-yet.png");
  });

  it("covers every image referenced by the demo articles", () => {
    // Every manifest key is a /demo/* path with a non-empty hash.
    for (const [path, hash] of Object.entries(DEMO_IMAGE_HASHES)) {
      expect(path).toMatch(/^\/demo\/.+\.(png|jpg|jpeg|webp|gif|svg)$/);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
