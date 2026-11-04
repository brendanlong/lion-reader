/**
 * `MODEL_FAILOVER`: groups of `provider:model` refs that are the same model on
 * different hosts, each in the order to try them, separated by `;`, e.g.
 * `deepinfra:hexgrad/Kokoro-82M,together:hexgrad/Kokoro-82M;cerebras:gpt-oss-120b,openrouter:openai/gpt-oss-120b`.
 * A request for one that fails (busy, down, or its key refused) goes to the
 * others in its group, on the server's keys: a user's own key is used only
 * for one host, never another of theirs. Listing a model here allows it on
 * the server's key as a failover, even if `SERVER_KEY_MODELS` doesn't let
 * users pick it.
 */

import { normalizeModelRef, parseModelRef } from "@/lib/ai/model-ref";

function failoverGroups(): string[][] {
  return (process.env.MODEL_FAILOVER ?? "").split(";").map((group) =>
    group
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
      .map(normalizeModelRef)
  );
}

/** The hosts of `modelRef`'s model, in order: its group, or just it. */
export function failoverGroup(modelRef: string): string[] {
  const ref = normalizeModelRef(modelRef);
  return failoverGroups().find((models) => models.includes(ref)) ?? [ref];
}

/** Whether any of `provider`'s models has other hosts. */
export function hasFailover(provider: string): boolean {
  return failoverGroups().some(
    (models) =>
      models.length > 1 && models.some((model) => parseModelRef(model).provider === provider)
  );
}

/** The id a model with several hosts goes by: its group's first. */
export function canonicalModelRef(modelRef: string): string {
  return failoverGroup(modelRef)[0];
}

/** The hosts of `modelRef`'s model to fail over to, in order (not itself), or none. */
export function failoverModels(modelRef: string): string[] {
  const ref = normalizeModelRef(modelRef);
  return failoverGroup(ref).filter((model) => model !== ref);
}
