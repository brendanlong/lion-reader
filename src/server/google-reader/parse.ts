/**
 * Google Reader API Request Parsing Helpers
 *
 * Parses form-encoded POST bodies and query parameters in the
 * formats expected by Google Reader clients.
 */

import { parseItemId } from "./id";

/**
 * Parses request parameters, accepting them from the URL query string OR the
 * form-encoded body, mirroring the original Google Reader API (and FreshRSS's
 * `greader.php`, which reads PHP `$_REQUEST` — GET and POST merged).
 *
 * Some clients put parameters in the query string even on a POST: FeedMe, for
 * example, sends `POST /accounts/ClientLogin?Email=…&Passwd=…` with an empty
 * body. Reading only the body would 401 those clients, so we start from the
 * query params and layer body params on top (body wins on key conflicts).
 */
export async function parseFormData(request: Request): Promise<URLSearchParams> {
  const params = new URLSearchParams(new URL(request.url).searchParams);

  if (request.method === "GET") {
    return params;
  }

  const bodyParams = await parseBody(request);

  // Body overrides query on conflicting keys (e.g. repeated `i` item IDs come
  // from the body); delete-then-append so we don't accumulate both sides.
  for (const key of new Set(bodyParams.keys())) {
    params.delete(key);
    for (const value of bodyParams.getAll(key)) {
      params.append(key, value);
    }
  }

  return params;
}

/**
 * Parses the request body as form data (url-encoded or multipart). Returns an
 * empty set for a body-less/unparseable request.
 */
async function parseBody(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const params = new URLSearchParams();
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") {
        params.append(key, value);
      }
    }
    return params;
  }

  // Default to url-encoded (the Google Reader content type), also covering the
  // "no content type" case some clients send.
  try {
    return new URLSearchParams(await request.text());
  } catch (err) {
    console.error("Failed to parse request body as form data:", err);
    return new URLSearchParams();
  }
}

/**
 * Parses item IDs from request parameters.
 * Google Reader sends item IDs as repeated `i` parameters.
 * Each ID can be in long hex, short hex, or decimal format.
 */
export function parseItemIds(params: URLSearchParams): bigint[] {
  const rawIds = params.getAll("i");
  return rawIds.map(parseItemId);
}

/**
 * Creates a Google Reader JSON response.
 */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}

/**
 * Creates a text/plain response (used by edit-tag, mark-all-as-read, etc.).
 */
export function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
    },
  });
}

/**
 * Creates an error response.
 */
export function errorResponse(message: string, status = 400): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
    },
  });
}
