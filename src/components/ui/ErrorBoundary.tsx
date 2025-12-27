/**
 * ErrorBoundary Component
 *
 * A React error boundary that catches JavaScript errors in its child component tree.
 * Displays a fallback UI with a retry button.
 */

"use client";

import { Component, type ReactNode } from "react";
import { Button } from "./button";

interface ErrorBoundaryProps {
  /**
   * Child components to render.
   */
  children: ReactNode;

  /**
   * Custom fallback component to render when an error occurs.
   * If not provided, a default error message is shown.
   */
  fallback?: ReactNode;

  /**
   * Callback when the retry button is clicked.
   * If not provided, the page will be reloaded.
   */
  onRetry?: () => void;

  /**
   * Custom error message to display.
   */
  message?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Default error fallback component.
 */
function DefaultErrorFallback({
  error,
  message,
  onRetry,
}: {
  error: Error | null;
  message?: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center" role="alert">
      <svg
        className="mb-4 h-12 w-12 text-red-400 dark:text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Something went wrong
      </h2>
      <p className="mb-4 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        {message ?? "An unexpected error occurred. Please try again."}
      </p>
      {error && process.env.NODE_ENV === "development" && (
        <pre className="mb-4 max-w-md overflow-auto rounded-md bg-zinc-100 p-3 text-left text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
          {error.message}
        </pre>
      )}
      <Button onClick={onRetry} variant="primary">
        Try again
      </Button>
    </div>
  );
}

/**
 * ErrorBoundary class component.
 * React error boundaries must be class components.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error to console in development
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  handleRetry = (): void => {
    const { onRetry } = this.props;

    // Reset the error state
    this.setState({ hasError: false, error: null });

    if (onRetry) {
      onRetry();
    } else {
      // Default: reload the page
      window.location.reload();
    }
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback, message } = this.props;

    if (hasError) {
      if (fallback) {
        return fallback;
      }

      return <DefaultErrorFallback error={error} message={message} onRetry={this.handleRetry} />;
    }

    return children;
  }
}

/**
 * Hook-friendly wrapper for using ErrorBoundary in functional components.
 * Provides a reset key pattern for controlled resets.
 */
interface ErrorBoundaryWithResetProps extends Omit<ErrorBoundaryProps, "onRetry"> {
  /**
   * Key that triggers a reset when changed.
   * Useful for resetting after navigation or state changes.
   */
  resetKey?: string | number;
}

/**
 * ErrorBoundaryWithReset component.
 * Automatically resets when the resetKey changes.
 */
export function ErrorBoundaryWithReset({
  children,
  resetKey,
  ...props
}: ErrorBoundaryWithResetProps): ReactNode {
  // Using key prop to force remount and reset error state
  return (
    <ErrorBoundary key={resetKey} {...props}>
      {children}
    </ErrorBoundary>
  );
}
