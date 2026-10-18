/**
 * Unit tests for keeping caller IPs and request data out of what the server
 * SDK sends. Both run our real init options through the SDK, because the
 * failure mode is the SDK changing around us: v11 made `dataCollection`
 * permissive when unset and stopped calling `beforeSendTransaction`, either of
 * which would have silently started sending IPs with no change here.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { serverSentryOptions } from "../../src/server/sentry";

const DSN = "https://publicKey@o0.ingest.sentry.io/0";

function initForTest(): unknown[] {
  const sentItems: unknown[] = [];
  Sentry.init({
    ...serverSentryOptions(DSN),
    enabled: true,
    tracesSampleRate: 1,
    transport: () => ({ send: async () => ({}), flush: async () => true }),
  });
  Sentry.getClient()?.on("beforeEnvelope", (envelope) => {
    for (const [, payload] of envelope[1]) sentItems.push(payload);
  });
  return sentItems;
}

afterEach(async () => {
  await Sentry.close();
  Sentry.getGlobalScope().setClient(undefined);
});

describe("server span IP stripping", () => {
  it("removes the caller IP from root and child spans, keeping our own address", async () => {
    const sent = initForTest();
    const ipAttributes = {
      "client.address": "203.0.113.7",
      "network.peer.address": "198.51.100.2",
    };

    Sentry.startSpan(
      { name: "root", attributes: { ...ipAttributes, "network.local.address": "10.0.0.1" } },
      () => {
        Sentry.startSpan({ name: "child", attributes: ipAttributes }, () => {});
      }
    );
    await Sentry.flush();

    const payload = JSON.stringify(sent);
    expect(payload).toContain('"root"');
    expect(payload).toContain('"child"');
    expect(payload).toContain("10.0.0.1");
    expect(payload).not.toContain("203.0.113.7");
    expect(payload).not.toContain("198.51.100.2");
  });
});

describe("resolved data-collection posture", () => {
  it("collects no user info, cookies, bodies, query data, or gen-AI content", () => {
    initForTest();

    expect(Sentry.getClient()?.getDataCollectionOptions()).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      databaseQueryData: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      httpHeaders: {
        request: { deny: expect.arrayContaining(["-ip", "forwarded"]) },
        response: { deny: expect.arrayContaining(["-ip", "forwarded"]) },
      },
    });
  });
});
