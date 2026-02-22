/**
 * Wallabag API Request Parsing and Response Helpers
 */

/**
 * Creates a JSON response.
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
 * Creates an error response in Wallabag format.
 */
export function errorResponse(error: string, description: string, status = 400): Response {
  return jsonResponse({ error, error_description: description }, status);
}

/**
 * Parses query parameters for entry listing.
 */
export function parseEntryListParams(url: URL): {
  archive: boolean | undefined;
  starred: boolean | undefined;
  sort: "created" | "updated" | "archived";
  order: "asc" | "desc";
  page: number;
  perPage: number;
  tags: string[];
  since: number | undefined;
  public: boolean | undefined;
  detail: "metadata" | "full";
  domainName: string | undefined;
} {
  const params = url.searchParams;

  return {
    archive: params.has("archive") ? params.get("archive") === "1" : undefined,
    starred: params.has("starred") ? params.get("starred") === "1" : undefined,
    sort: (params.get("sort") as "created" | "updated" | "archived") ?? "created",
    order: (params.get("order") as "asc" | "desc") ?? "desc",
    page: Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1),
    perPage: Math.min(Math.max(1, parseInt(params.get("perPage") ?? "30", 10) || 30), 100),
    tags: params.get("tags")
      ? params
          .get("tags")!
          .split(",")
          .map((t) => t.trim())
      : [],
    since: params.has("since") ? parseInt(params.get("since")!, 10) || undefined : undefined,
    public: params.has("public") ? params.get("public") === "1" : undefined,
    detail: (params.get("detail") as "metadata" | "full") ?? "full",
    domainName: params.get("domain_name") ?? undefined,
  };
}

/**
 * Parses form data from a POST/PATCH request body.
 * Handles JSON, form-urlencoded, and multipart form data.
 */
export async function parseBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const json = await request.json();
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
      if (value !== null && value !== undefined) {
        result[key] = String(value);
      }
    }
    return result;
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    const result: Record<string, string> = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const result: Record<string, string> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return result;
  }

  // Try JSON as fallback
  try {
    const json = await request.json();
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
      if (value !== null && value !== undefined) {
        result[key] = String(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}
