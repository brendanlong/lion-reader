import { NextRequest, NextResponse } from "next/server";

/**
 * Share Target API Route
 *
 * The fallback for when the service worker doesn't intercept the share target
 * POST request. It redirects a shared URL to /save as the service worker
 * would; a shared file can't follow a redirect, so it gets an error instead.
 *
 * The manifest.json specifies this endpoint as the share_target action:
 * - method: POST
 * - enctype: multipart/form-data
 * - params: title, text, url, files
 */

/**
 * Get the public-facing base URL for redirects.
 * In production behind a proxy (e.g., Fly.io), request.url contains the internal
 * URL (localhost:3000), not the external URL (lionreader.com), so we rely on the
 * configured NEXT_PUBLIC_APP_URL there.
 *
 * We deliberately do NOT trust the `x-forwarded-host` header for the redirect
 * base: it is attacker-controllable, so building a `redirect()` target from it
 * would be an open-redirect (redirect to `https://evil.com/save?...`) the moment
 * NEXT_PUBLIC_APP_URL is missing. Production always sets NEXT_PUBLIC_APP_URL; the
 * request.url origin is only a local-dev convenience where there is no proxy.
 */
function getBaseUrl(request: NextRequest): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  // Local dev only (no proxy in front): request.url is the real origin.
  return new URL(request.url).origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const baseUrl = getBaseUrl(request);

  try {
    const formData = await request.formData();

    // Check if a file was shared
    const sharedFile = formData.get("file") as File | null;

    if (sharedFile) {
      // Only the service worker can hand a file to /save (through IndexedDB);
      // reaching here means it didn't, and the file can't follow a redirect.
      return NextResponse.redirect(new URL("/save?error=file_missing", baseUrl), 303);
    }

    // No file - check for URL sharing
    const sharedUrl = formData.get("url")?.toString();
    const sharedText = formData.get("text")?.toString();

    // Try to find a URL in the shared data
    let urlToSave = sharedUrl;

    if (!urlToSave && sharedText) {
      // Try to extract URL from text (common when sharing from browsers)
      const urlMatch = sharedText.match(/https?:\/\/[^\s]+/);
      if (urlMatch) {
        urlToSave = urlMatch[0];
      } else if (sharedText.startsWith("http")) {
        urlToSave = sharedText;
      }
    }

    if (!urlToSave) {
      // No URL or file found, redirect to save page with error
      return NextResponse.redirect(new URL("/save?error=no_url_or_file", baseUrl), 303);
    }

    // Redirect to /save with the URL
    // The service worker normally handles this and stores in IndexedDB,
    // but if that fails, we fall back to query params
    const saveUrl = new URL("/save", baseUrl);
    saveUrl.searchParams.set("url", urlToSave);
    saveUrl.searchParams.set("shared", "true");

    return NextResponse.redirect(saveUrl, 303);
  } catch (error) {
    // Redirect to save page with error
    console.error("Share target error:", error);
    return NextResponse.redirect(new URL("/save?error=share_failed", baseUrl), 303);
  }
}
