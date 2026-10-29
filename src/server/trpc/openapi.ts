/**
 * OpenAPI Document Generator
 *
 * Generates the OpenAPI 3.1 specification from the tRPC router.
 * This enables REST API access alongside tRPC.
 */

import { z } from "zod";
import { generateOpenApiDocument } from "trpc-to-openapi";
import { SPEECH_FAILOVER_HEADER } from "@/lib/narration/constants";
import { speechRequestSchema } from "@/server/services/speech";
import { appRouter } from "./root";

/** The JSON body of a route handler's error (`errorResponse` in each route). */
const routeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  data: z.object({ appErrorCode: z.string() }).optional(),
});

function routeErrors(statuses: Record<number, string>) {
  return Object.fromEntries(
    Object.entries(statuses).map(([status, description]) => [
      status,
      { description, content: { "application/json": { schema: routeErrorSchema } } },
    ])
  );
}

/**
 * OpenAPI document for the Lion Reader API.
 * This is generated from the tRPC router and can be used with
 * Swagger UI or other OpenAPI tools. Route handlers outside tRPC that the
 * native app calls are added by hand, so the breaking-change check covers them.
 */
export const openApiDocument = generateOpenApiDocument(appRouter, {
  title: "Lion Reader API",
  description: "REST API for Lion Reader - A modern feed reader",
  version: "1.0.0",
  baseUrl: "/api/v1",
  docsUrl: "https://github.com/brendanlong/lion-reader",
  tags: ["auth", "users", "subscriptions", "entries", "feeds"],
  paths: {
    "/narration/speech": {
      post: {
        operationId: "narration-speech",
        summary: "Speak a chunk of narration",
        description:
          "Streams the text spoken by a cloud voice as AAC in fragmented MP4 while it's generated. A failure after audio has started cuts the stream short.",
        tags: ["Narration"],
        security: [{ Authorization: [] }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: speechRequestSchema } },
        },
        responses: {
          "200": {
            description: "The speech, streamed",
            headers: {
              [SPEECH_FAILOVER_HEADER]: {
                description:
                  "The model that said it, when the one asked for was busy and the server failed over: don't cache it as the one asked for",
                schema: { type: "string" },
              },
            },
            content: { "audio/mp4": { schema: { type: "string", contentMediaType: "audio/mp4" } } },
          },
          ...routeErrors({
            400: "Invalid input, or no cloud voice can speak it",
            401: "Authorization not provided",
            403: "Signup not complete",
            408: "The body took too long",
            413: "The body is too large",
            415: "The body isn't JSON",
            422: "The voice's provider refused the request",
            429: "Rate limit exceeded",
            500: "Speech synthesis failed",
            503: "The cloud voice is busy or unavailable; try again",
          }),
        },
      },
    },
  },
});
