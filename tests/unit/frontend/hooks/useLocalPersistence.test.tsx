/**
 * @vitest-environment jsdom
 */

/**
 * Tests for when local persistence attaches, detaches and deletes: it follows
 * the per-device setting, the operator's kill switch, and the signed-in user.
 * Runs against fake-indexeddb, a complete in-memory IndexedDB.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { getQueryKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc/client";
import { LocalPersistenceProvider } from "@/lib/hooks/useLocalPersistence";
import { getLocalDb } from "@/lib/local-db/local-db";
import { deleteLocalPersistence, openLocalPersistence } from "@/lib/local-db/persistence";
import { renderWithTrpc, stubMemoryLocalStorage } from "../../../utils/component-test-helpers";

function me(id: string) {
  return { user: { id, email: `${id}@example.com` } } as never;
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((database) => database.name ?? "");
}

function renderProvider(options: { allowed: boolean; userId: string }) {
  return renderWithTrpc(
    <LocalPersistenceProvider allowed={options.allowed}>{null}</LocalPersistenceProvider>,
    {
      handlers: { "auth.me": () => me(options.userId) },
    }
  );
}

beforeEach(async () => {
  stubMemoryLocalStorage();
  localStorage.setItem("lion-reader:local-persistence", "true");
  await deleteLocalPersistence();
});

afterEach(() => {
  cleanup();
});

// The setting's value is cached for the module's lifetime once read, so the
// "on" and "off" cases live in separate files (useLocalPersistence-off.test.tsx).
describe("LocalPersistenceProvider with the setting on", () => {
  it("attaches the signed-in user's database when the setting is on", async () => {
    const { queryClient } = renderProvider({ allowed: true, userId: "user-1" });

    await waitFor(() => expect(getLocalDb(queryClient).persistence?.userId).toBe("user-1"));
    expect(await databaseNames()).toEqual(["lion-reader-local-user-1"]);
  });

  it("stops writing when the tab's user changes under it", async () => {
    const { queryClient } = renderProvider({ allowed: true, userId: "user-1" });
    await waitFor(() => expect(getLocalDb(queryClient).persistence).not.toBeNull());

    act(() => {
      queryClient.setQueryData(getQueryKey(trpc.auth.me, undefined, "query"), me("user-2"));
    });

    await waitFor(() => expect(getLocalDb(queryClient).persistence).toBeNull());
  });

  it("deletes stored data and doesn't attach when the operator disables it", async () => {
    await openLocalPersistence("user-1");
    const { queryClient } = renderProvider({ allowed: false, userId: "user-1" });

    await waitFor(async () => expect(await databaseNames()).toEqual([]));
    expect(getLocalDb(queryClient).persistence).toBeNull();
  });
});
