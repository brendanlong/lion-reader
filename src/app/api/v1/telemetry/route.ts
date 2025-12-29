/**
 * Telemetry API Endpoint
 *
 * Receives client-side metrics events and records them in Prometheus.
 * This allows tracking of browser-based events like voice downloads
 * and narration playback starts.
 *
 * Events:
 * - enhanced_voice_selected: User selected an enhanced voice
 * - enhanced_voice_download_completed: Voice download completed successfully
 * - enhanced_voice_download_failed: Voice download failed
 * - narration_playback_started: Narration playback started
 * - narration_highlight_active: Narration highlighting became active
 * - narration_highlight_scroll: Auto-scroll triggered during highlighting
 */

import { z } from "zod";
import {
  metricsEnabled,
  trackEnhancedVoiceSelected,
  trackEnhancedVoiceDownloadCompleted,
  trackEnhancedVoiceDownloadFailed,
  trackNarrationPlaybackStarted,
  trackNarrationHighlightActive,
  trackNarrationHighlightScroll,
  type EnhancedVoiceDownloadErrorType,
} from "@/server/metrics";

// ============================================================================
// Schemas
// ============================================================================

/**
 * Schema for enhanced voice selected event.
 */
const enhancedVoiceSelectedSchema = z.object({
  event: z.literal("enhanced_voice_selected"),
  voiceId: z.string().min(1),
});

/**
 * Schema for enhanced voice download completed event.
 */
const enhancedVoiceDownloadCompletedSchema = z.object({
  event: z.literal("enhanced_voice_download_completed"),
  voiceId: z.string().min(1),
});

/**
 * Schema for enhanced voice download failed event.
 */
const enhancedVoiceDownloadFailedSchema = z.object({
  event: z.literal("enhanced_voice_download_failed"),
  voiceId: z.string().min(1),
  errorType: z.enum(["network", "storage", "unknown"]),
});

/**
 * Schema for narration playback started event.
 */
const narrationPlaybackStartedSchema = z.object({
  event: z.literal("narration_playback_started"),
  provider: z.enum(["browser", "piper"]),
});

/**
 * Schema for narration highlight active event.
 * Fired when highlighting first becomes active in a narration session.
 */
const narrationHighlightActiveSchema = z.object({
  event: z.literal("narration_highlight_active"),
});

/**
 * Schema for narration highlight scroll event.
 * Fired when auto-scroll is triggered during highlighting.
 */
const narrationHighlightScrollSchema = z.object({
  event: z.literal("narration_highlight_scroll"),
});

/**
 * Union schema for all telemetry events.
 */
const telemetryEventSchema = z.discriminatedUnion("event", [
  enhancedVoiceSelectedSchema,
  enhancedVoiceDownloadCompletedSchema,
  enhancedVoiceDownloadFailedSchema,
  narrationPlaybackStartedSchema,
  narrationHighlightActiveSchema,
  narrationHighlightScrollSchema,
]);

type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

// ============================================================================
// Route Handler
// ============================================================================

/**
 * POST /api/v1/telemetry
 *
 * Records a client-side metrics event.
 * No authentication required - events are anonymous.
 */
export async function POST(req: Request): Promise<Response> {
  // If metrics are disabled, accept but do nothing
  if (!metricsEnabled) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Parse and validate the request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON",
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const result = telemetryEventSchema.safeParse(body);
  if (!result.success) {
    return new Response(
      JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid event format",
          details: result.error.flatten(),
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const event: TelemetryEvent = result.data;

  // Record the metric based on event type
  switch (event.event) {
    case "enhanced_voice_selected":
      trackEnhancedVoiceSelected(event.voiceId);
      break;

    case "enhanced_voice_download_completed":
      trackEnhancedVoiceDownloadCompleted(event.voiceId);
      break;

    case "enhanced_voice_download_failed":
      trackEnhancedVoiceDownloadFailed(
        event.voiceId,
        event.errorType as EnhancedVoiceDownloadErrorType
      );
      break;

    case "narration_playback_started":
      trackNarrationPlaybackStarted(event.provider);
      break;

    case "narration_highlight_active":
      trackNarrationHighlightActive();
      break;

    case "narration_highlight_scroll":
      trackNarrationHighlightScroll();
      break;
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
