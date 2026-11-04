import { describe, it, expect, afterEach } from "vitest";

import { buildContentSecurityPolicy, buildPublicContentSecurityPolicy } from "@/server/http/csp";
import { TURNSTILE_ORIGIN } from "@/lib/turnstile";

function directive(policy: string, name: string): string {
  return policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
}

describe("Turnstile in the CSP", () => {
  afterEach(() => {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  });

  it("is allowed on the public pages only, and only when configured", () => {
    expect(buildPublicContentSecurityPolicy()).not.toContain(TURNSTILE_ORIGIN);

    process.env.TURNSTILE_SITE_KEY = "site";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    const publicPolicy = buildPublicContentSecurityPolicy();
    expect(directive(publicPolicy, "script-src")).toContain(TURNSTILE_ORIGIN);
    expect(directive(publicPolicy, "frame-src")).toContain(TURNSTILE_ORIGIN);
    expect(buildContentSecurityPolicy("nonce")).not.toContain(TURNSTILE_ORIGIN);
  });
});
