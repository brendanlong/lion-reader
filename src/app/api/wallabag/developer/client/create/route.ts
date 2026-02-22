/**
 * Wallabag API: Create OAuth Client
 *
 * GET  /api/wallabag/developer/client/create - Return form with CSRF token
 * POST /api/wallabag/developer/client/create - "Create" client, return credentials
 *
 * The Wallabag Android app uses this as a fallback when it can't find
 * existing credentials on the /developer page. Since Lion Reader uses
 * hardcoded credentials, we return them directly.
 */

export const dynamic = "force-dynamic";

// GET returns a form with a CSRF token (the app extracts the token to POST back)
const CREATE_FORM_HTML = `<!DOCTYPE html>
<html>
<head><title>Lion Reader - Create API Client</title></head>
<body>
<img alt="wallabag logo" />
<a href="/logout">Logout</a>
<form method="post">
<input type="hidden" id="client__token" name="client[_token]" value="lion-reader-static-token" />
</form>
</body>
</html>`;

// POST returns the "created" credentials in the format the app expects
const CREATE_RESULT_HTML = `<!DOCTYPE html>
<html>
<head><title>Lion Reader - API Client Created</title></head>
<body>
<img alt="wallabag logo" />
<a href="/logout">Logout</a>
<ul>
<li>Client ID: <strong><pre>wallabag</pre></strong></li>
<li>Client secret: <strong><pre>wallabag</pre></strong></li>
<li>Redirect URIs: <strong><pre>n/a</pre></strong></li>
</ul>
</body>
</html>`;

export async function GET(): Promise<Response> {
  return new Response(CREATE_FORM_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(): Promise<Response> {
  return new Response(CREATE_RESULT_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
