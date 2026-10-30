/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { toast } from "sonner";
import { CopyButton } from "@/components/ui/copy-button";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CopyButton", () => {
  it("copies the value and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    render(<CopyButton value="secret" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: "Copied!" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("secret");
  });

  it("reports a failed copy instead of claiming success", async () => {
    stubClipboard(() => Promise.reject(new Error("Clipboard blocked")));
    render(<CopyButton value="secret" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to copy", {
        description: "Clipboard blocked",
      })
    );
    expect(screen.queryByRole("button", { name: "Copied!" })).not.toBeInTheDocument();
  });
});
