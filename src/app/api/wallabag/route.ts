/**
 * Wallabag API: Root
 *
 * GET /api/wallabag - Server discovery endpoint
 *
 * The Wallabag Android app checks the configured server URL to verify
 * it's a real Wallabag instance. Before checking for a login form, it
 * checks if the page is a "regular page" (already logged in) by looking for:
 * - A logout link matching: /logout">
 * - A logo matching: alt="wallabag logo"
 *
 * If both are present, the app returns OK and proceeds to the API
 * validation step (version.json + OAuth token).
 */

export const dynamic = "force-dynamic";

const DISCOVERY_HTML = `<!DOCTYPE html>
<html>
<head><title>Lion Reader</title></head>
<body>
<img alt="wallabag logo" />
<a href="/logout">Logout</a>
</body>
</html>`;

export async function GET(): Promise<Response> {
  return new Response(DISCOVERY_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
