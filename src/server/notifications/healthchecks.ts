/**
 * Healthchecks.io (dead-man's-switch) pinging.
 *
 * We ping check URLs to signal liveness and health. The external monitor
 * (healthchecks.io or any compatible service) emails when:
 * - an explicit `/fail` ping arrives, or
 * - an expected ping does NOT arrive within the check's grace period — which
 *   covers a process that died or a machine that vanished, failure modes the
 *   process can't report on itself.
 *
 * Ping bodies are included in healthchecks.io notification emails, so callers
 * POST a short human-readable summary explaining *why* a check is failing.
 *
 * To set up: create a check at https://healthchecks.io, copy its ping URL, and
 * set the relevant env var (e.g. FEED_HEALTH_HEARTBEAT_URL,
 * DISCORD_BOT_HEARTBEAT_URL). Pinging is a no-op when the URL is unset.
 */

import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";

/**
 * Healthchecks.io ping signals, expressed as URL suffixes:
 * - `success`: the base URL (check is healthy / alive)
 * - `fail`: `{url}/fail` (explicit failure — triggers a "down" notification)
 * - `start`: `{url}/start` (job started, for measuring duration)
 * - `log`: `{url}/log` (record info without changing the check's status)
 */
export type HealthcheckSignal = "success" | "fail" | "start" | "log";

const PING_TIMEOUT_MS = 10_000;

/**
 * healthchecks.io stores up to 100KB of ping body, but notification emails only
 * need a short summary — cap so emails stay readable.
 */
const MAX_BODY_LENGTH = 10_000;

/**
 * Builds the ping URL for a signal. Uses the URL API so any query string or
 * fragment on the base URL is preserved (e.g. healthchecks.io `?rid=...` run
 * IDs); falls back to string concatenation if the value isn't a parseable URL.
 */
export function buildPingUrl(baseUrl: string, signal: HealthcheckSignal): string {
  if (signal === "success") {
    return baseUrl;
  }
  try {
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${signal}`;
    return url.toString();
  } catch {
    return `${baseUrl.replace(/\/$/, "")}/${signal}`;
  }
}

/**
 * Pings a healthchecks.io check URL. Never throws — delivery failures only log
 * a warning, so monitoring problems never affect the work being monitored.
 *
 * @param baseUrl - The check's base ping URL
 * @param options.signal - Which ping to send (default: "success")
 * @param options.body - Optional text body, included in notification emails
 */
export async function pingHealthcheck(
  baseUrl: string,
  options: { signal?: HealthcheckSignal; body?: string } = {}
): Promise<void> {
  const { signal = "success", body } = options;
  const url = buildPingUrl(baseUrl, signal);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "User-Agent": USER_AGENT },
      body: body ? body.slice(0, MAX_BODY_LENGTH) : undefined,
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("Healthcheck ping failed", { status: response.status, url });
    }
  } catch (error) {
    logger.warn("Healthcheck ping error", {
      error: error instanceof Error ? error.message : "Unknown error",
      url,
    });
  }
}

/** What a heartbeat resolver decides to send on a given tick. */
export interface HeartbeatStatus {
  /** Ping signal (default "success"). Use "fail" to flag the process unhealthy. */
  signal?: HealthcheckSignal;
  /** Optional body, included in notification emails. */
  body?: string;
}

/**
 * Starts a periodic liveness heartbeat to a healthchecks.io check: pings once
 * immediately, then every `intervalMs`. Use for long-running processes that
 * have no other recurring external signal — the monitor alerts when pings stop,
 * catching a dead or crash-looping process.
 *
 * `resolve` is called per tick to decide what to send, so a process can report
 * itself unhealthy (e.g. a wedged loop) with a `/fail` ping instead of going
 * silent. Defaults to a plain success ping.
 *
 * The interval is `unref`'d so it never keeps the process alive on its own.
 * Returns a function that stops the heartbeat.
 */
export function startHeartbeat(
  baseUrl: string,
  intervalMs: number,
  resolve: () => HeartbeatStatus = () => ({})
): () => void {
  const ping = () => {
    let status: HeartbeatStatus;
    try {
      status = resolve();
    } catch (error) {
      // A throwing resolver must never break the heartbeat loop; fall back to a
      // plain success ping so liveness is still reported.
      logger.warn("Heartbeat resolver threw; sending plain success ping", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      status = {};
    }
    void pingHealthcheck(baseUrl, { signal: status.signal, body: status.body });
  };
  ping();
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
