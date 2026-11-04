/**
 * GET /api/prerecorded-speech/voice
 *
 * The voice the demo's narration is recorded in (`getDemoNarrationVoice`), or
 * null when the demo narrates with the browser's voices. The demo page is
 * prerendered, so it asks here at runtime rather than baking in a setting.
 * No auth: it's the demo's, and says only which voice.
 */

import { getDemoNarrationVoice } from "@/server/services/demo-narration";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { voice: getDemoNarrationVoice() },
    { headers: { "Cache-Control": "no-store" } }
  );
}
