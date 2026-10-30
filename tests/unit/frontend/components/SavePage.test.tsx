/**
 * @vitest-environment jsdom
 */

/**
 * The share target's save page: a shared file the service worker stashed in
 * IndexedDB is uploaded as an article, or, for an ebook, imported as a
 * collection (#1805), and kept until it's saved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import SavePage from "@/app/(spa)/save/page";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";
import { createCounts } from "../../../utils/cache-test-helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("type=file&shared=true"),
}));

/**
 * The slice of IndexedDB the page uses, holding the service worker's `pending`
 * record (if any). Requests complete on a later task, as the browser's do.
 * Returns a spy on the record's deletion.
 */
function stubSharedFile(record?: { content: string; filename: string; type?: string }) {
  const deleteRecord = vi.fn();
  const request = <T,>(result: T) => {
    const req: { result: T; onsuccess?: () => void } = { result };
    setTimeout(() => req.onsuccess?.());
    return req;
  };
  const db = {
    transaction: () => {
      const tx: { objectStore: () => unknown; oncomplete?: () => void } = {
        objectStore: () => ({
          get: () => request(record),
          delete: () => {
            deleteRecord();
            return request(undefined);
          },
        }),
      };
      setTimeout(() => tx.oncomplete?.());
      return tx;
    },
    close: () => {},
  };
  vi.stubGlobal("indexedDB", { open: () => request(db) });
  return deleteRecord;
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

  it("uploads any other shared file as an article, then drops it", async () => {
    const deleteRecord = stubSharedFile({ content: "IyBoaQ==", filename: "notes.md" });
    const { callsFor } = renderWithTrpc(<SavePage />, { handlers });

    expect(await screen.findByText("Notes")).toBeInTheDocument();
    await waitFor(() => expect(callsFor("saved.uploadFile")).toHaveLength(1));
    expect(callsFor("collections.importEbook")).toHaveLength(0);
    await waitFor(() => expect(deleteRecord).toHaveBeenCalled());
  });

  it("says so when there's no shared file", async () => {
    stubSharedFile(undefined);
    renderWithTrpc(<SavePage />, { handlers });

    expect(await screen.findByText(/shared file didn't reach/)).toBeInTheDocument();
  });

  describe("signed out", () => {
    let originalLocation: Location;
    beforeEach(() => {
      originalLocation = window.location;
      Object.defineProperty(window, "location", { configurable: true, value: { href: "" } });
    });
    afterEach(() => {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    });

    it("keeps the file and comes back to it after signing in", async () => {
      const deleteRecord = stubSharedFile({ content: "IyBoaQ==", filename: "notes.md" });
      renderWithTrpc(<SavePage />, {
        handlers: {
          "saved.uploadFile": () => {
            const error = new TRPCClientError<never>("signed out");
            Object.assign(error, { data: { code: "UNAUTHORIZED", httpStatus: 401 } });
            throw error;
          },
        },
      });

      fireEvent.click(await screen.findByRole("button", { name: "Sign In" }));

      const redirect = new URL(window.location.href, "https://x").searchParams.get("redirect");
      expect(redirect).toBe("/save?type=file");
      expect(deleteRecord).not.toHaveBeenCalled();
    });
  });
});
