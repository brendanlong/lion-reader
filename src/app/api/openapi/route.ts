/**
 * OpenAPI Specification Endpoint
 *
 * Returns the OpenAPI 3.0 specification for the Lion Reader API.
 * Can be used with Swagger UI, Postman, or other API tools.
 */

import { NextResponse } from "next/server";
import { openApiDocument } from "@/server/trpc/openapi";

export async function GET() {
  return NextResponse.json(openApiDocument);
}
