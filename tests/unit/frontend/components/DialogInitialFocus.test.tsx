/**
 * @vitest-environment jsdom
 */

/**
 * Initial focus for the app's confirmation dialogs.
 *
 * `ConfirmDialog` marks Cancel for `Dialog` to focus on open, even below an
 * option like the unsubscribe dialog's block-sender checkbox, so it never
 * focuses the destructive action.
 *
 * Delete-account is the exception: its first focusable is the "type delete to
 * confirm" input, so it keeps an explicit effect that moves focus to Cancel.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MarkAllReadButton } from "@/components/entries/MarkAllReadButton";
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
  it("focuses Cancel, not an option above it, when a confirm dialog opens", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Unsubscribe?"
        confirmLabel="Unsubscribe"
        options={<input type="checkbox" aria-label="Also block" />}
        isLoading={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      >
        Unsubscribe?
      </ConfirmDialog>
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("focuses Cancel when the mark-all-read dialog opens", () => {
    render(
      <MarkAllReadButton contextDescription="all feeds" isLoading={false} onConfirm={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("focuses Cancel, not the confirmation input, when the delete-account dialog opens", () => {
    renderWithTrpc(<DeleteAccountSettingsContent />);

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});
