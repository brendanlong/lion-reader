/**
 * @vitest-environment jsdom
 */

/**
 * The share target's save page: a shared file the service worker stashed in
 * IndexedDB is uploaded as an article, or, for an ebook, imported as a
 * collection (#1805).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import SavePage from "@/app/(spa)/save/page";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";
import { createCounts } from "../../../utils/cache-test-helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("type=file&shared=true"),
}));

/**
 * The slice of IndexedDB `takeSharedFile` uses, holding the service worker's
 * `pending` record. Requests complete on a later task, as the browser's do.
 */
function stubSharedFile(record: { content: string; filename: string; type?: string }) {
  const request = <T,>(result: T) => {
    const req: { result: T; onsuccess?: () => void } = { result };
    setTimeout(() => req.onsuccess?.());
    return req;
  };
  const db = {
    transaction: () => {
      const tx: { objectStore: () => unknown; oncomplete?: () => void } = {
        objectStore: () => ({ get: () => request(record), delete: () => request(undefined) }),
      };
      setTimeout(() => tx.oncomplete?.());
      return tx;
    },
    close: () => {},
  };
  vi.stubGlobal("indexedDB", { open: () => request(db) });
}

const handlers: ProcedureHandlers = {
  "saved.uploadFile": () => ({ article: { id: "entry-1", title: "Notes" } }),
  "collections.importEbook": () => ({
    subscription: { id: "collection-1", title: "A Tale" },
    created: true,
    entryIds: ["chapter-1", "chapter-2"],
    counts: createCounts(),
  }),
};

describe("SavePage shared files", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports a shared ebook as a collection", async () => {
    stubSharedFile({ content: "UEs=", filename: "tale.epub" });
    const { callsFor } = renderWithTrpc(<SavePage />, { handlers });

    expect(await screen.findByText("A Tale (2 chapters)")).toBeInTheDocument();
    expect(callsFor("collections.importEbook")[0].input).toEqual({
      content: "UEs=",
      filename: "tale.epub",
    });
    expect(callsFor("saved.uploadFile")).toHaveLength(0);
  });

  it("imports an ebook shared without an extension, by its type", async () => {
    stubSharedFile({ content: "UEs=", filename: "A Tale", type: "application/epub+zip" });
    const { callsFor } = renderWithTrpc(<SavePage />, { handlers });

    expect(await screen.findByText("A Tale (2 chapters)")).toBeInTheDocument();
    expect(callsFor("saved.uploadFile")).toHaveLength(0);
  });

  it("uploads any other shared file as an article", async () => {
    stubSharedFile({ content: "IyBoaQ==", filename: "notes.md" });
    const { callsFor } = renderWithTrpc(<SavePage />, { handlers });

    expect(await screen.findByText("Notes")).toBeInTheDocument();
    await waitFor(() => expect(callsFor("saved.uploadFile")).toHaveLength(1));
    expect(callsFor("collections.importEbook")).toHaveLength(0);
  });
});
