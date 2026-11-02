/**
 * Client-side telemetry: browser events, sent to `/api/v1/telemetry`, which
 * validates them with {@link telemetryEventSchema} and records them in
 * Prometheus. Sending is fire-and-forget: a failure never reaches the user.
 *
 * @module lib/telemetry
 */

import { z } from "zod";
import { isEnhancedVoice } from "@/lib/narration/enhanced-voices";
import { TTS_PROVIDER_IDS, type TTSProviderId } from "@/lib/narration/types";

/**
 * voiceId becomes a Prometheus label on an unauthenticated endpoint, so only
 * known voices are accepted — a free-form string would let anyone grow label
 * cardinality (and server memory) without bound.
 */
const voiceIdSchema = z.string().refine(isEnhancedVoice, { message: "Unknown voice" });

const voiceDownloadErrorTypeSchema = z.enum(["network", "storage", "unknown"]);

/** Why the enhanced voice model download failed: a `fetch`, or browser storage or its quota. */
export type VoiceDownloadErrorType = z.infer<typeof voiceDownloadErrorTypeSchema>;

export const telemetryEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("enhanced_voice_selected"), voiceId: voiceIdSchema }),
  z.object({ event: z.literal("enhanced_voice_model_download_completed") }),
  z.object({
    event: z.literal("enhanced_voice_model_download_failed"),
    errorType: voiceDownloadErrorTypeSchema,
  }),
  z.object({ event: z.literal("narration_playback_started"), provider: z.enum(TTS_PROVIDER_IDS) }),
]);

type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

async function sendTelemetryEvent(event: TelemetryEvent): Promise<void> {
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

export function trackEnhancedVoiceSelected(voiceId: string): void {
  void sendTelemetryEvent({ event: "enhanced_voice_selected", voiceId });
}

export function trackEnhancedVoiceModelDownloadCompleted(): void {
  void sendTelemetryEvent({ event: "enhanced_voice_model_download_completed" });
}

export function trackEnhancedVoiceModelDownloadFailed(errorType: VoiceDownloadErrorType): void {
  void sendTelemetryEvent({ event: "enhanced_voice_model_download_failed", errorType });
}

export function trackNarrationPlaybackStarted(provider: TTSProviderId): void {
  void sendTelemetryEvent({ event: "narration_playback_started", provider });
}

/** What kind of failure a voice download's error is, by its name and message. */
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
