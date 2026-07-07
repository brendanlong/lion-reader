/**
 * Unit tests for Sentry request-param redaction.
 *
 * Some Google Reader clients pass credentials in the URL query string even on a
 * POST (FeedMe sends `Passwd` on the ClientLogin URL). Sentry can capture that
 * URL as request data, so redactSensitiveRequestParams must strip the values
 * before an event is sent.
 */

import { describe, it, expect } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { redactSensitiveRequestParams } from "../../src/server/sentry";

function eventWith(request: ErrorEvent["request"]): ErrorEvent {
  return { type: undefined, request } as ErrorEvent;
}

describe("redactSensitiveRequestParams", () => {
  it("redacts the Google Reader Passwd (and Email) in a captured URL", () => {
    const event = eventWith({
      url: "https://lionreader.com/api/greader.php/accounts/ClientLogin?Email=a%40b.com&Passwd=hunter2",
    });
    redactSensitiveRequestParams(event);
    expect(event.request?.url).toBe(
      "https://lionreader.com/api/greader.php/accounts/ClientLogin?Email=[REDACTED]&Passwd=[REDACTED]"
    );
  });

  it("redacts sensitive params in a bare query_string", () => {
    const event = eventWith({ query_string: "Passwd=hunter2&s=reading-list" });
    redactSensitiveRequestParams(event);
    expect(event.request?.query_string).toBe("Passwd=[REDACTED]&s=reading-list");
  });

  it("is case-insensitive and covers OAuth secrets", () => {
    const event = eventWith({
      url: "https://x.test/oauth/token?password=p&CLIENT_SECRET=s&code=keep",
    });
    redactSensitiveRequestParams(event);
    expect(event.request?.url).toBe(
      "https://x.test/oauth/token?password=[REDACTED]&CLIENT_SECRET=[REDACTED]&code=keep"
    );
  });

  it("leaves non-sensitive params untouched", () => {
    const event = eventWith({
      url: "https://x.test/reader/api/0/stream/items/ids?s=reading-list&n=1000",
    });
    redactSensitiveRequestParams(event);
    expect(event.request?.url).toBe(
      "https://x.test/reader/api/0/stream/items/ids?s=reading-list&n=1000"
    );
  });

  it("redacts the uppercase T write-token but keeps the lowercase t tag/title param", () => {
    // `T` = Google Reader write/session token (secret); lowercase `t` = tag name
    // (disable-tag) / feed title (subscription/edit), which must stay visible.
    const event = eventWith({ query_string: "T=sessionsecret&t=my-tag-name&s=reading-list" });
    redactSensitiveRequestParams(event);
    expect(event.request?.query_string).toBe("T=[REDACTED]&t=my-tag-name&s=reading-list");
  });

  it("does not match sensitive names embedded in other param names", () => {
    // `nt`/`xt`/`ot` (timestamp/exclude params) must not be caught by the `T`
    // rule, and `someemail` must not be caught by `email`.
    const event = eventWith({
      url: "https://x.test/reader/api/0/stream/items/ids?ot=1&nt=2&xt=read&someemail=x",
    });
    redactSensitiveRequestParams(event);
    expect(event.request?.url).toBe(
      "https://x.test/reader/api/0/stream/items/ids?ot=1&nt=2&xt=read&someemail=x"
    );
  });

  it("does not throw when there is no request context", () => {
    const event = eventWith(undefined);
    expect(() => redactSensitiveRequestParams(event)).not.toThrow();
  });
});
