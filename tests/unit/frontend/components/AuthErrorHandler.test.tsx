/**
 * @vitest-environment jsdom
 */

/**
 * AuthErrorHandler is the cache-subscription that turns an auth error from any
 * tRPC call inside the authenticated SPA into a navigation — the kind of realtime
 * cache code tests/CLAUDE.md says to test rather than review. These tests drive a real
 * tRPC query through the mock link (see component-test-helpers), have it fail with
 * a crafted error, and assert the resulting `window.location` navigation:
 *
 * - `UNAUTHORIZED` (dead session) → `/login?redirect=<path>`
 * - `SIGNUP_CONFIRMATION_REQUIRED` → `/complete-signup`
 *
 * Navigation is via `window.location.href`, so we stub `window.location` to
 * capture it without a real jsdom navigation. Note: `AuthErrorHandler`'s
 * one-shot module flags (`isLoggingOut`, `isRedirectingToCompleteSignup`) latch
 * for the module's lifetime, so each flag is exercised by exactly one test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc/client";
import { AuthErrorHandler } from "@/components/app/AuthErrorHandler";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

/** A TRPCClientError whose `.data` matches what the errorFormatter would produce. */
function trpcError(data: Record<string, unknown>): TRPCClientError<never> {
  const err = new TRPCClientError<never>("test error");
  Object.assign(err, { data });
  return err;
}

/** Fires a real tRPC query so the mock link's handler error reaches the cache. */
function Trigger() {
  trpc.auth.me.useQuery(undefined, { retry: false });
  return null;
}

let originalLocation: Location;

beforeEach(() => {
  originalLocation = window.location;
  // Replace the read-only jsdom location with a capturable stub. pathname "/all"
  // stands in for "somewhere in the app" (not /login, not /complete-signup).
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/all", search: "", href: "" },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("AuthErrorHandler", () => {
  it("redirects to /login on an UNAUTHORIZED response, preserving the return path", async () => {
    renderWithTrpc(
      <>
        <Trigger />
        <AuthErrorHandler />
      </>,
      {
        handlers: {
          "auth.me": () => {
            throw trpcError({ code: "UNAUTHORIZED", httpStatus: 401 });
          },
        },
      }
    );

    await waitFor(() => {
      expect(window.location.href).toBe(`/login?redirect=${encodeURIComponent("/all")}`);
    });
  });

  it("redirects to /complete-signup on SIGNUP_CONFIRMATION_REQUIRED", async () => {
    renderWithTrpc(
      <>
        <Trigger />
        <AuthErrorHandler />
      </>,
      {
        handlers: {
          "auth.me": () => {
            throw trpcError({ code: "FORBIDDEN", appErrorCode: "SIGNUP_CONFIRMATION_REQUIRED" });
          },
        },
      }
    );

    await waitFor(() => {
      expect(window.location.href).toBe("/complete-signup");
    });
  });
});
