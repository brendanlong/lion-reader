/**
 * Input Component
 *
 * A styled input field with support for labels, errors, and various states.
 */

import { forwardRef, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, id, className = "", ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={id}
            className="ui-text-base mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={id}
          className={`ui-text-base block w-full rounded-md border bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500 ${
            error
              ? "border-red-500 focus:border-red-500 focus:ring-red-500 dark:border-red-500"
              : "border-zinc-300 focus:border-zinc-900 focus:ring-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
          } ${className}`}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          {...props}
        />
        {error && (
          <p id={`${id}-error`} className="ui-text-base mt-1.5 text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";
