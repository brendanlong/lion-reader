/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import ConnectedAppsSettingsContent from "@/components/settings/pages/ConnectedAppsSettingsContent";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const app = {
  clientName: null,
  clientHost: null,
  redirectHosts: [],
  redirectsToLocalApp: false,
  unverified: false,
  scopes: [{ name: "mcp", description: "Read and manage your feeds and articles" }],
  grantedAt: new Date(),
  lastUsedAt: null,
};

const handlers: ProcedureHandlers = {
  "oauthGrants.list": () => [
    {
      ...app,
      clientId: "registered",
      clientName: "Claude",
      redirectHosts: ["attacker.example"],
      redirectsToLocalApp: true,
      unverified: true,
    },
    { ...app, clientId: "lion-reader-app", clientName: "Lion Reader app" },
  ],
};

function card(name: string): HTMLElement {
  return screen.getByText(name).closest(".rounded-lg") as HTMLElement;
}

describe("ConnectedAppsSettingsContent", () => {
  it("labels an unverified app and lists where it sends access", async () => {
    renderWithTrpc(<ConnectedAppsSettingsContent />, { handlers });
    await screen.findByText("Claude");

    expect(card("Claude")).toHaveTextContent(/unverified/i);
    expect(card("Claude")).toHaveTextContent("attacker.example");
    expect(card("Claude")).toHaveTextContent(/local app/);
  });

  it("shows a verified app with no label or destinations", async () => {
    renderWithTrpc(<ConnectedAppsSettingsContent />, { handlers });
    await screen.findByText("Lion Reader app");

    expect(card("Lion Reader app")).not.toHaveTextContent(/unverified|sends access/i);
  });
});
