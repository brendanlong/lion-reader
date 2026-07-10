/**
 * Integration tests for the Mailgun inbound-email webhook route.
 *
 * The failure modes here are silent (dropped newsletters, not errors), so these
 * tests pin the route's security/durability invariants against a real Postgres
 * and Redis:
 *
 * - a correctly signed, fresh webhook creates an entry (end-to-end)
 * - a stale timestamp is rejected with 406 (replay bound)
 * - a REPLAY of an already-completed request — same signed (timestamp, token,
 *   signature) triple but a different body/Message-ID, i.e. what an attacker
 *   with a captured triple would send — is acked 200 but NOT processed
 *   (the Redis nonce, not Message-ID dedup, blocks it)
 * - a bad signature / missing fields are rejected with 406
 *
 * The signing key is injected via env BEFORE the route module is imported,
 * because `ingestConfig` freezes `process.env` values at import time.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHmac, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, ingestAddresses, entries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";

const SIGNING_KEY = "test-mailgun-signing-key";
process.env.MAILGUN_WEBHOOK_SIGNING_KEY = SIGNING_KEY;

// Dynamic import AFTER the env var is set — the route reads the key from the
// import-time-frozen ingestConfig.
const { POST } = await import("../../src/app/api/webhooks/email/mailgun/route");

/** Signs (timestamp, token) the way Mailgun does: HMAC-SHA256(timestamp + token). */
function sign(timestamp: string, token: string): string {
  return createHmac("sha256", SIGNING_KEY)
    .update(timestamp + token)
    .digest("hex");
}

interface WebhookFields {
  timestamp?: string;
  token?: string;
  signature?: string;
  from?: string;
  recipient?: string;
  subject?: string;
  bodyPlain?: string;
  messageId?: string;
}

/** Builds a signed Mailgun webhook Request. Omit a field by passing "". */
function buildWebhookRequest(fields: WebhookFields): Request {
  const timestamp = fields.timestamp ?? String(Math.floor(Date.now() / 1000));
  const token = fields.token ?? randomBytes(16).toString("hex");
  const signature = fields.signature ?? sign(timestamp, token);

  const form = new FormData();
  if (timestamp) form.set("timestamp", timestamp);
  if (token) form.set("token", token);
  if (signature) form.set("signature", signature);
  form.set("from", fields.from ?? "Sender <sender@example.com>");
  if (fields.recipient) form.set("recipient", fields.recipient);
  form.set("subject", fields.subject ?? "Test Subject");
  form.set("body-plain", fields.bodyPlain ?? "Hello from the test.");
  form.set(
    "message-headers",
    JSON.stringify([["Message-Id", `<${fields.messageId ?? generateUuidv7()}@example.com>`]])
  );

  return new Request("http://localhost/api/webhooks/email/mailgun", {
    method: "POST",
    body: form,
  });
}

/** Creates a user with an ingest address; returns the recipient address. */
async function createIngestRecipient(): Promise<string> {
  const userId = generateUuidv7();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `mailgun-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: now,
    updatedAt: now,
  });
  const token = `mg${randomBytes(8).toString("hex")}`;
  await db.insert(ingestAddresses).values({
    id: generateUuidv7(),
    userId,
    token,
    createdAt: now,
  });
  return `${token}@ingest.lionreader.com`;
}

async function countEntriesTitled(subject: string): Promise<number> {
  const rows = await db.select({ id: entries.id }).from(entries).where(eq(entries.title, subject));
  return rows.length;
}

describe("Mailgun webhook route", () => {
  let recipient: string;

  beforeEach(async () => {
    recipient = await createIngestRecipient();
  });

  it("processes a correctly signed, fresh webhook end-to-end (entry created)", async () => {
    const subject = `Fresh delivery ${generateUuidv7()}`;
    const response = await POST(buildWebhookRequest({ recipient, subject }));
    expect(response.status).toBe(200);
    expect(await countEntriesTitled(subject)).toBe(1);
  });

  it("rejects a stale timestamp with 406 (outside the freshness window)", async () => {
    const subject = `Stale delivery ${generateUuidv7()}`;
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60 * 60); // 10h old > 9h window
    const response = await POST(
      buildWebhookRequest({ recipient, subject, timestamp: staleTimestamp })
    );
    expect(response.status).toBe(406);
    expect(await countEntriesTitled(subject)).toBe(0);
  });

  it("accepts a timestamp hours old but within the Mailgun retry horizon", async () => {
    // Mailgun retries reuse the ORIGINAL timestamp for up to ~8h; a 4h-old
    // timestamp is a legitimate late retry and must not be dropped.
    const subject = `Late retry ${generateUuidv7()}`;
    const retryTimestamp = String(Math.floor(Date.now() / 1000) - 4 * 60 * 60);
    const response = await POST(
      buildWebhookRequest({ recipient, subject, timestamp: retryTimestamp })
    );
    expect(response.status).toBe(200);
    expect(await countEntriesTitled(subject)).toBe(1);
  });

  it("acks but does NOT process a replay of a completed request (same signed triple, different body)", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = randomBytes(16).toString("hex");
    const signature = sign(timestamp, token);

    // Original delivery completes and marks the token seen.
    const originalSubject = `Original ${generateUuidv7()}`;
    const first = await POST(
      buildWebhookRequest({ recipient, subject: originalSubject, timestamp, token, signature })
    );
    expect(first.status).toBe(200);
    expect(await countEntriesTitled(originalSubject)).toBe(1);

    // Attacker replays the captured triple with attacker-controlled content and
    // a DIFFERENT Message-ID (so Message-ID dedup alone would not stop it).
    const injectedSubject = `Injected ${generateUuidv7()}`;
    const replay = await POST(
      buildWebhookRequest({
        recipient,
        subject: injectedSubject,
        timestamp,
        token,
        signature,
        messageId: generateUuidv7(),
        bodyPlain: "attacker content",
      })
    );
    expect(replay.status).toBe(200); // acked, no retry storm
    expect(await countEntriesTitled(injectedSubject)).toBe(0); // but NOT ingested
  });

  it("rejects an invalid signature with 406", async () => {
    const subject = `Bad signature ${generateUuidv7()}`;
    const response = await POST(
      buildWebhookRequest({ recipient, subject, signature: "0".repeat(64) })
    );
    expect(response.status).toBe(406);
    expect(await countEntriesTitled(subject)).toBe(0);
  });

  it("rejects missing signature fields with 406", async () => {
    const subject = `Missing fields ${generateUuidv7()}`;
    const response = await POST(
      buildWebhookRequest({ recipient, subject, token: "", signature: "" })
    );
    expect(response.status).toBe(406);
    expect(await countEntriesTitled(subject)).toBe(0);
  });
});
