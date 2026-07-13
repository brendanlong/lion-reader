import { describe, it, expect } from "vitest";
import { TRPCError } from "@trpc/server";
import { clientErrorResponse } from "@/server/wallabag/parse";
import { errors, isExpectedClientError } from "@/server/trpc/errors";

/**
 * clientErrorResponse decides whether a thrown service error should become a
 * clean Wallabag error envelope (client-appropriate) or bubble up to Sentry as
 * a genuine server bug. See the "save an unfetchable URL" bug: a 404 fetch of a
 * user-provided URL was an unhandled 500 reported to Sentry.
 */
describe("clientErrorResponse", () => {
  async function bodyOf(res: Response): Promise<{ error: string; error_description: string }> {
    return (await res.json()) as { error: string; error_description: string };
  }

  it("returns a 4xx Wallabag envelope for a failed fetch of a user URL (400)", async () => {
    // errors.savedArticleFetchError → SAVED_ARTICLE_FETCH_ERROR → BAD_REQUEST
    const res = clientErrorResponse(errors.savedArticleFetchError("https://x.test", "HTTP 404: "));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await bodyOf(res!);
    expect(body.error).toBe("BAD_REQUEST");
    expect(body.error_description).toContain("Failed to fetch page");
  });

  it("returns an envelope for an expected upstream condition mapped to 5xx (SITE_BLOCKED, 502)", async () => {
    const res = clientErrorResponse(errors.siteBlocked("https://x.test", 403));
    expect(res).not.toBeNull();
    // The honest upstream status is preserved for the client...
    expect(res!.status).toBe(502);
    const body = await bodyOf(res!);
    expect(body.error).toBe("BAD_GATEWAY");
    // ...but it's classified as an expected client condition, so it must not
    // be reported to Sentry.
    expect(isExpectedClientError(errors.siteBlocked("https://x.test", 403))).toBe(true);
  });

  it("returns a 429 envelope for upstream rate limiting", () => {
    const res = clientErrorResponse(errors.upstreamRateLimited("https://x.test"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it("returns null for a genuine server error (INTERNAL_SERVER_ERROR) so it reaches Sentry", () => {
    const res = clientErrorResponse(errors.internal("boom"));
    expect(res).toBeNull();
    expect(isExpectedClientError(errors.internal("boom"))).toBe(false);
  });

  it("returns null for a non-TRPC error", () => {
    expect(clientErrorResponse(new Error("unexpected"))).toBeNull();
    expect(clientErrorResponse(new TRPCError({ code: "INTERNAL_SERVER_ERROR" }))).toBeNull();
  });
});
