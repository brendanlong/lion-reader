/**
 * POST /api/v1/telemetry
 *
 * Records a browser event (`@/lib/telemetry`) in Prometheus. No
 * authentication: events are anonymous.
 */

import { telemetryEventSchema } from "@/lib/telemetry";
import {
  metricsEnabled,
  trackEnhancedVoiceSelected,
  trackEnhancedVoiceModelDownloadCompleted,
  trackEnhancedVoiceModelDownloadFailed,
  trackNarrationPlaybackStarted,
} from "@/server/metrics/metrics";

export async function POST(req: Request): Promise<Response> {
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

  const event = result.data;
  if (metricsEnabled) {
    switch (event.event) {
      case "enhanced_voice_selected":
        trackEnhancedVoiceSelected(event.voiceId);
        break;
      case "enhanced_voice_model_download_completed":
        trackEnhancedVoiceModelDownloadCompleted();
        break;
      case "enhanced_voice_model_download_failed":
        trackEnhancedVoiceModelDownloadFailed(event.errorType);
        break;
      case "narration_playback_started":
        trackNarrationPlaybackStarted(event.provider);
        break;
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
