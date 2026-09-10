/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for LinkedAccounts.
 *
 * Focus is the unlink mutation's error handling, which is load-bearing since
 * `auth.unlinkProvider` can fail *after* the unlink landed: the session revoke
 * SECURITY.md §4 requires runs once the delete is durable, and reports
 * `SESSION_REVOKE_FAILED` rather than rolling the unlink back. The component
 * must not then tell the user the unlink failed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { LinkedAccounts } from "@/components/settings/LinkedAccounts";
import { procedureError } from "@/lib/trpc/handler-link";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const REVOKE_FAILED_MESSAGE =
  "Google unlinked, but signing out your other devices failed. Review them under Settings → Sessions.";

function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "auth.providers": () => ({ providers: ["google", "apple"] }),
    "users.me.linkedAccounts": () => ({
      accounts: [{ provider: "google", linkedAt: new Date("2024-01-01") }],
      // A password means `canUnlink` is true with a single provider linked.
      hasPassword: true,
    }),
    "auth.unlinkProvider": () => ({ success: true }),
    ...overrides,
  };
}

/** Only one provider is linked in these fixtures, so "Unlink" is unambiguous. */
function findUnlinkButton() {
  return screen.findByRole("button", { name: /^unlink$/i });
}

async function clickUnlink() {
  fireEvent.click(await findUnlinkButton());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LinkedAccounts", () => {
  it("refetches the account list after a successful unlink", async () => {
    const { callsFor } = renderWithTrpc(<LinkedAccounts />, { handlers: baseHandlers() });

    await clickUnlink();

    await waitFor(() => expect(callsFor("auth.unlinkProvider")).toHaveLength(1));
    // The invalidate re-runs the list query, so it is called more than once.
    await waitFor(() => expect(callsFor("users.me.linkedAccounts").length).toBeGreaterThan(1));
  });

  it("reports a failed session revoke without claiming the unlink failed", async () => {
    const { callsFor } = renderWithTrpc(<LinkedAccounts />, {
      handlers: baseHandlers({
        "auth.unlinkProvider": () => {
          throw procedureError(
            "INTERNAL_SERVER_ERROR",
            REVOKE_FAILED_MESSAGE,
            "SESSION_REVOKE_FAILED"
          );
        },
      }),
    });

    await clickUnlink();

    // The user is told what actually happened and where to finish the job...
    expect(await screen.findByText(REVOKE_FAILED_MESSAGE)).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith(REVOKE_FAILED_MESSAGE);
    expect(toast.error).not.toHaveBeenCalledWith("Failed to unlink account");
    // ...and the list is refetched, because the unlink itself landed.
    await waitFor(() => expect(callsFor("users.me.linkedAccounts").length).toBeGreaterThan(1));
  });

  it("reports an ordinary unlink failure as a failure", async () => {
    renderWithTrpc(<LinkedAccounts />, {
      handlers: baseHandlers({
        "auth.unlinkProvider": () => {
          throw procedureError("BAD_REQUEST", "Something else went wrong");
        },
      }),
    });

    await clickUnlink();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to unlink account"));
  });

  it("refuses to unlink the only auth method without calling the server", async () => {
    const { callsFor } = renderWithTrpc(<LinkedAccounts />, {
      handlers: baseHandlers({
        "users.me.linkedAccounts": () => ({
          accounts: [{ provider: "google", linkedAt: new Date("2024-01-01") }],
          hasPassword: false,
        }),
      }),
    });

    const button = await findUnlinkButton();
    expect(button).toBeDisabled();
    fireEvent.click(button);

    expect(callsFor("auth.unlinkProvider")).toHaveLength(0);
  });
});
