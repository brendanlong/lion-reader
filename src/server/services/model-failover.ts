/**
 * `MODEL_FAILOVER`: groups of `provider:model` refs that are the same model on
 * different hosts, each in the order to try them, separated by `;`, e.g.
 * `deepinfra:hexgrad/Kokoro-82M,together:hexgrad/Kokoro-82M;cerebras:gpt-oss-120b,openrouter:openai/gpt-oss-120b`.
 * A request for one that's busy or failing goes to the others in its group.
 * Listing a model here allows it on the server's key as a failover, even if
 * `SERVER_KEY_MODELS` doesn't let users pick it.
 */

import { normalizeModelRef } from "@/lib/ai/model-ref";

function failoverGroups(): string[][] {
  return (process.env.MODEL_FAILOVER ?? "").split(";").map((group) =>
    group
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean)
      .map(normalizeModelRef)
  );
}

/** The hosts of `modelRef`'s model to fail over to, in order (not itself), or none. */
export function failoverModels(modelRef: string): string[] {
  const ref = normalizeModelRef(modelRef);
  const group = failoverGroups().find((models) => models.includes(ref)) ?? [];
  return group.filter((model) => model !== ref);
}

/** Whether `modelRef` is in any failover group. */
export function isFailoverModel(modelRef: string): boolean {
  const ref = normalizeModelRef(modelRef);
  return failoverGroups().some((models) => models.includes(ref));
}
