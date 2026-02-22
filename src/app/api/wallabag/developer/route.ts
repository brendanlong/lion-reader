/**
 * Wallabag API: Developer page
 *
 * GET /api/wallabag/developer - Lists OAuth API client credentials
 *
 * The Wallabag Android app scrapes this page to auto-discover client_id
 * and client_secret during connection setup. It looks for a specific HTML
 * structure with the credentials inside <strong><code> tags.
 *
 * Since Lion Reader uses hardcoded credentials (wallabag/wallabag),
 * we serve a static page that the app can parse.
 */

export const dynamic = "force-dynamic";

const DEVELOPER_HTML = `<!DOCTYPE html>
<html>
<head><title>Lion Reader - API Clients</title></head>
<body>
<img alt="wallabag logo" />
<a href="/logout">Logout</a>
<div class="collapsible-header">Android app - #1</div>
<div class="collapsible-body">
<p>Client ID: <strong><code>wallabag</code></strong></p>
<p>Client secret: <strong><code>wallabag</code></strong></p>
<p>Redirect URIs: <strong><code></code></strong></p>
<p>Grant types: <strong><code>password refresh_token</code></strong></p>
<a href="/developer/client/delete/1">Delete</a>
</div>
</body>
</html>`;

export async function GET(): Promise<Response> {
  return new Response(DEVELOPER_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
