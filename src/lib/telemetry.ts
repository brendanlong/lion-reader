/**
 * Client-side Telemetry
 *
 * Utility for sending metrics events from the browser to the server.
 * Events are sent to the /api/v1/telemetry endpoint which records
 * them in Prometheus.
 *
 * All telemetry functions are fire-and-forget - errors are silently ignored
 * to avoid impacting the user experience.
 *
 * @module lib/telemetry
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Error types for voice download failures.
 */
export type VoiceDownloadErrorType = "network" | "storage" | "unknown";

/**
 * TTS provider types.
 */
export type TTSProvider = "browser" | "piper";

// ============================================================================
// Internal
// ============================================================================

/**
 * Sends a telemetry event to the server.
 * Silently ignores any errors.
 */
async function sendTelemetryEvent(event: Record<string, unknown>): Promise<void> {
  try {
    await fetch("/api/v1/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
      // Use keepalive to ensure the request completes even if the page unloads
      keepalive: true,
    });
  } catch {
    // Silently ignore errors - telemetry should never impact user experience
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Tracks when a user selects an enhanced voice.
 *
 * @param voiceId - The ID of the selected voice.
 */
export function trackEnhancedVoiceSelected(voiceId: string): void {
  void sendTelemetryEvent({
    event: "enhanced_voice_selected",
    voiceId,
  });
}

/**
 * Tracks when an enhanced voice download completes successfully.
 *
 * @param voiceId - The ID of the downloaded voice.
 */
export function trackEnhancedVoiceDownloadCompleted(voiceId: string): void {
  void sendTelemetryEvent({
    event: "enhanced_voice_download_completed",
    voiceId,
  });
}

/**
 * Tracks when an enhanced voice download fails.
 *
 * @param voiceId - The ID of the voice that failed to download.
 * @param errorType - The type of error that occurred.
 */
export function trackEnhancedVoiceDownloadFailed(
  voiceId: string,
  errorType: VoiceDownloadErrorType
): void {
  void sendTelemetryEvent({
    event: "enhanced_voice_download_failed",
    voiceId,
    errorType,
  });
}

/**
 * Tracks when narration playback starts.
 *
 * @param provider - The TTS provider being used.
 */
export function trackNarrationPlaybackStarted(provider: TTSProvider): void {
  void sendTelemetryEvent({
    event: "narration_playback_started",
    provider,
  });
}

/**
 * Classifies an error into a download error type.
 *
 * @param error - The error to classify.
 * @returns The error type.
 */
export function classifyDownloadError(error: unknown): VoiceDownloadErrorType {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const name = error.name.toLowerCase();

    // Check for storage-related errors
    if (
      name.includes("quota") ||
      message.includes("quota") ||
      message.includes("storage") ||
      message.includes("indexeddb")
    ) {
      return "storage";
    }

    // Check for network-related errors
    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("failed to fetch") ||
      message.includes("connection") ||
      message.includes("timeout")
    ) {
      return "network";
    }
  }

  return "unknown";
}
