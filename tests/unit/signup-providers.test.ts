import { describe, it, expect, afterEach } from "vitest";

import { resolveSignupProviderAccess } from "@/server/auth/signup-providers";
import { signupConfig } from "@/server/config/env";

describe("resolveSignupProviderAccess", () => {
  it("denies a provider not in the allowlist", () => {
    expect(
      resolveSignupProviderAccess("discord", {
        allowedSignupProviders: ["email", "google", "apple"],
        publicSignupProviders: ["google", "apple"],
      })
    ).toBe("denied");
  });

  it("treats a provider in the public list as public", () => {
    expect(
      resolveSignupProviderAccess("google", {
        allowedSignupProviders: ["email", "google", "apple"],
        publicSignupProviders: ["google", "apple"],
      })
    ).toBe("public");
  });

  it("treats an allowed-but-not-public provider as invite-only", () => {
    expect(
      resolveSignupProviderAccess("email", {
        allowedSignupProviders: ["email", "google", "apple"],
        publicSignupProviders: ["google", "apple"],
      })
    ).toBe("invite-only");
  });

  it("makes every allowed provider invite-only when the public list is empty", () => {
    for (const provider of ["email", "google"] as const) {
      expect(
        resolveSignupProviderAccess(provider, {
          allowedSignupProviders: ["email", "google", "apple", "discord"],
          publicSignupProviders: [],
        })
      ).toBe("invite-only");
    }
  });

  it("makes every allowed provider public when all are listed publicly", () => {
    const all = ["email", "google", "apple", "discord"] as const;
    for (const provider of all) {
      expect(
        resolveSignupProviderAccess(provider, {
          allowedSignupProviders: all,
          publicSignupProviders: all,
        })
      ).toBe("public");
    }
  });
});

describe("signupConfig provider parsing", () => {
  const ORIGINAL = {
    allowed: process.env.ALLOWED_SIGNUP_PROVIDERS,
    public: process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS,
  };

  afterEach(() => {
    // Restore so we don't leak env into other tests (getters read env lazily).
    process.env.ALLOWED_SIGNUP_PROVIDERS = ORIGINAL.allowed;
    process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = ORIGINAL.public;
    if (ORIGINAL.allowed === undefined) delete process.env.ALLOWED_SIGNUP_PROVIDERS;
    if (ORIGINAL.public === undefined) delete process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS;
  });

  it("defaults to all-allowed, none-public (fully invite-only)", () => {
    delete process.env.ALLOWED_SIGNUP_PROVIDERS;
    delete process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS;
    expect([...signupConfig.allowedSignupProviders].sort()).toEqual([
      "apple",
      "discord",
      "email",
      "google",
    ]);
    expect(signupConfig.publicSignupProviders).toEqual([]);
  });

  it("trims, lowercases, drops unknowns, and dedupes duplicates", () => {
    process.env.ALLOWED_SIGNUP_PROVIDERS = " Google , google ,email, bogus ";
    process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = "";
    expect(signupConfig.allowedSignupProviders).toEqual(["google", "email"]);
  });

  it("intersects the public list with the allowlist (cannot widen access)", () => {
    process.env.ALLOWED_SIGNUP_PROVIDERS = "google,apple";
    // discord is not in the allowlist, so it must be dropped from public.
    process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = "google,discord";
    expect(signupConfig.publicSignupProviders).toEqual(["google"]);
  });

  it("falls back to all when the allowlist is set but has no known providers", () => {
    process.env.ALLOWED_SIGNUP_PROVIDERS = "bogus,nonsense";
    expect([...signupConfig.allowedSignupProviders].sort()).toEqual([
      "apple",
      "discord",
      "email",
      "google",
    ]);
  });
});
