/**
 * OpenAPI Document Generator
 *
 * Generates OpenAPI 3.0 specification from tRPC router.
 * This enables REST API access alongside tRPC.
 */

import { generateOpenApiDocument } from "trpc-to-openapi";
import { appRouter } from "./root";

/**
 * OpenAPI document for the Lion Reader API.
 * This is generated from the tRPC router and can be used with
 * Swagger UI or other OpenAPI tools.
 */
export const openApiDocument = generateOpenApiDocument(appRouter, {
  title: "Lion Reader API",
  description: "REST API for Lion Reader - A modern feed reader",
  version: "1.0.0",
  baseUrl: "/api/v1",
  docsUrl: "https://github.com/brendanlong/lion-reader",
  tags: ["auth", "users", "subscriptions", "entries", "feeds"],
});
