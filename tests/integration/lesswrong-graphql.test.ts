/**
 * Integration tests for `lessWrongGraphql`, the one transport every LessWrong
 * lookup (posts, comments, users, post metadata) goes through.
 *
 * The contract worth pinning is the failure handling, because it used to be
 * copied per lookup and drifted (#1548): every failure returns null except a
 * 429, which must throw so callers don't fall back to re-fetching the site
 * that just throttled them. Driven against a loopback server (`.env.test` sets
 * ALLOW_PRIVATE_NETWORK_FETCH) rather than mocked.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { z } from "zod";
import { lessWrongGraphql } from "../../src/server/feed/lesswrong";
import { HttpFetchError } from "../../src/server/http/fetch";
import { USER_AGENT } from "../../src/server/http/user-agent";

const userDataSchema = z.object({
  user: z.object({ result: z.object({ _id: z.string() }).nullable() }).nullable(),
});

const QUERY =
  "query GetUser($slug: String!) { user(input: { selector: { slug: $slug } }) { result { _id } } }";

interface RecordedRequest {
  method: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let baseUrl: string;
let lastRequest: RecordedRequest | null = null;

function respond(path: string): { status: number; body: string } {
  switch (path) {
    case "/ok":
      return { status: 200, body: JSON.stringify({ data: { user: { result: { _id: "u1" } } } }) };
    case "/missing":
      return { status: 200, body: JSON.stringify({ data: { user: { result: null } } }) };
    case "/null-data":
      return { status: 200, body: JSON.stringify({ data: null }) };
    case "/graphql-errors":
      return {
        status: 200,
        body: JSON.stringify({ data: null, errors: [{ message: "not allowed" }] }),
      };
    case "/wrong-shape":
      return { status: 200, body: JSON.stringify({ data: { user: { result: { _id: 42 } } } }) };
    case "/not-json":
      return { status: 200, body: "<html>maintenance</html>" };
    case "/rate-limited":
      return { status: 429, body: "slow down" };
    case "/server-error":
      return { status: 500, body: "boom" };
    default:
      return { status: 404, body: "no such route" };
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      lastRequest = {
        method: req.method,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const { status, body } = respond(req.url ?? "/");
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function query(path: string) {
  return lessWrongGraphql(
    {
      query: QUERY,
      variables: { slug: "alice" },
      dataSchema: userDataSchema,
      logContext: { operation: "test", slug: "alice" },
    },
    `${baseUrl}${path}`
  );
}

describe("lessWrongGraphql", () => {
  it("posts the query as JSON with our User-Agent and returns the validated data", async () => {
    const data = await query("/ok");

    expect(data).toEqual({ user: { result: { _id: "u1" } } });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.headers["content-type"]).toBe("application/json");
    expect(lastRequest?.headers["user-agent"]).toBe(USER_AGENT);
    expect(JSON.parse(lastRequest?.body ?? "")).toEqual({
      query: QUERY,
      variables: { slug: "alice" },
    });
  });

  it("returns the data as-is when the lookup finds nothing, leaving that to the caller", async () => {
    expect(await query("/missing")).toEqual({ user: { result: null } });
  });

  it("throws HttpFetchError on 429 so callers can't fall back to the same throttled site", async () => {
    const error = await query("/rate-limited").catch((e: unknown) => e);

    if (!(error instanceof HttpFetchError)) {
      throw new Error(`expected HttpFetchError, got ${String(error)}`);
    }
    expect(error.isRateLimited()).toBe(true);
    expect(error.url).toBe(`${baseUrl}/rate-limited`);
  });

  it("returns null on other HTTP failures", async () => {
    expect(await query("/server-error")).toBeNull();
    expect(await query("/nonexistent")).toBeNull();
  });

  it("returns null when data is null without errors", async () => {
    expect(await query("/null-data")).toBeNull();
  });

  it("returns null when the response carries GraphQL errors", async () => {
    expect(await query("/graphql-errors")).toBeNull();
  });

  it("returns null when the data doesn't match the schema", async () => {
    expect(await query("/wrong-shape")).toBeNull();
  });

  it("returns null when the body isn't JSON", async () => {
    expect(await query("/not-json")).toBeNull();
  });
});
