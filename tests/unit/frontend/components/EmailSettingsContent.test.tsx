/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import EmailSettingsContent from "@/components/settings/pages/EmailSettingsContent";
import { procedureError } from "@/lib/trpc/handler-link";
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

  it.each([
    ["keeps", () => ({ showSpam: true }), true],
    [
      "drops",
      () => {
        throw procedureError("INTERNAL_SERVER_ERROR", "boom");
      },
      false,
    ],
  ])(
    "flips the spam switch while the update is in flight, and %s it after",
    async (_name, respond, settled) => {
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      renderWithTrpc(<EmailSettingsContent />, {
        handlers: {
          "ingestAddresses.list": () => ({ enabled: true, items: [] }),
          "users.me.preferences": () => ({ showSpam: false }),
          "blockedSenders.list": () => ({ items: [] }),
          "users.me.updatePreferences": async () => {
            await released;
            return respond();
          },
        },
      });

      const toggle = await screen.findByRole("switch", { name: /show spam entries/i });
      await waitFor(() => expect(toggle).toBeEnabled());
      fireEvent.click(toggle);

      await waitFor(() => expect(toggle).toBeChecked());
      release();
      await waitFor(() => expect(toggle).toBeEnabled());
      if (settled) expect(toggle).toBeChecked();
      else expect(toggle).not.toBeChecked();
    }
  );
});
