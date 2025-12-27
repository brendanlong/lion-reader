import { metricsEnabled, registry } from "@/server/metrics";

/**
 * Prometheus Metrics Endpoint
 *
 * Returns metrics in Prometheus text format for scraping.
 *
 * Behavior:
 * - Returns 404 when METRICS_ENABLED is not "true"
 * - Requires basic auth if METRICS_USERNAME and METRICS_PASSWORD are set
 * - Returns metrics in Prometheus text format
 *
 * Environment Variables:
 * - METRICS_ENABLED: Set to "true" to enable metrics
 * - METRICS_USERNAME: Optional username for basic auth
 * - METRICS_PASSWORD: Optional password for basic auth
 */

/**
 * Validates basic auth credentials from the Authorization header.
 *
 * @param authHeader - The Authorization header value
 * @returns true if credentials are valid, false otherwise
 */
function validateBasicAuth(authHeader: string | null): boolean {
  const username = process.env.METRICS_USERNAME;
  const password = process.env.METRICS_PASSWORD;

  // No auth required if credentials not configured
  if (!username || !password) {
    return true;
  }

  if (!authHeader) {
    return false;
  }

  // Check that it's Basic auth
  if (!authHeader.startsWith("Basic ")) {
    return false;
  }

  try {
    // Decode base64 credentials
    const base64Credentials = authHeader.slice(6);
    const credentials = Buffer.from(base64Credentials, "base64").toString("utf-8");
    const [providedUsername, providedPassword] = credentials.split(":");

    // Validate credentials
    return providedUsername === username && providedPassword === password;
  } catch {
    return false;
  }
}

export async function GET(request: Request): Promise<Response> {
  // Return 404 when metrics are disabled
  if (!metricsEnabled) {
    return new Response("Not Found", { status: 404 });
  }

  // Check basic auth if configured
  const authHeader = request.headers.get("authorization");
  if (!validateBasicAuth(authHeader)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Metrics"',
      },
    });
  }

  // Return metrics in Prometheus text format
  const metrics = await registry.metrics();
  return new Response(metrics, {
    headers: {
      "Content-Type": registry.contentType,
    },
  });
}
