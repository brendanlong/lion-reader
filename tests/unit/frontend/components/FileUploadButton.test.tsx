/**
 * @vitest-environment jsdom
 */

/**
 * Tests for FileUploadButton: its drop zone's accessibility, and how an
 * upload's response updates the client.
 *
 * The drop zone used to be a `<div onClick>` wrapping a `display: none` file
 * input, which put the only upload affordance out of reach of the keyboard and
 * the accessibility tree. These tests pin the replacement: a named, rendered
 * `<input type="file">` that covers the zone, so Tab lands on it and Space/Enter
 * opens the picker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileUploadButton } from "@/components/saved/FileUploadButton";
import { DROP_ZONE_FILE_INPUT_CLASSES } from "@/components/ui/drop-zone-file-input";
import { handleSyncEvent } from "@/lib/cache/event-handlers";
import type { NewEntryListItem } from "@/lib/events/schemas";
import { useEntryListEntries } from "@/lib/hooks/useLocalEntries";
import { getLocalDb } from "@/lib/local-db/local-db";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import { uploadIdempotencyKeySchema } from "@/server/trpc/validation";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";
import {
  createCounts,
  createNewEntryEvent,
  createRealTrpcUtils,
  createSubscriptionRow,
  invalidatedProcedures,
  savedSubscriptionRow,
  SEEDED_SAVED_SUBSCRIPTION_ID,
  spyOnInvalidate,
  storedCount,
} from "../../../utils/cache-test-helpers";

// sonner's toast is a side-effecting singleton (renders a portal); stub it so
// tests assert on component behavior, not the toast implementation.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

let mockPathname = "/all";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  mockPathname = "/all";
});

const listItem: NewEntryListItem = {
  entryId: "entry-1",
  subscriptionId: SEEDED_SAVED_SUBSCRIPTION_ID,
  subscriptionIds: [SEEDED_SAVED_SUBSCRIPTION_ID],
  tagLists: { tagIds: [], uncategorized: false },
  updatedAt: "2024-07-01T00:00:00.000Z",
  entry: {
    type: "saved",
    url: null,
    title: "notes",
    author: null,
    summary: null,
    publishedAt: null,
    fetchedAt: "2024-07-01T00:00:00.000Z",
    siteName: "Uploaded Text",
    feedTitle: "Saved Articles",
  },
};

const book = createSubscriptionRow({ id: "collection-1", type: "collection", title: "Book" });

// Not the default limits, which the dialog mustn't assume.
const uploadLimits = { maxFileBytes: 1000, maxEbookBytes: 4000 };

const handlers: ProcedureHandlers = {
  "saved.uploadLimits": () => uploadLimits,
  "subscriptions.list": () => ({ items: [book], nextCursor: undefined }),
  "saved.uploadFile": () => ({
    article: { id: "entry-1", title: "notes" },
    listItem,
    counts: createCounts({ all: { unread: 3 }, saved: { unread: 2 } }),
  }),
};

const SAVED_LIST = { type: "saved", sortOrder: "newest", limit: 10 } as const;

/** The Saved list's entry ids, as the page renders them. */
function SavedListIds() {
  const entries = useEntryListEntries(SAVED_LIST, null);
  return <div aria-label="Saved list">{entries.map((entry) => entry.id).join(",")}</div>;
}

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
}

function getFileInput(): HTMLInputElement {
  return screen.getByLabelText("Choose a file to upload") as HTMLInputElement;
}

async function uploadMarkdownFile(): Promise<void> {
  const file = new File(["# hello"], "notes.md", { type: "text/markdown" });
  fireEvent.change(getFileInput(), { target: { files: [file] } });
  expect(await screen.findByText("notes.md")).toBeInTheDocument();
  const upload = screen.getByRole("button", { name: "Upload" });
  await waitFor(() => expect(upload).toBeEnabled());
  fireEvent.click(upload);
}

