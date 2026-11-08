/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsentForm } from "@/app/(spa)/oauth/consent/ConsentForm";
import { consentClientIdentity } from "@/app/(spa)/oauth/consent/client-identity";

function renderConsent(clientId: string, fromDatabase: boolean, name: string, redirectUri: string) {
  const { host, unverified } = consentClientIdentity(clientId, { fromDatabase }, redirectUri);
  render(
    <ConsentForm
      clientName={name}
      clientHost={host}
      unverified={unverified}
      clientId={clientId}
      redirectUri={redirectUri}
      scopes={[{ name: "mcp", description: "Access via MCP" }]}
      scopeString="mcp"
      codeChallenge="challenge"
    />
  );
  return screen.getByRole("heading", { level: 2 }).textContent ?? "";
}

describe("consent screen client identity", () => {
  it("leads a registered client with its redirect host and marks it unverified", () => {
    const heading = renderConsent(
      "some-registered-id",
      true,
      "Claude",
      "https://attacker.example.com/cb"
    );
    expect(heading).toContain("attacker.example.com");
    expect(heading).not.toContain("Claude");
    expect(screen.getByText(/unverified/i)).toBeTruthy();
    expect(screen.getByText(/identifies itself as/)).toHaveTextContent("Claude");
  });

  it("doesn't name a loopback redirect's host or port as the client", () => {
    const heading = renderConsent(
      "some-registered-id",
      true,
      "Claude Code",
      "http://localhost:33418/callback"
    );
    expect(heading).not.toMatch(/localhost|33418|Claude Code/);
    expect(screen.getByText(/unverified/i)).toBeTruthy();
  });

  it("leads a CIMD client with its client_id host and doesn't mark it unverified", () => {
    const heading = renderConsent(
      "https://claude.ai/oauth/mcp-oauth-client-metadata",
      false,
      "Claude",
      "https://claude.ai/api/mcp/auth_callback"
    );
    expect(heading).toContain("claude.ai");
    expect(screen.queryByText(/unverified/i)).toBeNull();
  });
});
