/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import { UnsubscribeDialog, type UnsubscribeOptions } from "@/components/feeds/UnsubscribeDialog";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

afterEach(cleanup);

function renderEmailDialog(onConfirm: (options: UnsubscribeOptions) => void) {
  return renderWithTrpc(
    <UnsubscribeDialog
      isOpen={true}
      feedTitle="Example Newsletter"
      emailSubscriptionId="00000000-0000-7000-8000-000000000001"
      isLoading={false}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
    {
      handlers: {
        "subscriptions.getEmailSender": () => ({ emailSender: "no-reply@substack.com" }),
      },
    }
  );
}

describe("UnsubscribeDialog for an email subscription", () => {
  it("doesn't block the sender unless asked (#1964)", async () => {
    const onConfirm = vi.fn();
    renderEmailDialog(onConfirm);

    const checkbox = await screen.findByRole("checkbox", { name: /no-reply@substack\.com/ });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));

    expect(onConfirm).toHaveBeenCalledWith({ blockSender: false, deleteSavedArticles: false });
  });

  it("blocks the sender when its address is checked", async () => {
    const onConfirm = vi.fn();
    renderEmailDialog(onConfirm);

    fireEvent.click(await screen.findByRole("checkbox", { name: /no-reply@substack\.com/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));

    expect(onConfirm).toHaveBeenCalledWith({ blockSender: true, deleteSavedArticles: false });
  });
});

describe("UnsubscribeDialog for a collection", () => {
  function renderCollectionDialog(onConfirm: (options: UnsubscribeOptions) => void) {
    return renderWithTrpc(
      <UnsubscribeDialog
        isOpen={true}
        feedTitle="Book"
        isCollection
        isLoading={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
  }

  it("keeps its saved articles unless asked", () => {
    const onConfirm = vi.fn();
    renderCollectionDialog(onConfirm);

    expect(screen.getByRole("checkbox", { name: /delete its saved articles/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalledWith({ blockSender: false, deleteSavedArticles: false });
  });

  it("deletes its saved articles when checked", () => {
    const onConfirm = vi.fn();
    renderCollectionDialog(onConfirm);

    fireEvent.click(screen.getByRole("checkbox", { name: /delete its saved articles/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalledWith({ blockSender: false, deleteSavedArticles: true });
  });
});
