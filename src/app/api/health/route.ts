import { NextResponse } from "next/server";

/**
 * Health check endpoint for Fly.io and load balancers
 *
 * Returns 200 OK when the service is healthy.
 * This endpoint is used by Fly.io's health checks to determine
 * if the application is ready to receive traffic.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      status: "healthy",
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
