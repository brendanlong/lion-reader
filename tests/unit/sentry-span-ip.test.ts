/**
 * Unit tests for span-level IP stripping, and for the data-collection posture
 * the SDK resolves to.
 *
 * Both guard the same thing from opposite ends: Sentry's HTTP server
 * instrumentation puts the caller's IP on transaction spans, and the settings
 * that would otherwise keep IP-bearing headers out of those spans are SDK
 * defaults we don't set — so an SDK upgrade could move them without any change
 * here.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as Sentry from "@sentry/nextjs";
import type { Event } from "@sentry/nextjs";
import { stripIpSpanAttributes } from "../../src/server/sentry";

describe("stripIpSpanAttributes", () => {
  it("removes the caller IP from the root span", () => {
    const event: Event = {
      type: "transaction",
      contexts: {
        trace: {
          span_id: "a",
          trace_id: "b",
          data: {
            "http.client_ip": "203.0.113.7",
            "net.peer.ip": "198.51.100.2",
            "http.method": "GET",
          },
        },
      },
    };

    stripIpSpanAttributes(event);

    expect(event.contexts?.trace?.data).toEqual({ "http.method": "GET" });
  });

  it("removes the caller IP from child spans too", () => {
    const event: Event = {
      type: "transaction",
      spans: [
        {
          span_id: "a",
          trace_id: "b",
          start_timestamp: 0,
          data: { "http.client_ip": "203.0.113.7", "db.system": "postgresql" },
        },
      ],
    };

    stripIpSpanAttributes(event);

    expect(event.spans?.[0]?.data).toEqual({ "db.system": "postgresql" });
  });

  it("keeps net.host.ip, which is our address and not a user's", () => {
    const event: Event = {
      type: "transaction",
      contexts: { trace: { span_id: "a", trace_id: "b", data: { "net.host.ip": "10.0.0.1" } } },
    };

    stripIpSpanAttributes(event);

    expect(event.contexts?.trace?.data).toEqual({ "net.host.ip": "10.0.0.1" });
  });

  it("tolerates a transaction with no spans and no trace context", () => {
    const event: Event = { type: "transaction" };
    expect(() => stripIpSpanAttributes(event)).not.toThrow();
  });
});

describe("resolved data-collection posture", () => {
  afterEach(() => {
    Sentry.getGlobalScope().setClient(undefined);
  });

  /**
   * We deliberately do NOT pass `dataCollection` to `Sentry.init`. Passing it —
   * even `{}` — switches the resolution baseline from the conservative one to
   * Sentry's DEFAULTS, which turns six categories permissive, including the
   * header deny list that keeps `x-forwarded-for` out of span attributes and
   * the gen-AI capture that would send article text to Sentry.
   *
   * That makes the posture an inherited default, which is exactly the kind of
   * thing that moves under you: the SDK's own source carries a
   * `TODO(v11): ... always fall through to DEFAULTS so that userInfo: true`.
   * This asserts what we actually get, so the upgrade that changes it fails
   * here instead of silently starting to collect.
   */
  it("is conservative without us configuring it", () => {
    Sentry.init({ dsn: "https://examplePublicKey@o0.ingest.sentry.io/0", enabled: false });

    expect(Sentry.getClient()?.getDataCollectionOptions()).toMatchObject({
      userInfo: false,
      httpBodies: [],
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
      cookies: { deny: expect.arrayContaining(["-ip", "forwarded"]) },
      httpHeaders: {
        request: { deny: expect.arrayContaining(["-ip", "forwarded"]) },
        response: { deny: expect.arrayContaining(["-ip", "forwarded"]) },
      },
    });
  });
});
