/**
 * The telemetry endpoint is unauthenticated and turns voiceId into a Prometheus
 * label, so it must accept only known voices — anything else is a way to grow
 * label cardinality without bound.
 */

import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/v1/telemetry/route";
import { ENHANCED_VOICES } from "@/lib/narration/enhanced-voices";

function telemetryRequest(body: unknown): Request {
  return new Request("https://example.com/api/v1/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const knownVoiceId = ENHANCED_VOICES[0].id;

describe("POST /api/v1/telemetry voiceId validation", () => {
  it("accepts a known voice", async () => {
    const response = await POST(
      telemetryRequest({ event: "enhanced_voice_selected", voiceId: knownVoiceId })
    );
    expect(response.status).toBe(200);
  });

  it("rejects an unknown voice", async () => {
    const response = await POST(
      telemetryRequest({ event: "enhanced_voice_selected", voiceId: "attacker-chosen-label" })
    );
    expect(response.status).toBe(400);
  });
});
