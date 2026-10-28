/**
 * An upload's body past its limit is answered with a size error in each
 * API's own format, never parsed. (Uploads bypass the proxy, which bounds
 * every other request's body: `tests/unit/proxy.test.ts`.)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { MAX_UPLOAD_BODY_BYTES } from "../../src/lib/upload-limits";
import { GET as trpcGet, POST as trpcPost } from "../../src/app/api/trpc/[trpc]/route";
import { POST as restPost } from "../../src/app/api/v1/[...path]/route";
import { createTestUser } from "./helpers";

let userId: string;
let cookie: string;

beforeAll(async () => {
  userId = await createTestUser({ emailPrefix: "body-limit" });
  cookie = `session=${(await createSession(db, { userId })).token}`;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

const UPLOAD_URL = "http://localhost/api/trpc/collections.importEbook";

/** A request as Next hands route handlers one. */
function request(url: string, init: RequestInit): NextRequest {
  return new NextRequest(url, init as ConstructorParameters<typeof NextRequest>[1]);
}

/** A request declaring `declared` bytes, with its body cut off as the proxy leaves it. */
function cutOffRequest(url: string, declared: number): NextRequest {
  return request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "content-length": String(declared) },
    body: '{"json":{"content":"AAAA',
  });
}

interface TrpcErrorJson {
  message: string;
  data: { appErrorCode: string | null };
}

/** The error tRPC answers `request` with, batched or not. */
async function trpcError(req: NextRequest): Promise<TrpcErrorJson> {
  const body = (await (await trpcPost(req)).json()) as
    { error: { json: TrpcErrorJson } } | Array<{ error: { json: TrpcErrorJson } }>;
  return (Array.isArray(body) ? body[0] : body).error.json;
}

describe("request body limit", () => {
  it("answers an upload declaring past its limit with a size error", async () => {
    const error = await trpcError(cutOffRequest(UPLOAD_URL, MAX_UPLOAD_BODY_BYTES + 1));
    expect(error.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
    expect(error.message).toMatch(/upload exceeds/);
  });

  it("hands an upload at its limit to the adapter", async () => {
    const error = await trpcError(cutOffRequest(UPLOAD_URL, MAX_UPLOAD_BODY_BYTES));
    // The adapter parses the cut-off body itself and fails on it.
    expect(error.data.appErrorCode).toBeNull();
    expect(error.message).toMatch(/JSON/);
  });

  it("stops reading an upload sent without a length once it passes the limit", async () => {
    const chunk = new TextEncoder().encode("A".repeat(1024 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode('{"json":{"content":"')),
      pull(controller) {
        if (sent > MAX_UPLOAD_BODY_BYTES) controller.close();
        else controller.enqueue(chunk);
        sent += chunk.length;
      },
    });
    const error = await trpcError(
      request(UPLOAD_URL, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit)
    );
    expect(error.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
    expect(error.message).toMatch(/upload exceeds/);
  });

  it("serves a GET whatever length it declares", async () => {
    const response = await trpcGet(
      request("http://localhost/api/trpc/auth.signupConfig", {
        headers: { cookie, "content-length": String(MAX_UPLOAD_BODY_BYTES + 1) },
      })
    );
    expect(response.status).toBe(200);
  });

  it("answers a REST upload declaring past its limit in the REST error format", async () => {
    const response = await restPost(
      cutOffRequest("http://localhost/api/v1/collections/import-ebook", MAX_UPLOAD_BODY_BYTES + 1)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string; data: { appErrorCode: string } };
    expect(body.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
    expect(body.message).toMatch(/upload exceeds/);
  });
});
