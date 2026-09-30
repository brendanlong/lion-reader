/**
 * Swaps the tab's favicon for the current list's variant (see
 * `@/lib/favicon/dynamic-favicon`). Rewrites the existing icon links in place
 * rather than rendering new ones — they belong to the root layout's metadata,
 * whose props never change, so React leaves the attributes alone.
 */

"use client";

import { useEffect } from "react";
import { trpc } from "@/lib/trpc/client";
import { useAppPathname } from "@/lib/hooks/useAppLocation";
import { faviconUrl, faviconVariantForPathname } from "@/lib/favicon/dynamic-favicon";

const SAVED_ATTRIBUTES = ["href", "type"] as const;

function savedName(attribute: string): string {
  return `data-original-${attribute}`;
}

// Writing a link's href reloads the icon even when the value is unchanged.
function updateAttribute(link: HTMLLinkElement, attribute: string, value: string | null): void {
  if (link.getAttribute(attribute) === value) {
    return;
  }
  if (value === null) {
    link.removeAttribute(attribute);
  } else {
    link.setAttribute(attribute, value);
  }
}

/** Points every icon link at `svgUrl`, or restores the originals when null. */
function setFaviconSvg(svgUrl: string | null): void {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')) {
    for (const attribute of SAVED_ATTRIBUTES) {
      const saved = savedName(attribute);
      if (!link.hasAttribute(saved)) {
        link.setAttribute(saved, link.getAttribute(attribute) ?? "");
      }
    }
    if (svgUrl) {
      updateAttribute(link, "href", svgUrl);
      updateAttribute(link, "type", "image/svg+xml");
    } else {
      for (const attribute of SAVED_ATTRIBUTES) {
        updateAttribute(link, attribute, link.getAttribute(savedName(attribute)) || null);
      }
    }
  }
}

export function DynamicFavicon() {
  const pathname = useAppPathname();
  // Already cached: the sidebar's tag list keeps it loaded.
  const { data: tagsData } = trpc.tags.list.useQuery();
  const variant = faviconVariantForPathname(
    pathname,
    (tagId) => tagsData?.items.find((tag) => tag.id === tagId)?.color
  );
  const svgUrl = variant ? faviconUrl(variant) : null;

  useEffect(() => {
    setFaviconSvg(svgUrl);
  }, [svgUrl]);

  useEffect(() => () => setFaviconSvg(null), []);

  return null;
}
