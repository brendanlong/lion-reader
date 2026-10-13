/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import EmailSettingsContent from "@/components/settings/pages/EmailSettingsContent";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("EmailSettingsContent", () => {
  it("says newsletters aren't set up, with no create button, when the server has them off (#1797)", async () => {
    renderWithTrpc(<EmailSettingsContent />, {
      handlers: {
        "ingestAddresses.list": () => ({ enabled: false, items: [] }),
        "users.me.preferences": () => ({ showSpam: false }),
        "blockedSenders.list": () => ({ items: [] }),
      },
    });

    expect(await screen.findByText(/newsletters aren't set up on this server/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /create new address/i })).toBeNull();
  });
});
