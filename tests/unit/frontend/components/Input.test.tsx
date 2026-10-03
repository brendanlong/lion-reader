/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for Input component.
 *
 * Tests the input with label, error state, and disabled state.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Input } from "@/components/ui/input";

describe("Input", () => {
  describe("rendering", () => {
    it("renders an input element", () => {
      render(<Input />);
      expect(screen.getByRole("textbox")).toBeInTheDocument();
    });
  });

  describe("label", () => {
    it("renders label when provided", () => {
      render(<Input label="Email" id="email" />);
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("renders error message when provided", () => {
      render(<Input error="This field is required" id="field" />);
      expect(screen.getByText("This field is required")).toBeInTheDocument();
    });

    it("does not render error message when not provided", () => {
      render(<Input id="field" />);
      expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    });

    it("sets aria-invalid when error is present", () => {
      render(<Input error="Invalid" id="invalid-field" />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("does not set aria-invalid when no error", () => {
      render(<Input id="valid-field" />);
      const input = screen.getByRole("textbox");
      expect(input).not.toHaveAttribute("aria-invalid");
    });

    it("sets aria-describedby to error message id", () => {
      render(<Input error="Error message" id="my-field" />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("aria-describedby", "my-field-error");
    });

    it("error message has correct id", () => {
      render(<Input error="Error message" id="my-field" />);
      const errorMessage = screen.getByText("Error message");
      expect(errorMessage).toHaveAttribute("id", "my-field-error");
    });
  });

  describe("disabled state", () => {
    it("is disabled when disabled prop is true", () => {
      render(<Input disabled={true} />);
      expect(screen.getByRole("textbox")).toBeDisabled();
    });
  });

  describe("callbacks", () => {
    it("calls onChange when value changes", () => {
      const onChange = vi.fn();
      render(<Input onChange={onChange} />);

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "new value" } });
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("additional props", () => {
    it("applies custom className", () => {
      render(<Input className="custom-class" />);
      expect(screen.getByRole("textbox")).toHaveClass("custom-class");
    });

    it("passes through type attribute", () => {
      render(<Input type="email" />);
      expect(screen.getByRole("textbox")).toHaveAttribute("type", "email");
    });
  });

  describe("styling", () => {
    it("does not suppress the global focus outline (#1292)", () => {
      render(<Input />);
      const input = screen.getByRole("textbox");
      // Focus visibility comes from the global :focus-visible outline in
      // globals.css; per-component focus rings are not allowed.
      expect(input.className).not.toMatch(/focus:/);
    });
  });

  describe("composition with label and error", () => {
    it("renders complete input with label and error", () => {
      render(<Input label="Password" id="password" error="Password is too short" />);

      expect(screen.getByLabelText("Password")).toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getByRole("textbox")).toHaveAttribute("aria-describedby", "password-error");
      expect(screen.getByText("Password is too short")).toBeInTheDocument();
    });
  });
});
