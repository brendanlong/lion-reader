/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";

afterEach(() => {
  cleanup();
});

describe("KeyboardShortcutsProvider", () => {
  it("opens the shortcuts modal when ? is pressed", () => {
    render(<KeyboardShortcutsProvider>content</KeyboardShortcutsProvider>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "?", code: "Slash", shiftKey: true });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
