import type { Metadata } from "next";

export const defaultOpenGraph: Metadata["openGraph"] = {
  images: [{ url: "/social-preview.png" }],
};

/**
 * Build openGraph metadata for a page, overriding the default social image when
 * an `image` is provided (e.g. a demo article's hero doubles as its OG image).
 * Relative URLs resolve against `metadataBase` (set in the root layout).
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
    ...(image ? { images: [{ url: image }] } : {}),
  };
}
