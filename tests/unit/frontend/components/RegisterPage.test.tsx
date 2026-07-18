/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for the registration form.
 *
 * Registration already creates a session and sets the httpOnly cookie on the
 * server, so a successful signup logs the user straight in. A brand-new email
 * account still owes ToS/Privacy consent, so the form sends them to
 * /complete-signup (which leads into the app) rather than bouncing to /login to
 * sign in again. Like the login form, it keeps the "Create account" button in
 * its loading state continuously from click until that navigation happens (the
 * request resolves before the server-rendered page finishes). On failure the
 * button re-enables so the user can retry.
 *
 * These tests drive the real tRPC wiring through the mock-link harness:
 *   - success -> navigates to /complete-signup AND button stays disabled,
 *   - duplicate email -> button re-enables, shows the error, no navigation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import RegisterPage from "@/app/(public)/(auth)/register/page";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

// The form navigates into the app via next/navigation's useRouter after a
// successful registration; capture push/refresh instead of performing a real nav.
const { mockPush, mockRefresh } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  useSearchParams: () => new URLSearchParams(),
}));

/** A TRPCClientError whose `.data.code` matches what the client surfaces. */
function trpcError(code: string, message: string): TRPCClientError<never> {
  const err = new TRPCClientError<never>(message);
  Object.assign(err, { data: { code } });
  return err;
}

/** signupConfig is a suspense query that fires on mount; email must be allowed. */
function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "auth.signupConfig": () => ({
      euRestricted: false,
      requiresInvite: false,
      allowedSignupProviders: ["email", "google", "apple", "discord"],
      publicSignupProviders: ["email", "google", "apple", "discord"],
    }),
    ...overrides,
  };
}

async function renderRegister(handlers: ProcedureHandlers) {
  const result = renderWithTrpc(<RegisterPage />, { handlers });
  // Wait out the signupConfig suspense boundary so the form is mounted.
  await screen.findByRole("button", { name: "Create account" });
  return result;
}

function fillForm() {
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "hunter2hunter2" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "hunter2hunter2" },
  });
}

describe("RegisterPage auto-login + submit-button lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
  });

  it("navigates to the confirmation step and keeps the button disabled after signup succeeds", async () => {
    await renderRegister(
      baseHandlers({
        "auth.register": () => ({
          user: { id: "u1", email: "user@example.com", createdAt: new Date() },
          sessionToken: "tok",
        }),
      })
    );

    fillForm();
    const button = screen.getByRole("button", { name: "Create account" });
    fireEvent.click(button);

    // Goes to /complete-signup (not /login), and the button is still disabled at
    // the point navigation fires (i.e. after isPending has already cleared).
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/complete-signup"));
    expect(button).toBeDisabled();
  });

  it("re-enables the button and shows an error when the email already exists", async () => {
    await renderRegister(
      baseHandlers({
        "auth.register": () => {
          throw trpcError("CONFLICT", "exists");
        },
      })
    );

    fillForm();
    const button = screen.getByRole("button", { name: "Create account" });
    fireEvent.click(button);

    expect(
      await screen.findByText("An account with this email already exists")
    ).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
