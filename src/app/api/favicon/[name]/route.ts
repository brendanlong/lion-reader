/**
 * The SVG favicon and its list-dependent variants (see
 * `@/lib/favicon/dynamic-favicon`).
 * The only input that reaches the SVG is a color the file-name pattern has
 * already constrained to six hex digits. Caching comes from the public-asset
 * rule in `next.config.ts`, which matches the `.svg` suffix.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";
import {
  buildFaviconSvg,
  DEFAULT_FAVICON_FILE_NAME,
  parseFaviconFileName,
  stripSeamStrokes,
} from "@/lib/favicon/dynamic-favicon";

let faviconLogo: Promise<string> | undefined;

// Next serves public/ from the working directory, so the logo is always there.
function loadFaviconLogo(): Promise<string> {
  faviconLogo ??= readFile(join(process.cwd(), "public", "logo.svg"), "utf8")
    .then(stripSeamStrokes)
    .catch((error: unknown) => {
      faviconLogo = undefined;
      throw error;
    });
  return faviconLogo;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const { name } = await params;
  const variant = parseFaviconFileName(name);
  if (name !== DEFAULT_FAVICON_FILE_NAME && !variant) {
    return new NextResponse(null, { status: 404 });
  }
  const logo = await loadFaviconLogo();
  return new NextResponse(variant ? buildFaviconSvg(logo, variant) : logo, {
    headers: { "Content-Type": "image/svg+xml" },
  });
}
