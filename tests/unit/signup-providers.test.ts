import { describe, it, expect } from "vitest";

import { resolveSignupProviderAccess } from "@/server/auth/signup-providers";

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
