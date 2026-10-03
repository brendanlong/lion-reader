/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Alert component.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Alert } from "@/components/ui/alert";

describe("Alert", () => {
  it("renders children correctly", () => {
    render(<Alert>Alert message</Alert>);
    expect(screen.getByRole("alert")).toHaveTextContent("Alert message");
  });

  it("applies custom className", () => {
    render(<Alert className="custom-class">Custom</Alert>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveClass("custom-class");
  });

  it("renders complex children", () => {
    render(
      <Alert>
        <strong>Bold text</strong> and <a href="#">a link</a>
      </Alert>
    );
    expect(screen.getByText("Bold text")).toBeInTheDocument();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });
});
