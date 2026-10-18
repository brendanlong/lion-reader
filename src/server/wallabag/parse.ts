/**
 * Wallabag API Request Parsing and Response Helpers
 */

import type { TRPCError } from "@trpc/server";
import { clientErrorStatus } from "@/server/errors";

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

/** A service's client error in the Wallabag envelope, or null (`clientErrorStatus`). */
export function clientErrorResponse(error: unknown): Response | null {
  const status = clientErrorStatus(error);
  return status === null
    ? null
    : errorResponse((error as TRPCError).code, (error as TRPCError).message, status);
}

/**
 * Wraps a route handler so a service's client error is answered in the
 * Wallabag envelope (`clientErrorResponse`) instead of an unhandled 500.
 */
export function withClientErrors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const response = clientErrorResponse(error);
      if (response) return response;
      throw error;
    }
  };
}

/** Splits a Wallabag `tags` parameter ("a,b, c") into its labels. */
export function parseTagLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const labels = raw
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  return [...new Map(labels.map((label) => [label.toLowerCase(), label])).values()];
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
    tags: parseTagLabels(params.get("tags")),
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
