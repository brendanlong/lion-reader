/**
 * Error classification and user-friendly messages for voice download errors.
 *
 * Provides structured error handling for enhanced voice downloads,
 * including error classification and actionable user messages.
 *
 * @module narration/errors
 */

/**
 * Types of errors that can occur during voice downloads.
 */
export type VoiceErrorType =
  | "quota_exceeded"
  | "network_error"
  | "voice_not_found"
  | "corrupted_cache"
  | "download_interrupted"
  | "unknown";

/**
 * Information about a classified voice error.
 */
export interface VoiceErrorInfo {
  /**
   * The error type classification.
   */
  type: VoiceErrorType;

  /**
   * User-friendly error message.
   */
  message: string;

  /**
   * Optional suggestion for resolving the error.
   */
  suggestion?: string;

  /**
   * Whether the error is retryable.
   */
  retryable: boolean;
}

/**
 * User-friendly messages and suggestions for each error type.
 */
const ERROR_INFO: Record<VoiceErrorType, Omit<VoiceErrorInfo, "type">> = {
  quota_exceeded: {
    message: "Not enough storage space to download this voice.",
    suggestion: "Try deleting unused voices to free up space.",
    retryable: false,
  },
  network_error: {
    message: "Download failed due to a network error.",
    suggestion: "Check your internet connection and try again.",
    retryable: true,
  },
  voice_not_found: {
    message: "This voice is not available.",
    suggestion: "The voice may have been removed. Please select a different voice.",
    retryable: false,
  },
  corrupted_cache: {
    message: "The cached voice data appears to be corrupted.",
    suggestion: "The cache will be cleared automatically. Try downloading again.",
    retryable: true,
  },
  download_interrupted: {
    message: "The download was interrupted.",
    suggestion: "Try downloading again when you have a stable connection.",
    retryable: true,
  },
  unknown: {
    message: "Failed to download voice.",
    suggestion: "Try again or use a browser voice instead.",
    retryable: true,
  },
};

/**
 * Classifies an error into a voice error type.
 *
 * Analyzes the error's name and message to determine the most appropriate
 * error classification for user-friendly messaging.
 *
 * @param error - The error to classify.
 * @returns The error type classification.
 *
 * @example
 * ```ts
 * try {
 *   await downloadVoice(voiceId, onProgress);
 * } catch (error) {
 *   const errorType = classifyVoiceError(error);
 *   if (errorType === "quota_exceeded") {
 *     showStorageWarning();
 *   }
 * }
 * ```
 */
export function classifyVoiceError(error: unknown): VoiceErrorType {
  if (!(error instanceof Error)) {
    return "unknown";
  }

  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Check for quota exceeded errors (IndexedDB storage limit)
  if (
    name === "quotaexceedederror" ||
    name.includes("quota") ||
    message.includes("quota") ||
    message.includes("storage") ||
    message.includes("disk") ||
    message.includes("space")
  ) {
    return "quota_exceeded";
  }

  // Check for voice not found (404 errors)
  if (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("does not exist")
  ) {
    return "voice_not_found";
  }

  // Check for network-related errors
  if (
    name === "networkerror" ||
    name === "typeerror" || // fetch can throw TypeError for network issues
    message.includes("network") ||
    message.includes("fetch") ||
    message.includes("failed to fetch") ||
    message.includes("connection") ||
    message.includes("timeout") ||
    message.includes("net::") ||
    message.includes("dns") ||
    message.includes("offline")
  ) {
    return "network_error";
  }

  // Check for download interruption
  if (
    name === "aborterror" ||
    message.includes("abort") ||
    message.includes("interrupt") ||
    message.includes("cancel")
  ) {
    return "download_interrupted";
  }

  // Check for corrupted cache
  if (
    message.includes("corrupt") ||
    message.includes("invalid") ||
    message.includes("parse") ||
    message.includes("malformed") ||
    (message.includes("indexeddb") && message.includes("error"))
  ) {
    return "corrupted_cache";
  }

  return "unknown";
}

/**
 * Gets full error information for a classified error.
 *
 * Returns the error type, user-friendly message, optional suggestion,
 * and whether the error is retryable.
 *
 * @param error - The error to get information for.
 * @returns Complete error information including message and suggestion.
 *
 * @example
 * ```ts
 * try {
 *   await downloadVoice(voiceId, onProgress);
 * } catch (error) {
 *   const errorInfo = getVoiceErrorInfo(error);
 *   showError(errorInfo.message);
 *   if (errorInfo.suggestion) {
 *     showHint(errorInfo.suggestion);
 *   }
 *   if (errorInfo.retryable) {
 *     showRetryButton();
 *   }
 * }
 * ```
 */
export function getVoiceErrorInfo(error: unknown): VoiceErrorInfo {
  const type = classifyVoiceError(error);
  const info = ERROR_INFO[type];

  return {
    type,
    ...info,
  };
}

/**
 * Gets a user-friendly error message for a voice error.
 *
 * Convenience function that returns just the message string.
 *
 * @param error - The error to get a message for.
 * @returns User-friendly error message.
 *
 * @example
 * ```ts
 * try {
 *   await downloadVoice(voiceId, onProgress);
 * } catch (error) {
 *   setError(getVoiceErrorMessage(error));
 * }
 * ```
 */
export function getVoiceErrorMessage(error: unknown): string {
  const info = getVoiceErrorInfo(error);
  return info.message;
}

/**
 * Checks if a voice error is retryable.
 *
 * @param error - The error to check.
 * @returns true if the operation can be retried, false otherwise.
 *
 * @example
 * ```ts
 * catch (error) {
 *   if (isVoiceErrorRetryable(error)) {
 *     showRetryButton();
 *   }
 * }
 * ```
 */
export function isVoiceErrorRetryable(error: unknown): boolean {
  const info = getVoiceErrorInfo(error);
  return info.retryable;
}
