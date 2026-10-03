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
      // Primary variant applies the shared btn-primary color utility
      expect(button).toHaveClass("btn-primary");
      // md size has min-h-[44px]
      expect(button).toHaveClass("min-h-[44px]");
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
  });

  describe("accessibility", () => {
    it("does not suppress the global focus outline (#1292)", () => {
      render(<Button>Focus Ring</Button>);
      const button = screen.getByRole("button");
      // Focus visibility comes from the global :focus-visible outline in
      // globals.css; per-component focus rings are not allowed.
      expect(button.className).not.toMatch(/focus:/);
    });
  });
});
