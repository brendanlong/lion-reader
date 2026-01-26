import { NextRequest, NextResponse } from "next/server";

/**
 * Share Target API Route
 *
 * This is a fallback handler for when the service worker doesn't intercept
 * the share target POST request. The service worker handles this client-side
 * and stores data in IndexedDB before redirecting. This server-side route
 * provides the same redirect behavior as a backup.
 *
 * The manifest.json specifies this endpoint as the share_target action:
 * - method: POST
 * - enctype: application/x-www-form-urlencoded
 * - params: title, text, url
 */

/**
 * Get the public-facing base URL for redirects.
 * In production behind a proxy (e.g., Fly.io), request.url contains the internal
 * URL (localhost:3000), not the external URL (lionreader.com). We need to use
 * the forwarded headers or configured app URL for correct redirects.
 */
function getBaseUrl(request: NextRequest): string {
  // First, try NEXT_PUBLIC_APP_URL (most reliable in production)
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  // Fall back to x-forwarded-host header (set by proxies like Fly.io)
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  // Last resort: use request.url (works for local dev)
  return new URL(request.url).origin;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const baseUrl = getBaseUrl(request);

  try {
    const formData = await request.formData();

    // Extract shared data
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
      // No URL found, redirect to save page with error
      return NextResponse.redirect(new URL("/save?error=no_url", baseUrl), 303);
    }

    // Redirect to /save with the URL
    // The service worker normally handles this and stores in IndexedDB,
    // but if that fails, we fall back to query params
    const saveUrl = new URL("/save", baseUrl);
    saveUrl.searchParams.set("url", urlToSave);
    saveUrl.searchParams.set("shared", "true");

    return NextResponse.redirect(saveUrl, 303);
  } catch {
    // Redirect to save page with error
    return NextResponse.redirect(new URL("/save?error=share_failed", baseUrl), 303);
  }
}
