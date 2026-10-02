/**
 * POST /api/v1/narration/speech
 *
 * One chunk of narration spoken by a cloud voice, streamed as MP3 while the
 * provider generates it, so playback can start on the first bytes. It's a
 * route handler because tRPC (and so the generated REST API) can't stream a
 * binary body; `narration.synthesize` is the same thing read whole, for app
 * versions from before this existed.
 *
 * Takes the web's session or the app's token (see `route-auth.ts`). Browser
 * requests are CSRF-safe the way tRPC's are: the session cookie is
 * `SameSite=Lax`, and a JSON body can't come from a cross-site form.
 *
 * Errors before any audio are JSON `{ code, message }` with the status the
 * REST API would use; a failure after audio has started cuts the stream short.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { MAX_CLOUD_SPEECH_CHARS } from "@/lib/narration/constants";
import { authenticateRouteRequest } from "@/server/auth/route-auth";
import { getUserApiKeys } from "@/server/auth/session";
import { SpeechRequestError, streamSpeech } from "@/server/services/speech";
import {
  checkRateLimit,
  getClientIdentifier,
  getRateLimitHeaders,
  RATE_LIMIT_CONFIGS,
  speechRateLimitCost,
} from "@/server/rate-limit";

/** Far more than the largest valid body: rejects floods before parsing them. */
const MAX_BODY_CHARS = 4 * MAX_CLOUD_SPEECH_CHARS + 1024;

const speechRequestSchema = z.object({
  /** `provider:model` ref; null means the default model. */
  model: z.string().max(200).nullable(),
  /** Null means the model's default voice. */
  voice: z.string().max(200).nullable(),
  text: z.string().min(1).max(MAX_CLOUD_SPEECH_CHARS),
});

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateRouteRequest(req.headers);
  if (!auth) return errorResponse(401, "UNAUTHORIZED", "Invalid or expired session");
  if (!auth.confirmed) {
    return errorResponse(
      403,
      "SIGNUP_CONFIRMATION_REQUIRED",
      "You must complete signup before accessing this resource"
    );
  }
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Expected a JSON body");
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) {
    return errorResponse(413, "PAYLOAD_TOO_LARGE", "Request body too large");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return errorResponse(400, "BAD_REQUEST", "Invalid JSON");
  }
  const parsed = speechRequestSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const input = parsed.data;

  const limit = await checkRateLimit(getClientIdentifier(auth.userId, req.headers), "speech", {
    cost: speechRateLimitCost(input.text),
  });
  const limitHeaders = getRateLimitHeaders(limit, RATE_LIMIT_CONFIGS.speech);
  if (!limit.allowed) {
    return errorResponse(
      429,
      "TOO_MANY_REQUESTS",
      `Rate limit exceeded. Please retry after ${limit.retryAfterSeconds} seconds.`,
      limitHeaders
    );
  }

  const keys = await getUserApiKeys(auth.userId);
  try {
    const audio = await streamSpeech(keys, input, req.signal);
    return new Response(audio, {
      headers: {
        ...limitHeaders,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof SpeechRequestError) {
      return errorResponse(400, "BAD_REQUEST", error.message, limitHeaders);
    }
    logger.error("Speech synthesis failed", {
      model: input.model,
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(500, "INTERNAL_SERVER_ERROR", "Speech synthesis failed", limitHeaders);
  }
}
