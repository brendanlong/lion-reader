/**
 * @vitest-environment jsdom
 */

/**
 * Initial focus for the app's confirmation dialogs.
 *
 * `Dialog` focuses its first focusable descendant on open. For the two
 * confirm/cancel dialogs that is Cancel, so they need nothing of their own —
 * these tests pin that down so the shared default can't silently drift (e.g.
 * a control added above the footer) and quietly start focusing the
 * destructive action.
 *
 * Delete-account is the exception: its first focusable is the "type delete to
 * confirm" input, so it keeps an explicit effect that moves focus to Cancel.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";
import DeleteAccountSettingsContent from "@/components/settings/pages/DeleteAccountSettingsContent";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("confirmation dialog initial focus", () => {
  it("focuses Cancel when the unsubscribe dialog opens", () => {
    render(
      <UnsubscribeDialog
        isOpen={true}
        feedTitle="Example Feed"
        isLoading={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("focuses Cancel when the mark-all-read dialog opens", () => {
    render(
      <MarkAllReadDialog
        isOpen={true}
        contextDescription="all feeds"
        isLoading={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("focuses Cancel, not the confirmation input, when the delete-account dialog opens", () => {
    renderWithTrpc(<DeleteAccountSettingsContent />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
