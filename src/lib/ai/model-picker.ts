/**
 * Search, grouping, and labels for the settings model picker.
 */

import { AI_PROVIDER_DISPLAY_NAMES, AI_PROVIDERS, type AiProvider } from "@/lib/ai/model-ref";

export interface PickerModel {
  id: string;
  displayName: string;
  provider: AiProvider;
  contextLength?: number;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** Speech models are priced per input character instead of per token. */
  pricePerMillionCharacters?: number;
}

export interface PickerSection {
  label: string;
  models: PickerModel[];
}

/** Every whitespace-separated term must appear in the name, ID, or provider. */
export function matchesModelQuery(model: PickerModel, query: string): boolean {
  const haystack =
    `${model.displayName} ${model.id} ${AI_PROVIDER_DISPLAY_NAMES[model.provider]}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

/**
 * Groups models for display. Without a query, the default and suggested models
 * (those that are available) lead in their own section and the rest follow by
 * provider; with a query, matches are grouped by provider only.
 */
export function buildModelPickerSections(
  models: PickerModel[],
  options: { query: string; suggestedModelIds: string[]; defaultModelId: string }
): PickerSection[] {
  const query = options.query.trim();
  const byProvider = (candidates: PickerModel[]): PickerSection[] =>
    AI_PROVIDERS.map((provider) => ({
      label: AI_PROVIDER_DISPLAY_NAMES[provider],
      models: candidates.filter((model) => model.provider === provider),
    })).filter((section) => section.models.length > 0);

  if (query) {
    return byProvider(models.filter((model) => matchesModelQuery(model, query)));
  }

  const byId = new Map(models.map((model) => [model.id, model]));
  const suggestedIds = [...new Set([options.defaultModelId, ...options.suggestedModelIds])];
  const suggested = suggestedIds.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
  const suggestedSet = new Set(suggested.map((model) => model.id));
  const rest = models.filter((model) => !suggestedSet.has(model.id));

  return [
    ...(suggested.length > 0 ? [{ label: "Suggested", models: suggested }] : []),
    ...byProvider(rest),
  ];
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

function formatPrice(usd: number): string {
  if (usd === 0) return "free";
  return `$${usd < 0.1 ? Number(usd.toPrecision(2)) : usd.toFixed(2)}`;
}

/** e.g. "OpenRouter · 131K context · $0.15 in / $0.60 out per 1M tokens". */
export function formatModelDetails(model: PickerModel): string {
  const parts: string[] = [AI_PROVIDER_DISPLAY_NAMES[model.provider]];
  if (model.contextLength !== undefined) {
    parts.push(`${formatTokenCount(model.contextLength)} context`);
  }
  if (model.inputPricePerMillion !== undefined && model.outputPricePerMillion !== undefined) {
    parts.push(
      model.inputPricePerMillion === 0 && model.outputPricePerMillion === 0
        ? "free"
        : `${formatPrice(model.inputPricePerMillion)} in / ${formatPrice(model.outputPricePerMillion)} out per 1M tokens`
    );
  }
  if (model.pricePerMillionCharacters !== undefined) {
    parts.push(
      model.pricePerMillionCharacters === 0
        ? "free"
        : `${formatPrice(model.pricePerMillionCharacters)} per 1M characters`
    );
  }
  return parts.join(" · ");
}