describe("FileUploadButton drop zone accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the file input rendered rather than display:none, so it is tabbable", () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const input = getFileInput();
    // `hidden` (display: none) and a negative tabindex are the two ways to drop
    // a control out of the tab order; the input must use neither. The shared
    // classes hide it without opacity, which would also hide its focus outline
    // (#1573); `drop-zone-file-input.test.ts` pins what they contain.
    expect(input).toHaveClass(DROP_ZONE_FILE_INPUT_CLASSES);
    expect(input).not.toHaveAttribute("hidden");
    expect(input.tabIndex).toBeGreaterThanOrEqual(0);
    expect(input).not.toBeDisabled();
  });

  it("selecting a file through the input alone drives the whole upload flow", async () => {
    const { callsFor } = renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    // Before a file is chosen the Upload button is disabled, so the input is the
    // only usable control in the dialog besides Cancel.
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();

    await uploadMarkdownFile();

    await waitFor(() => expect(callsFor("saved.uploadFile")).toHaveLength(1));
  });

  it("retries a file with its key, and gives another file a new one (#2070)", async () => {
    const { callsFor } = renderWithTrpc(<FileUploadButton />, {
      handlers: {
        ...handlers,
        "saved.uploadFile": () => {
          throw new Error("Network went away");
        },
      },
    });
    openDialog();
    const keys = () =>
      callsFor("saved.uploadFile").map(
        (call) => (call.input as { idempotencyKey: string }).idempotencyKey
      );

    await uploadMarkdownFile();
    await waitFor(() => expect(keys()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(keys()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled());
    await uploadMarkdownFile();
    await waitFor(() => expect(keys()).toHaveLength(3));

    const [first, retry, other] = keys();
    expect(uploadIdempotencyKeySchema.unwrap().safeParse(first).success).toBe(true);
    expect(retry).toBe(first);
    expect(other).not.toBe(first);
  });

  it("offers and accepts plain text files (#1773)", async () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    expect(getFileInput().accept.split(",")).toContain(".txt");

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Upload" })).toBeEnabled());
  });

  it("rejects an unsupported file chosen through the input", async () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const file = new File(["nope"], "photo.png", { type: "image/png" });
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    expect(await screen.findByText(/Unsupported file type/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });

  it("holds a document and an ebook to the server's limits", async () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();
    expect(await screen.findByText(/up to 1000 B; .* up to 3\.9 KB/)).toBeInTheDocument();
    const sized = (name: string, size: number) => {
      const file = new File([""], name);
      Object.defineProperty(file, "size", { value: size });
      return file;
    };

    const doc = sized("big.md", uploadLimits.maxFileBytes + 1);
    fireEvent.change(getFileInput(), { target: { files: [doc] } });
    expect(await screen.findByText(/File is too large/)).toBeInTheDocument();

    const ebook = sized("big.epub", uploadLimits.maxEbookBytes);
    fireEvent.change(getFileInput(), { target: { files: [ebook] } });
    expect(await screen.findByText("big.epub")).toBeInTheDocument();
    expect(screen.queryByText(/File is too large/)).not.toBeInTheDocument();

    const tooBigEbook = sized("huge.epub", uploadLimits.maxEbookBytes + 1);
    fireEvent.change(getFileInput(), { target: { files: [tooBigEbook] } });
    expect(await screen.findByText(/File is too large/)).toBeInTheDocument();
  });
});

describe("FileUploadButton collection", () => {
  const uploadedCollectionIds = (callsFor: (path: string) => { input: unknown }[]) =>
    callsFor("saved.uploadFile").map(
      (call) => (call.input as { collectionIds?: string[] }).collectionIds
    );

  it("files into no collection by default", async () => {
    const { callsFor } = renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    await uploadMarkdownFile();

    await waitFor(() => expect(uploadedCollectionIds(callsFor)).toEqual([undefined]));
  });

  it("defaults to the collection being viewed", async () => {
    mockPathname = `/subscription/${book.id}`;
    const { callsFor } = renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const select = screen.getByLabelText("Add to collection");
    await waitFor(() => expect(select).toHaveValue(book.id));
    await uploadMarkdownFile();

    await waitFor(() => expect(uploadedCollectionIds(callsFor)).toEqual([[book.id]]));
  });

  it("files into the chosen collection, or none", async () => {
    mockPathname = `/subscription/${book.id}`;
    const { callsFor } = renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const select = screen.getByLabelText("Add to collection");
    await waitFor(() => expect(select).toHaveValue(book.id));
    fireEvent.change(select, { target: { value: "" } });
    await uploadMarkdownFile();

    await waitFor(() => expect(uploadedCollectionIds(callsFor)).toEqual([undefined]));
  });
});

