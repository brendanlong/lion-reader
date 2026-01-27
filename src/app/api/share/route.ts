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
 * - enctype: multipart/form-data
 * - params: title, text, url, files
 *
 * Supports:
 * - URL sharing (traditional share target)
 * - File sharing (text/plain, text/markdown, text/html, .docx)
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

    // Check if a file was shared
    const sharedFile = formData.get("file") as File | null;

    if (sharedFile) {
      // File was shared - redirect to /save with a file indicator
      // The service worker normally intercepts share target POST requests and stores
      // the file in IndexedDB before redirecting. This server-side route is a fallback
      // that just redirects with metadata (the actual file content is lost in this case,
      // but the service worker should handle it 99% of the time).

      // Redirect to save page with file upload flag
      const saveUrl = new URL("/save", baseUrl);
      saveUrl.searchParams.set("type", "file");
      saveUrl.searchParams.set("filename", sharedFile.name);
      saveUrl.searchParams.set("shared", "true");
      // Note: We can't pass the file content via URL (too large)
      // This is why the service worker intercept is important for file shares

      return NextResponse.redirect(saveUrl, 303);
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
