/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Card components.
 *
 * Tests the Card and StatusCard components.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, StatusCard } from "@/components/ui/card";

describe("Card", () => {
  it("renders children correctly", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Card className="custom-class">Custom</Card>);
    const card = screen.getByText("Custom").closest("div");
    expect(card).toHaveClass("custom-class");
  });
});

describe("StatusCard", () => {
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
