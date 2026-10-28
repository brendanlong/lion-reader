/**
 * A request declaring a body larger than the app server reads is answered
 * with a size error in each API's own format, never parsed: Next's proxy
 * would have cut its body off.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { MAX_REQUEST_BODY_BYTES } from "../../src/lib/upload-limits";
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

/** A request declaring `declared` bytes, with its body cut off as the proxy leaves it. */
function cutOffRequest(url: string, declared: number): Request {
  return new Request(url, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "content-length": String(declared) },
    body: '{"0":{"json":{"content":"AAAA',
  });
}

interface TrpcError {
  error: { json: { message: string; data: { appErrorCode: string | null } } };
}

async function trpcImport(declared: number): Promise<TrpcError["error"]["json"]> {
  const response = await trpcPost(
    cutOffRequest("http://localhost/api/trpc/collections.importEbook?batch=1", declared)
  );
  const [result] = (await response.json()) as TrpcError[];
  return result.error.json;
}

describe("request body limit", () => {
  it("answers a tRPC request declaring too many bytes with a size error", async () => {
    const error = await trpcImport(MAX_REQUEST_BODY_BYTES + 1);
    expect(error.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
    expect(error.message).toMatch(/upload exceeds the maximum size/);
  });

  it("hands a tRPC request at the limit to the adapter", async () => {
    const error = await trpcImport(MAX_REQUEST_BODY_BYTES);
    // The adapter parses the cut-off body itself and fails on it.
    expect(error.data.appErrorCode).toBeNull();
    expect(error.message).toMatch(/JSON/);
  });

  it("serves a GET whatever length it declares", async () => {
    const response = await trpcGet(
      new Request("http://localhost/api/trpc/auth.signupConfig", {
        headers: { cookie, "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
      })
    );
    expect(response.status).toBe(200);
  });

  it("answers a REST request declaring too many bytes in the REST error format", async () => {
    const response = await restPost(
      cutOffRequest("http://localhost/api/v1/collections/import-ebook", MAX_REQUEST_BODY_BYTES + 1)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string; data: { appErrorCode: string } };
    expect(body.data.appErrorCode).toBe("CONTENT_TOO_LARGE");
    expect(body.message).toMatch(/upload exceeds the maximum size/);
  });
});
