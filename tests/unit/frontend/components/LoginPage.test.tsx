/**
 * @vitest-environment jsdom
 */

/**
 * Component integration tests for the login form's submit-button lifecycle.
 *
 * The "Sign in" button must stay in its loading/disabled state continuously
 * from click until we actually navigate into the app. The login request itself
 * resolves *before* the (server-rendered) navigation into `/all` completes, so
 * binding the button to `loginMutation.isPending` alone briefly re-enabled it in
 * the gap — the confusing "click did nothing" flash the user reported. A
 * separate `isRedirecting` flag keeps it disabled through the navigation.
 *
 * These tests drive the real tRPC wiring through the mock-link harness:
 *   - success -> button stays disabled after the request resolves (until nav),
 *   - failure -> button re-enables so the user can retry, and shows the error.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import LoginPage from "@/app/(public)/(auth)/login/page";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

// The form navigates into the app via next/navigation's useRouter after a
// successful login; capture push/refresh instead of performing a real nav.
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

/** signupConfig is a suspense query that fires on mount; give it a value. */
function baseHandlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "auth.signupConfig": () => ({ requiresInvite: false }),
    ...overrides,
  };
}

async function renderLogin(handlers: ProcedureHandlers) {
  const result = renderWithTrpc(<LoginPage />, { handlers });
  // Wait out the signupConfig suspense boundary so the form is mounted.
  await screen.findByRole("button", { name: "Sign in" });
  return result;
}

function fillCredentials() {
  fireEvent.change(screen.getByLabelText(/Email/i), {
    target: { value: "user@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/Password/i), {
    target: { value: "hunter2hunter2" },
  });
}

describe("LoginPage submit-button lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMemoryLocalStorage();
  });

  it("keeps the Sign in button disabled after login resolves, until navigation", async () => {
    await renderLogin(
      baseHandlers({
        "auth.login": () => ({
          user: { id: "u1", email: "user@example.com", createdAt: new Date() },
          sessionToken: "tok",
        }),
      })
    );

    fillCredentials();
    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);

    // Navigation being kicked off means the mutation already resolved and
    // onSuccess ran — i.e. isPending is back to false. The button must still be
    // disabled here (via isRedirecting), which is the regression this guards.
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/all"));
    expect(button).toBeDisabled();
  });

  it("re-enables the Sign in button and shows an error when login fails", async () => {
    await renderLogin(
      baseHandlers({
        "auth.login": () => {
          throw trpcError("UNAUTHORIZED", "nope");
        },
      })
    );

    fillCredentials();
    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);

    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
