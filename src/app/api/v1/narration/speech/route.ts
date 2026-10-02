/**
 * POST /api/v1/narration/speech
 *
 * One chunk of narration spoken by a cloud voice, streamed as AAC in
 * fragmented MP4 while the provider generates it (see `speech-encoding.ts`),
 * so playback can start on the first bytes. It's a route handler because tRPC
 * (and so the generated REST API) can't stream a binary body.
 *
 * Takes the web's session or the app's token (see `route-auth.ts`). Browser
 * requests are CSRF-safe the way tRPC's are: the session cookie is
 * `SameSite=Lax`, and a JSON body can't come from a cross-site form.
 *
 * Errors before any audio are JSON shaped like the REST API's (`message`, and
 * `data.appErrorCode` where tRPC would set one) with the status it would use;
 * a failure after audio has started cuts the stream short.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { MAX_CLOUD_SPEECH_CHARS, MAX_CLOUD_SPEECH_PAUSE_SECONDS } from "@/lib/narration/constants";
import { authenticateRouteRequest } from "@/server/auth/route-auth";
import {
  BodyReadTimeoutError,
  ContentTooLargeError,
  readRequestBufferWithSizeLimit,
} from "@/server/http/fetch";
import { getUserApiKeys } from "@/server/auth/session";
import { SpeechRequestError, streamSpeech } from "@/server/services/speech";
import { ProviderBusyError } from "@/server/services/provider-errors";
import {
  checkRateLimit,
  getClientIdentifier,
  getRateLimitHeaders,
  RATE_LIMIT_CONFIGS,
  speechRateLimitCost,
} from "@/server/rate-limit";

/** Far more than the largest valid body (UTF-8 and JSON escapes included). */
const MAX_BODY_BYTES = 8 * MAX_CLOUD_SPEECH_CHARS + 1024;

const speechRequestSchema = z.object({
  /** `provider:model` ref; null means the default model. */
  model: z.string().max(200).nullable(),
  /** Null means the model's default voice. */
  voice: z.string().max(200).nullable(),
  text: z.string().min(1).max(MAX_CLOUD_SPEECH_CHARS),
  /** Silence after the speech, so chunks played back to back pause like sentences do. */
  pauseSeconds: z.number().min(0).max(MAX_CLOUD_SPEECH_PAUSE_SECONDS).default(0),
});

function errorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
  appErrorCode?: string
): Response {
  const data = appErrorCode ? { appErrorCode } : undefined;
  return new Response(JSON.stringify({ code, message, data }), {
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
      "FORBIDDEN",
      "You must complete signup before accessing this resource",
      {},
      "SIGNUP_CONFIRMATION_REQUIRED"
    );
  }
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Expected a JSON body");
  }

  let raw: Buffer;
  try {
    raw = await readRequestBufferWithSizeLimit(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    }
    if (error instanceof BodyReadTimeoutError) {
      return errorResponse(408, "REQUEST_TIMEOUT", "Request body took too long");
    }
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
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
        "Content-Type": "audio/mp4",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ProviderBusyError) {
      logger.warn("Speech provider busy", { model: input.model, error: error.message });
      return errorResponse(
        503,
        "SERVICE_UNAVAILABLE",
        "The cloud voice is busy; try again shortly",
        {
          ...limitHeaders,
          "Retry-After": String(Math.ceil(error.retryAfterSeconds ?? 5)),
        }
      );
    }
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
