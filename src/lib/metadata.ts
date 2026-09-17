import type { Metadata } from "next";

/**
 * The shared social card's size. Emitting og:image:width/height lets crawlers
 * reserve the card's space up front (no layout shift, and some clients require
 * dimensions to render a large card).
 */
const OG_IMAGE_WIDTH = 1200;
const OG_IMAGE_HEIGHT = 630;

export const defaultOpenGraph: Metadata["openGraph"] = {
  images: [{ url: "/social-preview.png", width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT }],
};

/** Build openGraph metadata for a page, keeping the default social image. */
export function pageOpenGraph(
  title: string,
  description: string | undefined
): Metadata["openGraph"] {
  return { ...defaultOpenGraph, title, description };
}
