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
export async function POST(request: NextRequest): Promise<NextResponse> {
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
      return NextResponse.redirect(new URL("/save?error=no_url", request.url), 303);
    }

    // Redirect to /save with the URL
    // The service worker normally handles this and stores in IndexedDB,
    // but if that fails, we fall back to query params
    const saveUrl = new URL("/save", request.url);
    saveUrl.searchParams.set("url", urlToSave);
    saveUrl.searchParams.set("shared", "true");

    return NextResponse.redirect(saveUrl, 303);
  } catch {
    // Redirect to save page with error
    return NextResponse.redirect(new URL("/save?error=share_failed", request.url), 303);
  }
}
