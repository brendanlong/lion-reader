/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup, fireEvent } from "@testing-library/react";
import { UnsubscribeDialog } from "@/components/feeds/UnsubscribeDialog";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

afterEach(cleanup);

function renderEmailDialog(onConfirm: (options: { blockSender: boolean }) => void) {
  return renderWithTrpc(
    <UnsubscribeDialog
      isOpen={true}
      subscriptionId="00000000-0000-7000-8000-000000000001"
      feedTitle="Example Newsletter"
      isEmail={true}
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

    expect(onConfirm).toHaveBeenCalledWith({ blockSender: false });
  });

  it("blocks the sender when its address is checked", async () => {
    const onConfirm = vi.fn();
    renderEmailDialog(onConfirm);

    fireEvent.click(await screen.findByRole("checkbox", { name: /no-reply@substack\.com/ }));
    fireEvent.click(screen.getByRole("button", { name: "Unsubscribe" }));

    expect(onConfirm).toHaveBeenCalledWith({ blockSender: true });
  });
});
