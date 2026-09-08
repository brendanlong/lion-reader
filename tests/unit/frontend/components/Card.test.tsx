/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Card components.
 *
 * Tests the Card, CardSection, and StatusCard components.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, StatusCard } from "@/components/ui/card";

describe("Card", () => {
  describe("rendering", () => {
    it("renders children correctly", () => {
      render(<Card>Card content</Card>);
      expect(screen.getByText("Card content")).toBeInTheDocument();
    });

    it("applies base styles", () => {
      render(<Card>Content</Card>);
      const card = screen.getByText("Content").closest("div");
      expect(card).toHaveClass("rounded-lg", "border", "bg-surface");
    });
  });

  describe("padding sizes", () => {
    it("applies sm padding", () => {
      render(<Card padding="sm">Small padding</Card>);
      const card = screen.getByText("Small padding").closest("div");
      expect(card).toHaveClass("p-3");
    });

    it("applies md padding", () => {
      render(<Card padding="md">Medium padding</Card>);
      const card = screen.getByText("Medium padding").closest("div");
      expect(card).toHaveClass("p-4");
    });

    it("applies lg padding (default)", () => {
      render(<Card padding="lg">Large padding</Card>);
      const card = screen.getByText("Large padding").closest("div");
      expect(card).toHaveClass("p-6");
    });

    it("uses lg padding as default", () => {
      render(<Card>Default padding</Card>);
      const card = screen.getByText("Default padding").closest("div");
      expect(card).toHaveClass("p-6");
    });
  });

  describe("custom className", () => {
    it("applies custom className", () => {
      render(<Card className="custom-class">Custom</Card>);
      const card = screen.getByText("Custom").closest("div");
      expect(card).toHaveClass("custom-class");
    });
  });
});

describe("StatusCard", () => {
  describe("variants", () => {
    it("applies info variant styles", () => {
      render(<StatusCard variant="info">Info</StatusCard>);
      const card = screen.getByText("Info").closest("div");
      expect(card).toHaveClass("border-info-border", "bg-info-subtle");
    });

    it("applies success variant styles", () => {
      render(<StatusCard variant="success">Success</StatusCard>);
      const card = screen.getByText("Success").closest("div");
      expect(card).toHaveClass("border-success-border", "bg-success-subtle");
    });

    it("applies warning variant styles", () => {
      render(<StatusCard variant="warning">Warning</StatusCard>);
      const card = screen.getByText("Warning").closest("div");
      expect(card).toHaveClass("border-warning-border", "bg-warning-subtle");
    });

    it("applies error variant styles", () => {
      render(<StatusCard variant="error">Error</StatusCard>);
      const card = screen.getByText("Error").closest("div");
      expect(card).toHaveClass("border-danger-border", "bg-danger-subtle");
    });
  });

  describe("padding sizes", () => {
    it("applies sm padding", () => {
      render(
        <StatusCard variant="info" padding="sm">
          Small
        </StatusCard>
      );
      const card = screen.getByText("Small").closest("div");
      expect(card).toHaveClass("p-3");
    });

    it("applies md padding (default)", () => {
      render(<StatusCard variant="info">Medium</StatusCard>);
      const card = screen.getByText("Medium").closest("div");
      expect(card).toHaveClass("p-4");
    });

    it("applies lg padding", () => {
      render(
        <StatusCard variant="info" padding="lg">
          Large
        </StatusCard>
      );
      const card = screen.getByText("Large").closest("div");
      expect(card).toHaveClass("p-6");
    });
  });

  describe("styling", () => {
    it("applies base styles", () => {
      render(<StatusCard variant="info">Base</StatusCard>);
      const card = screen.getByText("Base").closest("div");
      expect(card).toHaveClass("rounded-lg", "border");
    });

    it("applies custom className", () => {
      render(
        <StatusCard variant="info" className="custom-status">
          Custom
        </StatusCard>
      );
      const card = screen.getByText("Custom").closest("div");
      expect(card).toHaveClass("custom-status");
    });
  });
});
