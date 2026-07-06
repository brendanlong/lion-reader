import type { Metadata } from "next";

/**
 * All preview/OG images — the shared social card and every demo article hero —
 * are generated at this fixed size (see src/app/demo/articles/CLAUDE.md).
 * Emitting og:image:width/height lets crawlers reserve the card's space up front
 * (no layout shift, and some clients require dimensions to render a large card).
 */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export const defaultOpenGraph: Metadata["openGraph"] = {
  images: [{ url: "/social-preview.png", width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT }],
};

/**
 * Build openGraph metadata for a page, overriding the default social image when
 * an `image` is provided (e.g. a demo article's hero doubles as its OG image).
 * Relative URLs resolve against `metadataBase` (set in the root layout). The
 * image is assumed to be OG_IMAGE_WIDTH×OG_IMAGE_HEIGHT.
 */
export function pageOpenGraph(
  title: string,
  description: string | undefined,
  image?: string
): Metadata["openGraph"] {
  return {
    ...defaultOpenGraph,
    title,
    description,
    ...(image ? { images: [{ url: image, width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT }] } : {}),
  };
}
