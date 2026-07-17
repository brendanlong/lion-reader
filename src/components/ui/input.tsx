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
        className={`ui-text-sm bg-surface text-body placeholder:text-faint block w-full rounded-md border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50 ${
          error ? "border-danger" : "border-edge-input"
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
