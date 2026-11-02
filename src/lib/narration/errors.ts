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
}

/**
 * User-friendly messages and suggestions for each error type.
 */
const ERROR_INFO: Record<VoiceErrorType, Omit<VoiceErrorInfo, "type">> = {
  quota_exceeded: {
    message: "Not enough storage space to download the voice model.",
    suggestion: "Try deleting other sites' data in your browser to free up space.",
  },
  network_error: {
    message: "Download failed due to a network error.",
    suggestion: "Check your internet connection and try again.",
  },
  voice_not_found: {
    message: "This voice is not available.",
    suggestion: "The voice may have been removed. Please select a different voice.",
  },
  corrupted_cache: {
    message: "The downloaded voice model appears to be corrupted.",
    suggestion: "Delete the voice model and download it again.",
  },
  download_interrupted: {
    message: "The download was interrupted.",
    suggestion: "Try downloading again when you have a stable connection.",
  },
  unknown: {
    message: "Something went wrong with the voice model.",
    suggestion: "Try again or use a browser voice instead.",
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
 */
export function classifyVoiceError(error: unknown): VoiceErrorType {
  if (!(error instanceof Error)) {
    return "unknown";
  }

  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // Check for quota exceeded errors (origin private file system storage limit)
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
 * Returns the error type, user-friendly message, and optional suggestion.
 *
 * @param error - The error to get information for.
 * @returns Complete error information including message and suggestion.
 */
export function getVoiceErrorInfo(error: unknown): VoiceErrorInfo {
  const type = classifyVoiceError(error);
  const info = ERROR_INFO[type];

  return {
    type,
    ...info,
  };
}
