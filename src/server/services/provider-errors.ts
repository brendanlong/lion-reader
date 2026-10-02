/**
 * Errors from the AI providers' HTTP APIs, which share their error shapes:
 * a message in `detail` (DeepInfra, BreezeBlue) or `error.message`
 * (OpenRouter and other OpenAI-compatible APIs).
 */

/**
 * How a provider call failed, as far as the caller should care:
 * - `busy`: rate limited, overloaded, or unreachable — worth trying again shortly.
 * - `rejected`: the provider refused the request (bad key, no credit, a model
 *   or request it won't serve) — retrying unchanged won't help.
 * - `failed`: anything else.
 */
export type ProviderFailure = "busy" | "rejected" | "failed";

/**
 * HTTP statuses meaning "not right now": a timeout, rate limiting, an
 * unavailable upstream, Groq's 498 (flex tier out of capacity), and
 * Anthropic's 529 (overloaded).
 */
const BUSY_STATUSES: ReadonlySet<number> = new Set([408, 429, 498, 502, 503, 504, 529]);

/**
 * What a provider answering `status` means. A request made without a key (a
 * public catalog) is never a rejection: a 4xx there says nothing about the
 * user's key, so it's trouble to wait out.
 */
export function classifyProviderStatus(
  status: number,
  { keyed = true }: { keyed?: boolean } = {}
): ProviderFailure {
  if (BUSY_STATUSES.has(status)) return "busy";
  // A conflict can pass on another try.
  if (keyed && status >= 400 && status < 500 && status !== 409) return "rejected";
  return "failed";
}

/**
 * A plain-fetch request that got no answer: a network failure is a TypeError,
 * a timeout a TimeoutError DOMException.
 */
export function isFetchConnectionError(error: unknown): boolean {
  return (
    (error instanceof TypeError && error.message === "fetch failed") ||
    (error instanceof DOMException && error.name === "TimeoutError")
  );
}

/** What a failed plain-fetch provider call (see {@link providerError}) means. */
export function classifyProviderError(error: unknown): ProviderFailure {
  if (error instanceof ProviderBusyError || isFetchConnectionError(error)) return "busy";
  if (error instanceof ProviderRejectedError) return "rejected";
  return "failed";
}

/** The provider turned the request away for now: it can be tried again. */
export class ProviderBusyError extends Error {
  constructor(
    message: string,
    /** How long the provider asked us to wait, if it said. */
    readonly retryAfterSeconds: number | null
  ) {
    super(message);
  }
}

/**
 * The provider refused the request itself (a bad key, no credit left, a voice
 * or input it won't take): asking again won't help.
 */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    /** The provider's name, for showing. */
    readonly provider: string,
    /** What the provider said, if anything. */
    readonly detail: string | null
  ) {
    super(message);
  }
}

/** `Retry-After`, in seconds: a number of them, or a date. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, (date - now) / 1000);
}

/**
 * The error for `provider`'s failed `response`, with its message if it gave
 * one: busy, rejected or neither, by {@link classifyProviderStatus}.
 */
export async function providerError(
  provider: string,
  response: Response,
  { keyed = true }: { keyed?: boolean } = {}
): Promise<Error> {
  let detail: string | null = null;
  try {
    const body = (await response.json()) as { detail?: unknown; error?: { message?: unknown } };
    const message = typeof body.detail === "string" ? body.detail : body.error?.message;
    if (typeof message === "string") detail = message.slice(0, 500);
  } catch {
    // Non-JSON error body; the status is enough.
  }
  const { status } = response;
  const message = `${provider} request failed with status ${status}${detail ? `: ${detail}` : ""}`;
  switch (classifyProviderStatus(status, { keyed })) {
    case "busy":
      return new ProviderBusyError(message, retryAfterSeconds(response.headers.get("retry-after")));
    case "rejected":
      return new ProviderRejectedError(message, provider, detail);
    case "failed":
      return new Error(message);
  }
}
