/**
 * Easter-egg favicon variants of the lion logo: tag lists recolor the book in
 * the tag's color, and the Starred list puts a star on the book's back cover.
 */

import { getFiltersFromPathname } from "@/lib/queries/entries-list-input";

export type FaviconVariant = { kind: "tag"; color: string } | { kind: "starred" };

const WHITE = "#ffffff";
const BLACK = "#000000";

const BOOK_OUTLINE = "#085987";
const STAR_FILL = "#f9ba1a";
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Mixes `color` toward `target` by `amount` (0 = color, 1 = target). */
export function mixHex(color: string, target: string, amount: number): string {
  const channels = (hex: string): number[] =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const from = channels(color);
  const to = channels(target);
  return (
    "#" +
    from
      .map((c, i) =>
        Math.round(c * (1 - amount) + to[i] * amount)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")
  );
}

/** Logo fill → replacement, deriving every shade of the book from one color. */
export function bookColorMap(color: string): Record<string, string> {
  return {
    "#3a9cc6": color, // back cover
    "#77d1ea": mixHex(color, WHITE, 0.45), // back cover highlight
    "#4aae77": mixHex(color, BLACK, 0.15), // front cover
    "#96dc80": mixHex(color, WHITE, 0.35), // front cover highlight
    "#208481": mixHex(color, BLACK, 0.4), // inside of the front cover
    [BOOK_OUTLINE]: mixHex(color, BLACK, 0.6),
  };
}

function starPolygon(): string {
  const centerX = 400;
  const centerY = 900;
  const outerRadius = 200;
  const innerRadius = outerRadius * 0.45;
  const points = Array.from({ length: 10 }, (_, i) => {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${(centerX + radius * Math.cos(angle)).toFixed(1)},${(centerY + radius * Math.sin(angle)).toFixed(1)}`;
  });
  return `<polygon points="${points.join(" ")}" fill="${STAR_FILL}" stroke="${BOOK_OUTLINE}" stroke-width="30" stroke-linejoin="round"/>`;
}

/**
 * The logo's hairline seam strokes hide antialiasing gaps between shapes at
 * large sizes, but at favicon size they're thick smudges in blended colors
 * that recoloring the book would also have to track.
 */
export function stripSeamStrokes(logoSvg: string): string {
  return logoSvg.replace(/<path [^>]*vector-effect="non-scaling-stroke"[^>]*\/>/g, "");
}

export function buildFaviconSvg(logoSvg: string, variant: FaviconVariant): string {
  if (variant.kind === "starred") {
    return logoSvg.replace("</svg>", `${starPolygon()}</svg>`);
  }
  let svg = logoSvg;
  for (const [from, to] of Object.entries(bookColorMap(variant.color))) {
    svg = svg.replaceAll(`fill="${from}"`, `fill="${to}"`);
  }
  return svg;
}

/** The variant for an app-relative pathname, or null for the default favicon. */
export function faviconVariantForPathname(
  pathname: string,
  tagColor: (tagId: string) => string | null | undefined
): FaviconVariant | null {
  const filters = getFiltersFromPathname(pathname);
  if (filters.starredOnly) {
    return { kind: "starred" };
  }
  const color = filters.tagId ? tagColor(filters.tagId) : null;
  return color && HEX_COLOR.test(color) ? { kind: "tag", color: color.toLowerCase() } : null;
}

const FAVICON_FILE_NAME = /^(?:starred|tag-([0-9a-f]{6}))\.svg$/;

// Served by `src/app/api/favicon/[name]/route.ts`.
export const DEFAULT_FAVICON_FILE_NAME = "default.svg";
export const DEFAULT_FAVICON_URL = `/api/favicon/${DEFAULT_FAVICON_FILE_NAME}`;

export function faviconUrl(variant: FaviconVariant): string {
  const name = variant.kind === "starred" ? "starred" : `tag-${variant.color.slice(1)}`;
  return `/api/favicon/${name}.svg`;
}

export function parseFaviconFileName(name: string): FaviconVariant | null {
  const match = FAVICON_FILE_NAME.exec(name);
  if (!match) {
    return null;
  }
  return match[1] ? { kind: "tag", color: `#${match[1]}` } : { kind: "starred" };
}
