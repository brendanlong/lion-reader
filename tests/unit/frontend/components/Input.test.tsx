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

    it("renders with placeholder", () => {
      render(<Input placeholder="Enter text..." />);
      expect(screen.getByPlaceholderText("Enter text...")).toBeInTheDocument();
    });

    it("renders with initial value", () => {
      render(<Input value="Hello" onChange={vi.fn()} />);
      expect(screen.getByRole("textbox")).toHaveValue("Hello");
    });
  });

  describe("label", () => {
    it("renders label when provided", () => {
      render(<Input label="Email" id="email" />);
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
    });

    it("does not render label when not provided", () => {
      render(<Input id="email" />);
      expect(screen.queryByRole("label")).not.toBeInTheDocument();
    });

    it("associates label with input via htmlFor", () => {
      render(<Input label="Email" id="email-field" />);
      const label = screen.getByText("Email");
      expect(label).toHaveAttribute("for", "email-field");
    });

    it("applies label styles", () => {
      render(<Input label="Styled Label" id="styled" />);
      const label = screen.getByText("Styled Label");
      expect(label).toHaveClass("font-medium", "text-zinc-700");
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

    it("applies error border styles", () => {
      render(<Input error="Error" id="error-field" />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("border-red-500");
    });

    it("applies normal border styles when no error", () => {
      render(<Input id="normal-field" />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("border-zinc-300");
      expect(input).not.toHaveClass("border-red-500");
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

    it("applies error text styles", () => {
      render(<Input error="Error text" id="field" />);
      const errorMessage = screen.getByText("Error text");
      expect(errorMessage).toHaveClass("text-red-600");
    });
  });

  describe("disabled state", () => {
    it("is disabled when disabled prop is true", () => {
      render(<Input disabled={true} />);
      expect(screen.getByRole("textbox")).toBeDisabled();
    });

    it("is not disabled when disabled prop is false", () => {
      render(<Input disabled={false} />);
      expect(screen.getByRole("textbox")).not.toBeDisabled();
    });

    it("applies disabled styles", () => {
      render(<Input disabled={true} />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("disabled:cursor-not-allowed", "disabled:opacity-50");
    });
  });

  describe("callbacks", () => {
    it("calls onChange when value changes", () => {
      const onChange = vi.fn();
      render(<Input onChange={onChange} />);

      fireEvent.change(screen.getByRole("textbox"), { target: { value: "new value" } });
      expect(onChange).toHaveBeenCalledTimes(1);
    });

    it("calls onFocus when focused", () => {
      const onFocus = vi.fn();
      render(<Input onFocus={onFocus} />);

      fireEvent.focus(screen.getByRole("textbox"));
      expect(onFocus).toHaveBeenCalledTimes(1);
    });

    it("calls onBlur when blurred", () => {
      const onBlur = vi.fn();
      render(<Input onBlur={onBlur} />);

      const input = screen.getByRole("textbox");
      fireEvent.focus(input);
      fireEvent.blur(input);
      expect(onBlur).toHaveBeenCalledTimes(1);
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

    it("passes through name attribute", () => {
      render(<Input name="username" />);
      expect(screen.getByRole("textbox")).toHaveAttribute("name", "username");
    });

    it("passes through required attribute", () => {
      render(<Input required />);
      expect(screen.getByRole("textbox")).toBeRequired();
    });

    it("passes through maxLength attribute", () => {
      render(<Input maxLength={100} />);
      expect(screen.getByRole("textbox")).toHaveAttribute("maxLength", "100");
    });

    it("passes through autoComplete attribute", () => {
      render(<Input autoComplete="email" />);
      expect(screen.getByRole("textbox")).toHaveAttribute("autoComplete", "email");
    });
  });

  describe("styling", () => {
    it("applies base input styles", () => {
      render(<Input />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("rounded-md", "border", "bg-white", "px-3", "py-2");
    });

    it("applies focus ring styles", () => {
      render(<Input />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("focus:ring-2", "focus:ring-offset-2");
    });

    it("fills width of container", () => {
      render(<Input />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveClass("w-full");
    });
  });

  describe("accessibility", () => {
    it("is focusable", () => {
      render(<Input />);
      const input = screen.getByRole("textbox");
      input.focus();
      expect(document.activeElement).toBe(input);
    });

    it("has proper input id for label association", () => {
      render(<Input label="Name" id="name-input" />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("id", "name-input");
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
