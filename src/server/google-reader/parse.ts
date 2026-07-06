/**
 * Google Reader API Request Parsing Helpers
 *
 * Parses form-encoded POST bodies and query parameters in the
 * formats expected by Google Reader clients.
 */

import { parseItemId } from "./id";

/**
 * Parses form-encoded POST body or URL query parameters.
 * Google Reader API uses application/x-www-form-urlencoded for POST bodies.
 */
export async function parseFormData(request: Request): Promise<URLSearchParams> {
  if (request.method === "GET") {
    return new URL(request.url).searchParams;
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return new URLSearchParams(text);
  }

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

  // Fall back to trying to parse as form data
  try {
    const text = await request.text();
    return new URLSearchParams(text);
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
