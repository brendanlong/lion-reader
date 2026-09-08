/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for the API tokens create-token form.
 *
 * The "Token Name" and "Expiration" captions used to be hand-rolled `<label>`s
 * with no `htmlFor` next to an `<Input>` with no `id`, so both fields were
 * announced as unlabelled text boxes. These tests query the fields by their
 * accessible name, which is exactly what was missing.
 */

import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import ApiTokensSettingsContent from "@/components/settings/pages/ApiTokensSettingsContent";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

// sonner's toast is a side-effecting singleton (renders a portal); stub it so
// tests assert on component behavior, not the toast implementation.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const handlers: ProcedureHandlers = {
  "apiTokens.list": () => [],
  "apiTokens.create": () => ({ token: "lr_secret_token" }),
  "apiTokens.revoke": () => ({ success: true }),
};

async function renderCreateForm() {
  const result = renderWithTrpc(<ApiTokensSettingsContent />, { handlers });
  fireEvent.click(await screen.findByRole("button", { name: "Create New Token" }));
  return result;
}

describe("ApiTokensSettingsContent create form labels", () => {
  it("labels the token name field", async () => {
    await renderCreateForm();

    const input = screen.getByLabelText("Token Name");
    expect(input).toHaveAttribute("id");
    expect(input.tagName).toBe("INPUT");
  });

  it("labels the expiration field", async () => {
    await renderCreateForm();

    const input = screen.getByLabelText("Expiration (Optional)");
    expect(input).toHaveAttribute("type", "number");
  });

  it("finds the token name field by its accessible name and submits it", async () => {
    const { callsFor } = await renderCreateForm();

    fireEvent.change(screen.getByLabelText("Token Name"), {
      target: { value: "Claude Desktop" },
    });
    fireEvent.change(screen.getByLabelText("Expiration (Optional)"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Token" }));

    await waitFor(() => expect(callsFor("apiTokens.create")).toHaveLength(1));
    expect(callsFor("apiTokens.create")[0].input).toMatchObject({
      name: "Claude Desktop",
      expiresInDays: 30,
    });
  });
});
