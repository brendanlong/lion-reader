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
import { cleanup, waitFor } from "@testing-library/react";
import { LocalPersistenceProvider } from "@/lib/hooks/useLocalPersistence";
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
  await deleteLocalPersistence();
});

afterEach(() => {
  cleanup();
});

// The setting's value is cached for the module's lifetime once read, so the
// "on" and "off" cases live in separate files (useLocalPersistence.test.tsx).
describe("LocalPersistenceProvider with the setting off", () => {
  it("deletes stored data when the setting is off", async () => {
    await openLocalPersistence("user-1");
    renderProvider({ allowed: true, userId: "user-1" });

    await waitFor(async () => expect(await databaseNames()).toEqual([]));
  });
});