describe("FileUploadButton upload response", () => {
  it("places the article in the loaded Saved list and applies the counts, without a refetch", async () => {
    const { queryClient } = renderWithTrpc(
      <>
        <FileUploadButton />
        <SavedListIds />
      </>,
      { handlers }
    );
    // As the app starts: the saved subscription is known and Saved is loaded.
    act(() => {
      queryClient.setQueryData(
        [["subscriptions", "list"], { input: SAVED_SUBSCRIPTION_LIST_INPUT, type: "query" }],
        { items: [savedSubscriptionRow(SEEDED_SAVED_SUBSCRIPTION_ID)] }
      );
      queryClient.setQueryData([["entries", "list"], { input: SAVED_LIST, type: "infinite" }], {
        pages: [{ items: [] }],
        pageParams: [undefined],
      });
    });
    const invalidate = spyOnInvalidate(queryClient);
    openDialog();

    await uploadMarkdownFile();

    const savedList = screen.getByLabelText("Saved list");
    await waitFor(() => expect(savedList).toHaveTextContent("entry-1"));
    expect(storedCount(queryClient, { saved: true })).toEqual({ unread: 2 });
    expect(storedCount(queryClient, { all: true })).toEqual({ unread: 3 });
    expect(invalidatedProcedures(invalidate)).toEqual([]);

    // The upload's own new_entry, arriving after the response, changes nothing.
    act(() => {
      handleSyncEvent(
        createRealTrpcUtils(queryClient),
        queryClient,
        createNewEntryEvent({ ...listItem, counts: createCounts({ saved: { unread: 2 } }) })
      );
    });
    expect(savedList).toHaveTextContent(/^entry-1$/);
  });
});

describe("FileUploadButton ebook import (#1805)", () => {
  const COLLECTION_ID = "collection-1";
  const collection = {
    ...savedSubscriptionRow(COLLECTION_ID),
    type: "collection" as const,
    title: "A Tale",
    originalTitle: "A Tale",
  };
  const ebookHandlers: ProcedureHandlers = {
    "saved.uploadLimits": () => uploadLimits,
    "subscriptions.list": () => ({ items: [], nextCursor: undefined }),
    "collections.importEbook": () => ({
      subscription: collection,
      created: true,
      entryIds: ["chapter-1", "chapter-2"],
      counts: createCounts({
        all: { unread: 2 },
        saved: { unread: 2 },
        subscriptions: [{ id: COLLECTION_ID, unread: 2 }],
      }),
    }),
  };

  it("imports an .epub as a collection, lists it with its count, and opens it", async () => {
    const { queryClient, callsFor } = renderWithTrpc(<FileUploadButton />, {
      handlers: ebookHandlers,
    });
    openDialog();
    expect(getFileInput().accept.split(",")).toContain(".epub");

    const file = new File(["PK"], "tale.epub", { type: "application/epub+zip" });
    fireEvent.change(getFileInput(), { target: { files: [file] } });
    expect(await screen.findByText("tale.epub")).toBeInTheDocument();
    // The book gets its own collection, so there's none to pick.
    expect(screen.queryByLabelText("Add to collection")).not.toBeInTheDocument();
    const upload = screen.getByRole("button", { name: "Upload" });
    await waitFor(() => expect(upload).toBeEnabled());
    fireEvent.click(upload);

    await waitFor(() => expect(window.location.pathname).toBe(`/subscription/${COLLECTION_ID}`));
    expect(callsFor("collections.importEbook")[0].input).toMatchObject({ filename: "tale.epub" });
    expect(callsFor("saved.uploadFile")).toHaveLength(0);
    expect(getLocalDb(queryClient).subscriptions.rows.getSynced(COLLECTION_ID)).toMatchObject({
      title: "A Tale",
      unreadCount: 2,
    });
    expect(storedCount(queryClient, { saved: true })).toEqual({ unread: 2 });
  });
});
