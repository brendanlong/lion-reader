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
  it("renders its children inside an alert region", () => {
    render(
      <Alert>
        <strong>Bold text</strong> and <a href="#">a link</a>
      </Alert>
    );
    const alert = screen.getByRole("alert");
    expect(alert).toContainElement(screen.getByText("Bold text"));
    expect(alert).toContainElement(screen.getByRole("link"));
  });
});
