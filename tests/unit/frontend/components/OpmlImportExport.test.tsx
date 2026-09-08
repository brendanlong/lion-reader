/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for the OPML import drop zone.
 *
 * The input covering the zone used to be `opacity-0`, which also erased the
 * global `:focus-visible` outline: a keyboard user could tab to it with no way
 * to see that they had (#1573). These tests pin the replacement — a named,
 * rendered, focusable `<input type="file">` hidden without opacity. What that
 * shared class string must and must not contain is pinned in
 * `drop-zone-file-input.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { OpmlImportExport } from "@/components/settings/OpmlImportExport";
import { DROP_ZONE_FILE_INPUT_CLASSES } from "@/components/ui/drop-zone-file-input";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

const handlers: ProcedureHandlers = {
  "imports.preview": () => ({ feeds: [{ title: "Example", xmlUrl: "https://example.com/feed" }] }),
};

function getFileInput(): HTMLInputElement {
  return screen.getByLabelText("Choose an OPML file to import") as HTMLInputElement;
}

describe("OpmlImportExport drop zone accessibility", () => {
  it("exposes the file input with an accessible name", () => {
    renderWithTrpc(<OpmlImportExport />, { handlers });

    const input = getFileInput();
    expect(input).toBeInTheDocument();
    expect(input.type).toBe("file");
  });

  it("keeps the file input in the tab order", () => {
    renderWithTrpc(<OpmlImportExport />, { handlers });

    const input = getFileInput();
    expect(input).toHaveClass(DROP_ZONE_FILE_INPUT_CLASSES);
    expect(input).not.toHaveAttribute("hidden");
    expect(input.tabIndex).toBeGreaterThanOrEqual(0);
    expect(input).not.toBeDisabled();
  });

  it("can be focused", () => {
    renderWithTrpc(<OpmlImportExport />, { handlers });

    const input = getFileInput();
    input.focus();
    expect(input).toHaveFocus();
  });

  it("selecting a file through the input alone reaches the import preview", async () => {
    const { callsFor } = renderWithTrpc(<OpmlImportExport />, { handlers });

    const opml =
      '<opml version="1.0"><body><outline xmlUrl="https://example.com/feed"/></body></opml>';
    fireEvent.change(getFileInput(), {
      target: { files: [new File([opml], "subscriptions.opml", { type: "text/xml" })] },
    });

    expect(await screen.findByText("Example")).toBeInTheDocument();
    expect(callsFor("imports.preview")).toHaveLength(1);
  });
});
