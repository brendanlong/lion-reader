/**
 * Which models may run on the server's provider keys (`<PROVIDER>_API_KEY`).
 * Every model is allowed unless one of these is set; a user's own key always
 * unlocks every model its provider offers.
 *
 * - `SERVER_KEY_MODELS`: comma-separated `provider:model` refs, where
 *   `provider:*` allows all of a provider's models.
 * - `SERVER_KEY_MAX_INPUT_PRICE` / `SERVER_KEY_MAX_OUTPUT_PRICE`: also allow
 *   text models whose price per million input/output tokens (USD) is at most
 *   this.
 * - `SERVER_KEY_MAX_SPEECH_PRICE`: also allow speech models whose price per
 *   million characters (USD) is at most this.
 *
 * Only OpenRouter (text and speech) and DeepInfra (speech) report prices, so
 * other providers' models have to be listed. OpenRouter's price is its
 * cheapest host's; we route for throughput, which can cost more.
 */

import { normalizeModelRef, parseModelRef } from "@/lib/ai/model-ref";

/** What a model costs, as far as its provider reports. */
export interface ModelPrice {
  /** USD per million tokens. */
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** USD per million input characters, for speech models. */
  pricePerMillionCharacters?: number;
}

interface ServerKeyModelPolicy {
  models: string[];
  maxInputPrice?: number;
  maxOutputPrice?: number;
  maxSpeechPrice?: number;
}

/** A price cap; an unparseable one allows nothing, since NaN compares false. */
function priceCap(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  return raw ? Number(raw) : undefined;
}

function serverKeyModelPolicy(): ServerKeyModelPolicy | null {
  const models = (process.env.SERVER_KEY_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
    .map(normalizeModelRef);
  const maxInputPrice = priceCap("SERVER_KEY_MAX_INPUT_PRICE");
  const maxOutputPrice = priceCap("SERVER_KEY_MAX_OUTPUT_PRICE");
  const maxSpeechPrice = priceCap("SERVER_KEY_MAX_SPEECH_PRICE");
  if (
    models.length === 0 &&
    maxInputPrice === undefined &&
    maxOutputPrice === undefined &&
    maxSpeechPrice === undefined
  ) {
    return null;
  }
  return { models, maxInputPrice, maxOutputPrice, maxSpeechPrice };
}

/** Whether a model's price can decide if it's allowed (so is worth looking up). */
export function hasServerKeyPriceCaps(): boolean {
  const policy = serverKeyModelPolicy();
  return (
    policy !== null &&
    (policy.maxInputPrice !== undefined ||
      policy.maxOutputPrice !== undefined ||
      policy.maxSpeechPrice !== undefined)
  );
}

function withinPriceCaps(policy: ServerKeyModelPolicy, price: ModelPrice): boolean {
  if (price.pricePerMillionCharacters !== undefined) {
    return (
      policy.maxSpeechPrice !== undefined &&
      price.pricePerMillionCharacters <= policy.maxSpeechPrice
    );
  }
  if (policy.maxInputPrice === undefined && policy.maxOutputPrice === undefined) return false;
  const within = (value: number | undefined, cap: number | undefined) =>
    cap === undefined || (value !== undefined && value <= cap);
  return (
    within(price.inputPricePerMillion, policy.maxInputPrice) &&
    within(price.outputPricePerMillion, policy.maxOutputPrice)
  );
}

/**
 * Whether the model may run on the server's key. Without a price, only a
 * model listed in `SERVER_KEY_MODELS` (or any model, when unrestricted) is.
 */
export function isAllowedOnServerKey(modelRef: string, price: ModelPrice = {}): boolean {
  const policy = serverKeyModelPolicy();
  if (!policy) return true;
  const ref = normalizeModelRef(modelRef);
  const wildcard = `${parseModelRef(ref).provider}:*`;
  if (policy.models.some((model) => model === ref || model === wildcard)) return true;
  return withinPriceCaps(policy, price);
}
