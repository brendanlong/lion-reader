/**
 * Errors from the AI providers' HTTP APIs, which share their error shapes:
 * a message in `detail` (DeepInfra, BreezeBlue) or `error.message`
 * (OpenRouter and other OpenAI-compatible APIs).
 */

/** The provider turned the request away for now (429): it can be tried again. */
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
 * one. A request made without a key (a public catalog) is never a rejection:
 * a 4xx there says nothing about the user's key, so it's trouble to wait out.
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
  if (status === 429) {
    return new ProviderBusyError(message, retryAfterSeconds(response.headers.get("retry-after")));
  }
  // A timeout (408) or a conflict (409) can pass on another try.
  if (keyed && status >= 400 && status < 500 && status !== 408 && status !== 409) {
    return new ProviderRejectedError(message, provider, detail);
  }
  return new Error(message);
}
