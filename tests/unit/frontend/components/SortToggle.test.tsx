/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for SortToggle component.
 *
 * Tests the toggle button for switching between newest and oldest sorting.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SortToggle } from "@/components/entries/SortToggle";

describe("SortToggle", () => {
  describe("rendering", () => {
    it("renders a button element", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toBeInTheDocument();
    });
  });

  describe("newest state", () => {
    it("displays 'Newest' label when sortOrder is newest", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      expect(screen.getByText("Newest")).toBeInTheDocument();
    });

    it("has aria-label 'Sort oldest first' when showing newest", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Sort oldest first");
    });

    it("has aria-pressed='false' when sortOrder is newest", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
    });

    it("has title matching aria-label for tooltip", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("title", "Sort oldest first");
    });
  });

  describe("oldest state", () => {
    it("displays 'Oldest' label when sortOrder is oldest", () => {
      render(<SortToggle sortOrder="oldest" onToggle={vi.fn()} />);
      expect(screen.getByText("Oldest")).toBeInTheDocument();
    });

    it("has aria-label 'Sort newest first' when showing oldest", () => {
      render(<SortToggle sortOrder="oldest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-label", "Sort newest first");
    });

    it("has aria-pressed='true' when sortOrder is oldest", () => {
      render(<SortToggle sortOrder="oldest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("toggle callback", () => {
    it("calls onToggle when clicked", () => {
      const onToggle = vi.fn();
      render(<SortToggle sortOrder="newest" onToggle={onToggle} />);

      fireEvent.click(screen.getByRole("button"));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it("calls onToggle with each click", () => {
      const onToggle = vi.fn();
      render(<SortToggle sortOrder="newest" onToggle={onToggle} />);

      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByRole("button"));
      expect(onToggle).toHaveBeenCalledTimes(2);
    });
  });

  describe("styling", () => {
    it("applies custom className", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} className="custom-class" />);
      expect(screen.getByRole("button")).toHaveClass("custom-class");
    });

    it("contains icon element", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      const button = screen.getByRole("button");
      const icon = button.querySelector("svg");
      expect(icon).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("has type='button' to prevent form submission", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      expect(screen.getByRole("button")).toHaveAttribute("type", "button");
    });

    it("is focusable", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      const button = screen.getByRole("button");
      button.focus();
      expect(document.activeElement).toBe(button);
    });

    it("has focus ring styles", () => {
      render(<SortToggle sortOrder="newest" onToggle={vi.fn()} />);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("focus:ring-2");
    });
  });
});
