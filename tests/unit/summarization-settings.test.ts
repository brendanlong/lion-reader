import { describe, it, expect, afterEach } from "vitest";
import {
  getMaxWords,
  hashPrompt,
  DEFAULT_SUMMARIZATION_PROMPT,
} from "@/server/services/summarization";
import { DEFAULT_SUMMARIZATION_MAX_WORDS } from "@/lib/summarization/constants";

describe("getMaxWords", () => {
  const originalEnv = process.env.SUMMARIZATION_MAX_WORDS;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SUMMARIZATION_MAX_WORDS;
    } else {
      process.env.SUMMARIZATION_MAX_WORDS = originalEnv;
    }
  });

  it("prefers the user setting when set", () => {
    process.env.SUMMARIZATION_MAX_WORDS = "50";
    expect(getMaxWords(200)).toBe(200);
  });

  it("falls back to the env var when the user setting is unset", () => {
    process.env.SUMMARIZATION_MAX_WORDS = "75";
    expect(getMaxWords(null)).toBe(75);
    expect(getMaxWords(undefined)).toBe(75);
  });

  it("falls back to the default when nothing is set", () => {
    delete process.env.SUMMARIZATION_MAX_WORDS;
    expect(getMaxWords(null)).toBe(DEFAULT_SUMMARIZATION_MAX_WORDS);
  });

  it("ignores non-positive user values", () => {
    delete process.env.SUMMARIZATION_MAX_WORDS;
    expect(getMaxWords(0)).toBe(DEFAULT_SUMMARIZATION_MAX_WORDS);
    expect(getMaxWords(-10)).toBe(DEFAULT_SUMMARIZATION_MAX_WORDS);
  });
});

describe("hashPrompt", () => {
  it("is stable for the same prompt", () => {
    expect(hashPrompt("hello {{content}}")).toBe(hashPrompt("hello {{content}}"));
  });

  it("differs for different custom prompts", () => {
    expect(hashPrompt("prompt A")).not.toBe(hashPrompt("prompt B"));
  });

  it("treats no custom prompt as the default prompt", () => {
    expect(hashPrompt(null)).toBe(hashPrompt(DEFAULT_SUMMARIZATION_PROMPT));
    expect(hashPrompt(undefined)).toBe(hashPrompt(DEFAULT_SUMMARIZATION_PROMPT));
    expect(hashPrompt("")).toBe(hashPrompt(DEFAULT_SUMMARIZATION_PROMPT));
  });

  it("distinguishes a custom prompt from the default", () => {
    expect(hashPrompt("a custom prompt")).not.toBe(hashPrompt(null));
  });
});
