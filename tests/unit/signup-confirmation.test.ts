import { describe, it, expect, afterEach } from "vitest";

import { isSignupConfirmed } from "@/server/auth/confirmation";
import { signupConfig } from "@/server/config/env";

const NEVER = null;
const NOW = new Date("2026-07-16T00:00:00.000Z");

function user(overrides: {
  tosAgreedAt: Date | null;
  privacyPolicyAgreedAt: Date | null;
  notEuAgreedAt: Date | null;
}) {
  return overrides;
}

describe("isSignupConfirmed", () => {
  const ORIGINAL_EU = process.env.EU_RESTRICTED;

  afterEach(() => {
    // Restore so we don't leak env into other tests (the getter reads it lazily).
    process.env.EU_RESTRICTED = ORIGINAL_EU;
    if (ORIGINAL_EU === undefined) delete process.env.EU_RESTRICTED;
  });

  it("exposes euRestricted=false by default", () => {
    delete process.env.EU_RESTRICTED;
    expect(signupConfig.euRestricted).toBe(false);
  });

  it("exposes euRestricted=true only for the literal string 'true'", () => {
    process.env.EU_RESTRICTED = "true";
    expect(signupConfig.euRestricted).toBe(true);
    process.env.EU_RESTRICTED = "false";
    expect(signupConfig.euRestricted).toBe(false);
    process.env.EU_RESTRICTED = "1";
    expect(signupConfig.euRestricted).toBe(false);
  });

  describe("when the instance is not EU-restricted", () => {
    it("is confirmed with ToS + Privacy even without the EU certification", () => {
      delete process.env.EU_RESTRICTED;
      expect(
        isSignupConfirmed(
          user({ tosAgreedAt: NOW, privacyPolicyAgreedAt: NOW, notEuAgreedAt: NEVER })
        )
      ).toBe(true);
    });

    it("is not confirmed while ToS or Privacy is missing", () => {
      delete process.env.EU_RESTRICTED;
      expect(
        isSignupConfirmed(
          user({ tosAgreedAt: NEVER, privacyPolicyAgreedAt: NOW, notEuAgreedAt: NEVER })
        )
      ).toBe(false);
      expect(
        isSignupConfirmed(
          user({ tosAgreedAt: NOW, privacyPolicyAgreedAt: NEVER, notEuAgreedAt: NEVER })
        )
      ).toBe(false);
    });
  });

  describe("when the instance is EU-restricted", () => {
    it("requires the EU certification in addition to ToS + Privacy", () => {
      process.env.EU_RESTRICTED = "true";
      expect(
        isSignupConfirmed(
          user({ tosAgreedAt: NOW, privacyPolicyAgreedAt: NOW, notEuAgreedAt: NEVER })
        )
      ).toBe(false);
      expect(
        isSignupConfirmed(
          user({ tosAgreedAt: NOW, privacyPolicyAgreedAt: NOW, notEuAgreedAt: NOW })
        )
      ).toBe(true);
    });
  });
});
