/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Button component.
 *
 * Tests the presentational component with variants, loading state, and disabled state.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "@/components/ui/button";

describe("Button", () => {
  describe("rendering", () => {
    it("renders children correctly", () => {
      render(<Button>Click me</Button>);
      expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
    });

    it("renders with default props (primary variant, md size)", () => {
      render(<Button>Default Button</Button>);
      const button = screen.getByRole("button");
      // Primary variant has bg-zinc-900
      expect(button).toHaveClass("bg-zinc-900");
      // md size has min-h-[44px]
      expect(button).toHaveClass("min-h-[44px]");
    });
  });

  describe("variants", () => {
    it("applies primary variant styles", () => {
      render(<Button variant="primary">Primary</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("bg-zinc-900", "text-white");
    });

    it("applies secondary variant styles", () => {
      render(<Button variant="secondary">Secondary</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("border", "bg-white", "text-zinc-900");
    });

    it("applies ghost variant styles", () => {
      render(<Button variant="ghost">Ghost</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("text-zinc-900");
      expect(button).not.toHaveClass("bg-zinc-900", "bg-white");
    });
  });

  describe("sizes", () => {
    it("applies sm size styles", () => {
      render(<Button size="sm">Small</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("min-h-[36px]", "px-3");
    });

    it("applies md size styles (default)", () => {
      render(<Button size="md">Medium</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("min-h-[44px]", "px-4");
    });

    it("applies lg size styles", () => {
      render(<Button size="lg">Large</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("min-h-[48px]", "px-6");
    });
  });

  describe("loading state", () => {
    it("shows loading spinner when loading is true", () => {
      render(<Button loading={true}>Submit</Button>);
      const button = screen.getByRole("button");
      // The spinner is an SVG with animate-spin class
      const spinner = button.querySelector("svg.animate-spin");
      expect(spinner).toBeInTheDocument();
    });

    it("does not show spinner when loading is false", () => {
      render(<Button loading={false}>Submit</Button>);
      const button = screen.getByRole("button");
      const spinner = button.querySelector("svg.animate-spin");
      expect(spinner).not.toBeInTheDocument();
    });

    it("is disabled when loading", () => {
      render(<Button loading={true}>Submit</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
    });

    it("still shows children text when loading", () => {
      render(<Button loading={true}>Submit</Button>);
      expect(screen.getByText("Submit")).toBeInTheDocument();
    });
  });

  describe("disabled state", () => {
    it("is disabled when disabled prop is true", () => {
      render(<Button disabled={true}>Disabled</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
    });

    it("is not disabled when disabled prop is false", () => {
      render(<Button disabled={false}>Enabled</Button>);
      expect(screen.getByRole("button")).not.toBeDisabled();
    });

    it("applies disabled styles", () => {
      render(<Button disabled={true}>Disabled</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("disabled:cursor-not-allowed", "disabled:opacity-50");
    });
  });

  describe("callbacks", () => {
    it("calls onClick when clicked", () => {
      const onClick = vi.fn();
      render(<Button onClick={onClick}>Click me</Button>);

      fireEvent.click(screen.getByRole("button"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("does not call onClick when disabled", () => {
      const onClick = vi.fn();
      render(
        <Button onClick={onClick} disabled={true}>
          Click me
        </Button>
      );

      fireEvent.click(screen.getByRole("button"));
      expect(onClick).not.toHaveBeenCalled();
    });

    it("does not call onClick when loading", () => {
      const onClick = vi.fn();
      render(
        <Button onClick={onClick} loading={true}>
          Click me
        </Button>
      );

      fireEvent.click(screen.getByRole("button"));
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("additional props", () => {
    it("applies custom className", () => {
      render(<Button className="custom-class">Custom</Button>);
      expect(screen.getByRole("button")).toHaveClass("custom-class");
    });

    it("passes through type attribute", () => {
      render(<Button type="submit">Submit</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
    });

    it("passes through aria attributes", () => {
      render(<Button aria-describedby="description">Accessible</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("aria-describedby", "description");
    });
  });

  describe("accessibility", () => {
    it("is focusable", () => {
      render(<Button>Focusable</Button>);
      const button = screen.getByRole("button");
      button.focus();
      expect(document.activeElement).toBe(button);
    });

    it("has focus ring styles", () => {
      render(<Button>Focus Ring</Button>);
      const button = screen.getByRole("button");
      expect(button).toHaveClass("focus:ring-2", "focus:ring-offset-2");
    });
  });
});
