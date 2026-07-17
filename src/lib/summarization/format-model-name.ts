/**
 * Formats a model reference into a human-readable name for display.
 *
 * Accepts provider-qualified refs ("cerebras:gpt-oss-120b") as well as bare
 * model IDs ("claude-sonnet-4-6", legacy stored values). Only the model is
 * displayed — the provider prefix and any org prefix ("openai/") are
 * dropped. Formatting:
 *
 * - Strips the "claude-" prefix and renders it as a leading "Claude"
 * - Drops a trailing 8-digit date suffix (e.g. "-20240620")
 * - Title-cases word segments ("sonnet" -> "Sonnet")
 * - Joins consecutive numeric segments with dots ("4-6" -> "4.6")
 * - Uppercases known acronyms ("gpt" -> "GPT") and size/parameter suffixes
 *   ("120b" -> "120B")
 *
 * Examples:
 *   "claude-sonnet-4-6"          -> "Claude Sonnet 4.6"
 *   "claude-3-5-sonnet-20240620" -> "Claude 3.5 Sonnet"
 *   "cerebras:gpt-oss-120b"      -> "GPT-OSS 120B"
 *   "groq:openai/gpt-oss-20b"    -> "GPT-OSS 20B"
 *   "groq:llama-3.3-70b-versatile" -> "Llama 3.3 70B Versatile"
 *
 * Unknown IDs fall back to title-casing their segments so the output is
 * never worse than the raw ID.
 */

import { parseModelRef } from "@/lib/ai/model-ref";

/** Segments rendered fully uppercase. */
const ACRONYMS = new Set(["gpt", "oss", "ai", "moe"]);

export function formatModelName(modelId: string): string {
  if (!modelId) {
    return modelId;
  }

  // Only display the model — drop the provider prefix ("cerebras:") and any
  // org prefix in the provider-native ID ("openai/gpt-oss-20b").
  const { model } = parseModelRef(modelId);
  const withoutOrg = model.slice(model.lastIndexOf("/") + 1);

  // Drop a trailing 8-digit date suffix (e.g. "claude-sonnet-4-5-20250929").
  const withoutDate = withoutOrg.replace(/-\d{8}$/, "");

  const hasClaudePrefix = withoutDate.startsWith("claude-");
  const rest = hasClaudePrefix ? withoutDate.slice("claude-".length) : withoutDate;

  const segments = rest.split("-").filter((segment) => segment.length > 0);

  // Group consecutive numeric segments so they can be joined with dots, while
  // word segments stay space-separated.
  const groups: string[] = [];
  let numericRun: string[] = [];

  const flushNumericRun = () => {
    if (numericRun.length > 0) {
      groups.push(numericRun.join("."));
      numericRun = [];
    }
  };

  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      numericRun.push(segment);
    } else {
      flushNumericRun();
      if (ACRONYMS.has(segment.toLowerCase())) {
        groups.push(segment.toUpperCase());
      } else if (/^\d+(?:\.\d+)?[bmk]$/i.test(segment)) {
        // Parameter-count suffixes: "120b" -> "120B", "1.5b" -> "1.5B"
        groups.push(segment.toUpperCase());
      } else {
        groups.push(segment.charAt(0).toUpperCase() + segment.slice(1));
      }
    }
  }
  flushNumericRun();

  // "GPT OSS" is branded with a hyphen.
  const formatted = groups.join(" ").replace(/\bGPT OSS\b/, "GPT-OSS");

  if (hasClaudePrefix) {
    return formatted ? `Claude ${formatted}` : "Claude";
  }

  return formatted;
}
