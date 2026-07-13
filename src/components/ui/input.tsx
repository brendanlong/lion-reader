/**
 * Input Component
 *
 * A styled input field with support for labels, errors, and various states.
 */

import type { InputHTMLAttributes, Ref } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ label, error, id, className = "", ref, ...props }: InputProps) {
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={id} className="ui-text-sm text-body mb-1.5 block font-medium">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={id}
        className={`ui-text-sm bg-surface text-strong placeholder:text-faint block w-full rounded-md border px-3 py-2 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          error
            ? "border-danger focus:border-danger focus:ring-danger"
            : "border-edge-input focus:border-focus focus:ring-focus"
        } ${className}`}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error && (
        <p id={`${id}-error`} className="ui-text-sm text-danger mt-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
