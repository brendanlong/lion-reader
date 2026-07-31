/**
 * Analytics path vocabulary and beacon construction.
 *
 * The security property under test is **what never gets sent**: no query
 * string, no entry/subscription/tag id, no document title, no same-origin
 * referrer. Every one of those has carried a secret at some point —
 * `/register?invite=<token>` is a one-time signup credential, and an entry id
 * identifies exactly what one person read. See `src/lib/analytics/paths.ts`.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { DEMO_ARTICLES } from "../../src/app/(public)/demo/articles/index";
import { buildCountUrl } from "../../src/lib/analytics/beacon";
import { goatCounterConfig } from "../../src/lib/analytics/goatcounter";
import {
  analyticsPathForDemoEntry,
  analyticsPathForEntry,
  analyticsPathForRoute,
  demoArticleIds,
} from "../../src/lib/analytics/paths";

describe("analyticsPathForRoute", () => {
  it("maps app routes to coarse constants", () => {
    expect(analyticsPathForRoute("/all")).toBe("/app/list/all");
    expect(analyticsPathForRoute("/saved")).toBe("/app/list/saved");
    expect(analyticsPathForRoute("/settings/ai")).toBe("/app/settings/ai");
    expect(analyticsPathForRoute("/subscribe")).toBe("/app/subscribe");
  });

  it("drops the id from subscription and tag routes", () => {
    // The id identifies what one person follows; the count of "a subscription
    // was viewed" does not.
    expect(analyticsPathForRoute("/subscription/0192f3a4-dead-beef-0000-000000000001")).toBe(
      "/app/list/subscription"
    );
    expect(analyticsPathForRoute("/tag/0192f3a4-dead-beef-0000-000000000002")).toBe(
      "/app/list/tag"
    );
  });

  it("counts /register — the query string is never part of the path", () => {
    // This is why the invite token can't leak: we report a constant, and the
    // function is not even given the query string.
    expect(analyticsPathForRoute("/register")).toBe("/register");
  });

  it("returns null for routes we deliberately don't count", () => {
    for (const path of [
      "/admin",
      "/admin/users",
      "/auth/oauth/complete",
      "/complete-signup",
      "/some/route/added/later",
      "/",
    ]) {
      expect(analyticsPathForRoute(path)).toBeNull();
    }
  });

  it("does not resolve Object.prototype keys as routes", () => {
    // `in` walks the prototype chain, so "/constructor/x" would have reported
    // `function Object() { [native code] }` as the page path.
    for (const path of [
      "/constructor/x",
      "/__proto__/x",
      "/toString/x",
      "/hasOwnProperty/x",
      "/valueOf",
      "/constructor",
    ]) {
      expect(analyticsPathForRoute(path)).toBeNull();
    }
  });

  it("matches whole segments, so a lookalike route isn't misattributed", () => {
    expect(analyticsPathForRoute("/subscriptions-export/x")).toBeNull();
    expect(analyticsPathForRoute("/subscription")).toBeNull();
    expect(analyticsPathForRoute("/subscription/a/b")).toBeNull();
  });

  it("treats a trailing slash as the same route", () => {
    expect(analyticsPathForRoute("/all/")).toBe("/app/list/all");
    expect(analyticsPathForRoute("/")).toBeNull();
  });
});

describe("demo articles", () => {
  it("reports an allowlisted demo article by id", () => {
    // Safe because demo articles are dev-authored marketing constants in this
    // repo, not user data.
    expect(analyticsPathForRoute("/demo/entry/welcome")).toBe("/demo/entry/welcome");
  });

  it("falls back to the bare route for an unknown id", () => {
    expect(analyticsPathForRoute("/demo/entry/not-a-real-article")).toBe("/demo/entry");
    expect(analyticsPathForDemoEntry(undefined)).toBe("/demo/entry");
    expect(analyticsPathForDemoEntry("../../etc/passwd")).toBe("/demo/entry");
  });

  it("keeps the id list in sync with the article registry", () => {
    // The list is duplicated (importing the registry would pull every article
    // body into the app bundle), so this is what keeps it honest.
    expect([...demoArticleIds].sort()).toEqual(DEMO_ARTICLES.map((a) => a.id).sort());
  });
});

describe("analyticsPathForEntry", () => {
  it("reports the entry type and nothing else", () => {
    expect(analyticsPathForEntry("web")).toBe("/app/entry/web");
    expect(analyticsPathForEntry("email")).toBe("/app/entry/email");
    expect(analyticsPathForEntry("saved")).toBe("/app/entry/saved");
  });
});

describe("buildCountUrl", () => {
  const ENDPOINT = "https://example.goatcounter.com/count";

  beforeEach(() => {
    vi.stubGlobal("window", {
      screen: { width: 1280, height: 1024 },
      location: { origin: "https://reader.example.com" },
    });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { referrer: "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const paramsOf = (url: string) => new URL(url).searchParams;

  it("sends the path, screen width and a cache-buster — and nothing else", () => {
    const params = paramsOf(buildCountUrl(ENDPOINT, "/app/list/all", "abc12"));
    expect(params.get("p")).toBe("/app/list/all");
    expect(params.get("s")).toBe("1280");
    expect(params.get("rnd")).toBe("abc12");
    expect([...params.keys()].sort()).toEqual(["p", "rnd", "s"]);
  });

  it("never sends a query string or a title", () => {
    // `q` is what leaked invite tokens in GoatCounter's own count.js; `t` is
    // document.title, which is the article you are reading.
    const params = paramsOf(buildCountUrl(ENDPOINT, "/register", "abc12"));
    expect(params.get("q")).toBeNull();
    expect(params.get("t")).toBeNull();
  });

  it("drops a same-origin referrer", () => {
    // Navigating away from /register?invite=<token> would otherwise report the
    // token as the next page's referrer — the same leak, a different field.
    vi.stubGlobal("document", {
      referrer: "https://reader.example.com/register?invite=SECRET",
    });
    const params = paramsOf(buildCountUrl(ENDPOINT, "/login", "abc12"));
    expect(params.get("r")).toBeNull();
    expect(buildCountUrl(ENDPOINT, "/login", "abc12")).not.toContain("SECRET");
  });

  it("sends only the origin of a cross-origin referrer", () => {
    vi.stubGlobal("document", { referrer: "https://news.ycombinator.com/item?id=123" });
    const params = paramsOf(buildCountUrl(ENDPOINT, "/demo", "abc12"));
    expect(params.get("r")).toBe("https://news.ycombinator.com");
  });

  it("omits the referrer when asked to (every beacon after the first)", () => {
    // document.referrer is fixed for the document's lifetime, so sending it on
    // every SPA route change would report one arrival as dozens.
    vi.stubGlobal("document", { referrer: "https://news.ycombinator.com/item?id=1" });
    const first = paramsOf(buildCountUrl(ENDPOINT, "/demo", "abc12", true));
    const later = paramsOf(buildCountUrl(ENDPOINT, "/demo", "abc13", false));
    expect(first.get("r")).toBe("https://news.ycombinator.com");
    expect(later.get("r")).toBeNull();
  });

  it("flags automated browsers", () => {
    vi.stubGlobal("navigator", { webdriver: true });
    expect(paramsOf(buildCountUrl(ENDPOINT, "/demo", "abc12")).get("b")).toBe("153");
  });
});

describe("goatCounterConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives the beacon origin from the configured endpoint", () => {
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "https://lionreader.goatcounter.com/count");
    expect(goatCounterConfig()).toEqual({
      endpoint: "https://lionreader.goatcounter.com/count",
      origin: "https://lionreader.goatcounter.com",
    });
  });

  it("is disabled when unset — the default for dev and self-hosted builds", () => {
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "");
    expect(goatCounterConfig()).toBeNull();
  });

  it("is disabled when the URL is malformed", () => {
    // The beacon and the CSP both resolve through this, so a bad value must
    // disable them together rather than ship one without the other.
    vi.stubEnv("NEXT_PUBLIC_GOATCOUNTER_URL", "not a url");
    expect(goatCounterConfig()).toBeNull();
  });
});
