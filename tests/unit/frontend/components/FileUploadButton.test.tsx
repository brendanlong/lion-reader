/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for FileUploadButton's drop zone.
 *
 * The drop zone used to be a `<div onClick>` wrapping a `display: none` file
 * input, which put the only upload affordance out of reach of the keyboard and
 * the accessibility tree. These tests pin the replacement: a named, rendered
 * `<input type="file">` that covers the zone, so Tab lands on it and Space/Enter
 * opens the picker.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { FileUploadButton } from "@/components/saved/FileUploadButton";
import { DROP_ZONE_FILE_INPUT_CLASSES } from "@/components/ui/drop-zone-file-input";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

// sonner's toast is a side-effecting singleton (renders a portal); stub it so
// tests assert on component behavior, not the toast implementation.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const handlers: ProcedureHandlers = {
  "saved.uploadFile": () => ({ id: "entry-1" }),
};

function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
}

function getFileInput(): HTMLInputElement {
  return screen.getByLabelText("Choose a file to upload") as HTMLInputElement;
}

describe("FileUploadButton drop zone accessibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the file input with an accessible name", () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const input = getFileInput();
    expect(input).toBeInTheDocument();
    expect(input.type).toBe("file");
  });

  it("keeps the file input rendered rather than display:none, so it is tabbable", () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const input = getFileInput();
    // `hidden` (display: none) and a negative tabindex are the two ways to drop
    // a control out of the tab order; the input must use neither. It is hidden
    // visually instead, by the shared class string that
    // `drop-zone-file-input.test.ts` pins.
    expect(input).toHaveClass(DROP_ZONE_FILE_INPUT_CLASSES);
    expect(input).not.toHaveAttribute("hidden");
    expect(input.tabIndex).toBeGreaterThanOrEqual(0);
    expect(input).not.toBeDisabled();
  });

  it("can be focused", () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const input = getFileInput();
    input.focus();
    expect(input).toHaveFocus();
  });

  it("selecting a file through the input alone drives the whole upload flow", async () => {
    const { callsFor } = renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    // Before a file is chosen the Upload button is disabled, so the input is the
    // only usable control in the dialog besides Cancel.
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();

    const file = new File(["# hello"], "notes.md", { type: "text/markdown" });
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    expect(await screen.findByText("notes.md")).toBeInTheDocument();

    const upload = screen.getByRole("button", { name: "Upload" });
    await waitFor(() => expect(upload).toBeEnabled());
    fireEvent.click(upload);

    await waitFor(() => expect(callsFor("saved.uploadFile")).toHaveLength(1));
  });

  it("rejects an unsupported file chosen through the input", async () => {
    renderWithTrpc(<FileUploadButton />, { handlers });
    openDialog();

    const file = new File(["nope"], "photo.png", { type: "image/png" });
    fireEvent.change(getFileInput(), { target: { files: [file] } });

    expect(await screen.findByText(/Unsupported file type/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
  });
});
