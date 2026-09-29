/**
 * @vitest-environment jsdom
 */

/**
 * Read/starred mutations must surface an expired session the same way every
 * other request does: through the React Query MutationCache, where
 * AuthErrorHandler redirects to /login. (Its own file because
 * AuthErrorHandler's once-per-page redirect flag is module state.)
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { waitFor } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { AuthErrorHandler } from "@/components/app/AuthErrorHandler";
import { useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { renderWithTrpc } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let originalLocation: Location;

beforeEach(() => {
  originalLocation = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/all", search: "", href: "" },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

function MarkReadOnMount() {
  const { markRead } = useEntryMutations();
  useEffect(() => markRead(["entry-1"], true), [markRead]);
  return null;
}

describe("useEntryMutations with an expired session", () => {
  it("redirects to /login when a mark-read hits UNAUTHORIZED", async () => {
    renderWithTrpc(
      <>
        <AuthErrorHandler />
        <MarkReadOnMount />
      </>,
      {
        handlers: {
          "entries.markRead": () => {
            const error = new TRPCClientError<never>("expired");
            Object.assign(error, { data: { code: "UNAUTHORIZED", httpStatus: 401 } });
            throw error;
          },
        },
      }
    );

    await waitFor(() => {
      expect(window.location.href).toBe(`/login?redirect=${encodeURIComponent("/all")}`);
    });
  });
});
