/**
 * ErrorBoundary Component
 *
 * A React error boundary that catches JavaScript errors in its child component tree.
 * Displays a fallback UI with a retry button.
 */

"use client";

import { Component, type ReactNode } from "react";
import { Button } from "./button";
import { AlertIcon } from "@/components/ui/icon-button";

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
      <AlertIcon className="mb-4 h-12 w-12 text-red-400 dark:text-red-500" />
      <h2 className="ui-text-lg mb-2 font-semibold text-zinc-900 dark:text-zinc-50">
        Something went wrong
      </h2>
      <p className="ui-text-sm mb-4 max-w-sm text-zinc-500 dark:text-zinc-400">
        {message ?? "An unexpected error occurred. Please try again."}
      </p>
      {error && process.env.NODE_ENV === "development" && (
        <pre className="ui-text-xs mb-4 max-w-md overflow-auto rounded-md bg-zinc-100 p-3 text-left text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
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
