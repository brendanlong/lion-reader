/**
 * Uploads bypass the proxy, which bounds every other request's body
 * (`tests/unit/proxy.test.ts`), so the route bounds theirs: one that isn't
 * authenticated, or whose body is past the limit, is answered with an error in
 * each API's own format, never parsed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { usageLimitsConfig } from "../../src/server/config/env";
import { maxEbookUploadBytes, maxUploadBodyBytes } from "../../src/lib/upload-limits";
import { GET as trpcGet, POST as trpcPost } from "../../src/app/api/trpc/[trpc]/route";
import { POST as restPost } from "../../src/app/api/v1/[...path]/route";
import { createTestUser } from "./helpers";

const MAX_BODY_BYTES = maxUploadBodyBytes(
  maxEbookUploadBytes(usageLimitsConfig.maxSavedArticleSizeBytes)
);
const TRPC_URL = "http://localhost/api/trpc/collections.importEbook";
const REST_URL = "http://localhost/api/v1/collections/import-ebook";

let userId: string;
let cookie: string;

beforeAll(async () => {
  userId = await createTestUser({ emailPrefix: "body-limit" });
  cookie = `session=${(await createSession(db, { userId })).token}`;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

/** A request as Next hands route handlers one. */
function request(url: string, init: RequestInit): NextRequest {
  return new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
}

/** A request declaring `declared` bytes, with only the start of a body. */
function declaring(url: string, declared: number, headers: Record<string, string> = { cookie }) {
  return request(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json", "content-length": String(declared) },
    body: '{"json":{"content":"AAAA',
  });
}

/** An upload of more than the limit, sent without a length. */
function unboundedUpload(url: string): NextRequest {
  const chunk = new TextEncoder().encode("A".repeat(1024 * 1024));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(new TextEncoder().encode('{"content":"')),
    pull(controller) {
      if (sent > MAX_BODY_BYTES) controller.close();
      else controller.enqueue(chunk);
      sent += chunk.length;
    },
  });
  return request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

interface ErrorJson {
  message: string;
  data: { appErrorCode: string | null };
}

async function trpcError(req: NextRequest): Promise<ErrorJson> {
  return ((await (await trpcPost(req)).json()) as { error: { json: ErrorJson } }).error.json;
}

async function restError(req: NextRequest): Promise<ErrorJson & { status: number }> {
  const response = await restPost(req);
  return { ...((await response.json()) as ErrorJson), status: response.status };
}

describe("upload body limit", () => {
  it("answers an upload declaring past the limit with a size error", async () => {
    const error = await trpcError(declaring(TRPC_URL, MAX_BODY_BYTES + 1));
    expect(error.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
    expect(error.message).toMatch(/upload exceeds/);
  });

  it("hands an upload at the limit to the adapter", async () => {
    const error = await trpcError(declaring(TRPC_URL, MAX_BODY_BYTES));
    // The adapter parses the short body itself and fails on it.
    expect(error.data.appErrorCode).toBeNull();
    expect(error.message).toMatch(/JSON/);
  });

  it("stops reading an upload sent without a length once it passes the limit", async () => {
    const error = await trpcError(unboundedUpload(TRPC_URL));
    expect(error.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
  });

  it("serves a GET to an upload path whatever length it declares", async () => {
    const response = await trpcGet(
      request(TRPC_URL, { headers: { cookie, "content-length": String(MAX_BODY_BYTES + 1) } })
    );
    // A mutation can't be called with GET; what matters is it isn't a crash.
    expect(response.status).toBe(405);
  });

  it("answers REST uploads past the limit with a size error, with or without a length", async () => {
    for (const req of [declaring(REST_URL, MAX_BODY_BYTES + 1), unboundedUpload(REST_URL)]) {
      const error = await restError(req);
      expect(error.status).toBe(400);
      expect(error.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
      expect(error.message).toMatch(/upload exceeds/);
    }
  });

  it("rejects an unauthenticated upload before reading its body", async () => {
    const tooLarge = MAX_BODY_BYTES + 1;
    expect((await restError(declaring(REST_URL, tooLarge, {}))).status).toBe(401);
    const bogus = { cookie: "session=not-a-session" };
    expect((await restError(declaring(REST_URL, tooLarge, bogus))).status).toBe(401);
    expect((await trpcPost(declaring(TRPC_URL, tooLarge, {}))).status).toBe(401);
  });
});
