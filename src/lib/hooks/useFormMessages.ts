/**
 * useFormMessages Hook
 *
 * A reusable hook for managing form error and success messages.
 * Automatically clears success messages after a configurable timeout.
 */

import { useState, useCallback, useRef, useEffect } from "react";

interface UseFormMessagesOptions {
  /**
   * Time in milliseconds before success messages auto-clear.
   * Defaults to 3000ms (3 seconds).
   */
  successTimeout?: number;
}

interface UseFormMessagesReturn {
  /**
   * Current error message, or null if none.
   */
  error: string | null;

  /**
   * Current success message, or null if none.
   */
  success: string | null;

  /**
   * Show an error message. Clears any existing success message.
   */
  showError: (message: string) => void;

  /**
   * Show a success message. Clears any existing error message.
   * Message auto-clears after the configured timeout.
   */
  showSuccess: (message: string) => void;

  /**
   * Clear all messages.
   */
  clearMessages: () => void;
}

/**
 * Hook for managing form error and success messages with auto-clear.
 *
 * @example
 * ```tsx
 * const { error, success, showError, showSuccess } = useFormMessages();
 *
 * const handleSubmit = async () => {
 *   try {
 *     await saveSomething();
 *     showSuccess("Saved successfully");
 *   } catch (err) {
 *     showError(err.message);
 *   }
 * };
 *
 * return (
 *   <>
 *     {error && <Alert variant="error">{error}</Alert>}
 *     {success && <Alert variant="success">{success}</Alert>}
 *   </>
 * );
 * ```
 */
export function useFormMessages(options: UseFormMessagesOptions = {}): UseFormMessagesReturn {
  const { successTimeout = 3000 } = options;

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any existing timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const showError = useCallback((message: string) => {
    // Clear any pending success timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setError(message);
    setSuccess(null);
  }, []);

  const showSuccess = useCallback(
    (message: string) => {
      // Clear any pending success timeout
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      setSuccess(message);
      setError(null);

      // Auto-clear success message after timeout
      timeoutRef.current = setTimeout(() => {
        setSuccess(null);
        timeoutRef.current = null;
      }, successTimeout);
    },
    [successTimeout]
  );

  const clearMessages = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setError(null);
    setSuccess(null);
  }, []);

  return {
    error,
    success,
    showError,
    showSuccess,
    clearMessages,
  };
}
