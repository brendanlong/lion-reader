import { describe, it, expect, afterEach } from "vitest";

import { buildContentSecurityPolicy, buildPublicContentSecurityPolicy } from "@/server/http/csp";
import { TURNSTILE_ORIGIN } from "@/lib/turnstile";

function directive(policy: string, name: string): string {
  return policy.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
}

const ENV_KEYS = ["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("Turnstile in the CSP", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("is allowed on the public pages only, and only when configured", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(buildPublicContentSecurityPolicy()).not.toContain(TURNSTILE_ORIGIN);

    process.env.TURNSTILE_SITE_KEY = "site";
    process.env.TURNSTILE_SECRET_KEY = "secret";
    const publicPolicy = buildPublicContentSecurityPolicy();
    expect(directive(publicPolicy, "script-src")).toContain(TURNSTILE_ORIGIN);
    expect(directive(publicPolicy, "frame-src")).toContain(TURNSTILE_ORIGIN);
    expect(buildContentSecurityPolicy("nonce")).not.toContain(TURNSTILE_ORIGIN);
  });
});
