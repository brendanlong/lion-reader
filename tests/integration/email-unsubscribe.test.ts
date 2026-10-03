/**
 * Integration tests for sending List-Unsubscribe requests to newsletter senders
 * (#1770). A local HTTP server stands in for the sender's one-click endpoint
 * (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users } from "../../src/server/db/schema";
import { attemptUnsubscribe } from "../../src/server/email/unsubscribe";
import { createTestEntry, createTestFeed, createTestUser } from "./helpers";

interface ReceivedRequest {
  method: string | undefined;
  path: string | undefined;
  body: string;
}

let server: Server;
let baseUrl: string;
let received: ReceivedRequest[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      received.push({ method: req.method, path: req.url, body });
      res.writeHead(req.url === "/broken" ? 500 : 200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

beforeEach(() => {
  received = [];
});

async function createEmailFeed(): Promise<string> {
  const userId = await createTestUser();
  createdUserIds.push(userId);
  return createTestFeed({
    type: "email",
    userId,
    url: null,
    emailSenderPattern: `sender-${userId}@example.com`,
  });
}

describe("attemptUnsubscribe", () => {
  it("sends the one-click POST even when a mailto: is also offered", async () => {
    const feedId = await createEmailFeed();
    await createTestEntry(feedId, {
      type: "email",
      listUnsubscribeMailto: "mailto:unsubscribe@example.com",
      listUnsubscribeHttps: `${baseUrl}/unsub`,
      listUnsubscribePost: true,
    });

    const result = await attemptUnsubscribe(feedId);

    expect(result).toEqual({ sent: true, method: "https" });
    expect(received).toEqual([
      { method: "POST", path: "/unsub", body: "List-Unsubscribe=One-Click" },
    ]);
  });

  it("does not report a rejected one-click POST as sent", async () => {
    const feedId = await createEmailFeed();
    await createTestEntry(feedId, {
      type: "email",
      listUnsubscribeHttps: `${baseUrl}/broken`,
      listUnsubscribePost: true,
    });

    const result = await attemptUnsubscribe(feedId);

    expect(result.sent).toBe(false);
    expect(received.map((r) => r.path)).toEqual(["/broken"]);
  });

  it("does not report a mailto-only sender as unsubscribed", async () => {
    const feedId = await createEmailFeed();
    await createTestEntry(feedId, {
      type: "email",
      listUnsubscribeMailto: "mailto:unsubscribe@example.com",
    });

    const result = await attemptUnsubscribe(feedId);

    expect(result.sent).toBe(false);
    expect(received).toEqual([]);
  });

  it("does not request an HTTPS URL that lacks one-click support", async () => {
    const feedId = await createEmailFeed();
    await createTestEntry(feedId, {
      type: "email",
      listUnsubscribeHttps: `${baseUrl}/unsub`,
      listUnsubscribePost: false,
    });

    const result = await attemptUnsubscribe(feedId);

    expect(result.sent).toBe(false);
    expect(received).toEqual([]);
  });

  it("uses an older one-click entry when the newest only offers mailto:", async () => {
    const feedId = await createEmailFeed();
    await createTestEntry(feedId, {
      type: "email",
      listUnsubscribeHttps: `${baseUrl}/older`,
      listUnsubscribePost: true,
    });
    await createTestEntry(feedId, {
      type: "email",
      listUnsubscribeMailto: "mailto:unsubscribe@example.com",
    });

    const result = await attemptUnsubscribe(feedId);

    expect(result).toEqual({ sent: true, method: "https" });
    expect(received.map((r) => r.path)).toEqual(["/older"]);
  });
});
