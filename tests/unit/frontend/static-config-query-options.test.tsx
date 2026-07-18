/**
 * @vitest-environment jsdom
 */

/**
 * Regression test for STATIC_CONFIG_QUERY_OPTIONS: the deploy-static config
 * queries the public auth pages read (`auth.signupConfig`, `auth.providers`)
 * must not background-refetch. A refetch there previously let a stale
 * shared-cache tRPC response overwrite the correct SSR-hydrated value, flashing
 * the register page's EU banner in and back out.
 *
 * We drive React Query's real `focusManager` (the mechanism behind
 * `refetchOnWindowFocus`) against the real tRPC client wiring (mock-link
 * harness). Without the options a window-focus refetches the stale query; with
 * them (`staleTime: Infinity`) it never does. The mock-link QueryClient uses the
 * default `staleTime: 0`, so a query is stale the instant it settles — exactly
 * the condition under which a focus refetch fires — making the contrast crisp.
 */

import { describe, it, expect, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { STATIC_CONFIG_QUERY_OPTIONS } from "@/lib/trpc/query-client";
import { renderHookWithTrpc } from "../../utils/component-test-helpers";

afterEach(() => {
  // Leave the focus manager in its default (focused) state for other tests.
  focusManager.setFocused(undefined);
});

/** Simulate the browser tab losing and regaining focus. */
async function blurThenFocus(): Promise<void> {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
}

describe("STATIC_CONFIG_QUERY_OPTIONS", () => {
  it("does not refetch auth.providers on window focus", async () => {
    const { result, callsFor } = renderHookWithTrpc(
      () => trpc.auth.providers.useQuery(undefined, STATIC_CONFIG_QUERY_OPTIONS),
      { handlers: { "auth.providers": () => ({ providers: ["google"] }) } }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("auth.providers")).toHaveLength(1);

    await blurThenFocus();

    // staleTime: Infinity keeps the query fresh, so focus triggers no refetch.
    expect(callsFor("auth.providers")).toHaveLength(1);
  });

  it("control: a default query DOES refetch on window focus", async () => {
    // Guards the test itself — proves the harness's focus simulation actually
    // drives a refetch, so the assertion above is meaningful (not a no-op).
    const { result, callsFor } = renderHookWithTrpc(() => trpc.auth.providers.useQuery(), {
      handlers: { "auth.providers": () => ({ providers: ["google"] }) },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(callsFor("auth.providers")).toHaveLength(1);

    await blurThenFocus();

    await waitFor(() => expect(callsFor("auth.providers")).toHaveLength(2));
  });
});
