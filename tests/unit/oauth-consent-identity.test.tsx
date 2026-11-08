/**
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsentForm } from "@/app/(spa)/oauth/consent/ConsentForm";
import { consentClientIdentity } from "@/app/(spa)/oauth/consent/client-identity";
import { APP_CLIENT_ID } from "@/server/oauth/app-client";
import { PINNED_CLIENT_METADATA } from "@/server/oauth/cimd";

function renderConsent(clientId: string, name: string, redirectUri: string): string {
  const { host, unverified } = consentClientIdentity(clientId, redirectUri);
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
  it.each([
    ["a registered client", "some-registered-id"],
    ["a CIMD client", "https://claude-connector.example/meta"],
  ])("leads %s with its redirect host and marks it unverified", (_, clientId) => {
    const heading = renderConsent(clientId, "Claude", "https://attacker.example.com/cb");
    expect(heading).toContain("attacker.example.com");
    expect(heading).not.toContain("Claude");
    expect(screen.getByText(/unverified/i)).toBeTruthy();
    expect(screen.getByText(/identifies itself as/)).toHaveTextContent("Claude");
  });

  it("doesn't name a loopback redirect's host or port as the client", () => {
    const heading = renderConsent("some-registered-id", "Claude Code", "http://localhost:33418/cb");
    expect(heading).not.toMatch(/localhost|33418|Claude Code/);
    expect(screen.getByText(/unverified/i)).toBeTruthy();
  });

  it("doesn't mark a vendored client unverified", () => {
    const [clientId, metadata] = [...PINNED_CLIENT_METADATA][0];
    renderConsent(clientId, metadata.client_name ?? "", metadata.redirect_uris[0]);
    expect(screen.queryByText(/unverified/i)).toBeNull();
  });

  it("shows our own app by name, verified", () => {
    const heading = renderConsent(
      APP_CLIENT_ID,
      "Lion Reader",
      "https://lionreader.com/oauth/app-callback"
    );
    expect(heading).toContain("Lion Reader");
    expect(screen.queryByText(/unverified/i)).toBeNull();
  });
});
