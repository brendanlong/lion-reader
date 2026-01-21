/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Alert component.
 *
 * Tests the presentational component with different variants.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Alert } from "@/components/ui/alert";

describe("Alert", () => {
  describe("rendering", () => {
    it("renders children correctly", () => {
      render(<Alert>Alert message</Alert>);
      expect(screen.getByRole("alert")).toHaveTextContent("Alert message");
    });

    it("has role='alert' for accessibility", () => {
      render(<Alert>Message</Alert>);
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    it("renders with default variant (info)", () => {
      render(<Alert>Info message</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-blue-50", "text-blue-800");
    });
  });

  describe("variants", () => {
    it("applies error variant styles", () => {
      render(<Alert variant="error">Error message</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-red-50", "text-red-800");
    });

    it("applies success variant styles", () => {
      render(<Alert variant="success">Success message</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-green-50", "text-green-800");
    });

    it("applies warning variant styles", () => {
      render(<Alert variant="warning">Warning message</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-yellow-50", "text-yellow-800");
    });

    it("applies info variant styles", () => {
      render(<Alert variant="info">Info message</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-blue-50", "text-blue-800");
    });
  });

  describe("styling", () => {
    it("applies base styles", () => {
      render(<Alert>Styled alert</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("rounded-md", "p-3");
    });

    it("applies custom className", () => {
      render(<Alert className="custom-class">Custom</Alert>);
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("custom-class");
    });

    it("preserves variant styles when custom className is added", () => {
      render(
        <Alert variant="error" className="mt-4">
          Error
        </Alert>
      );
      const alert = screen.getByRole("alert");
      expect(alert).toHaveClass("bg-red-50", "mt-4");
    });
  });

  describe("content", () => {
    it("renders complex children", () => {
      render(
        <Alert>
          <strong>Bold text</strong> and <a href="#">a link</a>
        </Alert>
      );
      expect(screen.getByText("Bold text")).toBeInTheDocument();
      expect(screen.getByRole("link")).toBeInTheDocument();
    });

    it("renders multiple elements", () => {
      render(
        <Alert>
          <p>First paragraph</p>
          <p>Second paragraph</p>
        </Alert>
      );
      expect(screen.getByText("First paragraph")).toBeInTheDocument();
      expect(screen.getByText("Second paragraph")).toBeInTheDocument();
    });
  });
});
