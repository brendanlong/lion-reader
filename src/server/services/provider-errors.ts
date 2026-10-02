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

/** `Retry-After`, in seconds: a number of them, or a date. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, (date - now) / 1000);
}

/** The error for `provider`'s failed `response`, with its message if it gave one. */
export async function providerError(provider: string, response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown; error?: { message?: unknown } };
    const message = typeof body.detail === "string" ? body.detail : body.error?.message;
    if (typeof message === "string") detail = `: ${message.slice(0, 500)}`;
  } catch {
    // Non-JSON error body; the status is enough.
  }
  const message = `${provider} request failed with status ${response.status}${detail}`;
  return response.status === 429
    ? new ProviderBusyError(message, retryAfterSeconds(response.headers.get("retry-after")))
    : new Error(message);
}
