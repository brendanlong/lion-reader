import { describe, it, expect } from "vitest";
import {
  narrationFailureScope,
  narrationFromLlmOutput,
  type NarrationFailure,
} from "@/server/services/narration";
import { TextGenerationError, UnreadableApiKeyError } from "@/server/services/ai-providers";

const input = [
  { id: 0, o: 0, text: "Title" },
  { id: 1, o: 1, text: "Dr. Smith said hello." },
  { id: 2, o: 3, text: "..." },
];

const answer = (paragraphs: unknown): string => JSON.stringify({ paragraphs });

describe("narrationFromLlmOutput", () => {
  it("narrates each paragraph with the model's rewrite, mapped to its element", () => {
    const result = narrationFromLlmOutput(
      input,
      answer([
        { id: 0, text: "Title." },
        { id: 1, text: "Doctor Smith said hello." },
        { id: 2, text: "Three dots." },
      ])
    );
    expect(result).toEqual({
      text: "Title.\n\nDoctor Smith said hello.\n\nThree dots.",
      source: "llm",
      paragraphMap: [
        { n: 0, o: 0 },
        { n: 1, o: 1 },
        { n: 2, o: 3 },
      ],
    });
  });

  it("drops a paragraph the model rewrote as empty", () => {
    const result = narrationFromLlmOutput(
      input,
      answer([
        { id: 0, text: "Title." },
        { id: 1, text: "Hello." },
        { id: 2, text: "" },
      ])
    );
    expect(result?.text).toBe("Title.\n\nHello.");
    expect(result?.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
    ]);
  });

  it("keeps the input's text for ids the model left out or garbled", () => {
    const result = narrationFromLlmOutput(
      input,
      answer([
        { id: "1", text: "Hello." },
        { id: "not a number", text: "Lost." },
        { id: 2, text: null },
      ])
    );
    // An id sent as a string still matches; a null text is a drop.
    expect(result?.text).toBe("Title\n\nHello.");
  });

  it("splits a rewrite with blank lines into paragraphs of the same element", () => {
    const result = narrationFromLlmOutput(input.slice(0, 1), answer([{ id: 0, text: "A.\n\nB." }]));
    expect(result?.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 0 },
    ]);
  });

  it.each([
    ["empty", ""],
    ["not JSON", "Sure! Here's the narration:"],
    ["without paragraphs", JSON.stringify({ text: "hello" })],
    ["with paragraphs of the wrong shape", answer([{ id: 0 }])],
  ])("is null for output %s", (_, raw) => {
    expect(narrationFromLlmOutput(input, raw)).toBeNull();
  });
});

describe("narrationFailureScope", () => {
  const callFailure = (failure: "busy" | "rejected" | "failed", usedUserKey: boolean) => ({
    kind: "error" as const,
    error: new TextGenerationError("groq", failure, usedUserKey, new Error("x")),
  });

  it.each<[string, NarrationFailure, ReturnType<typeof narrationFailureScope>]>([
    [
      "unusable output from a default model on the server's key",
      { kind: "unusable_output", onCallerTerms: false },
      "content",
    ],
    [
      "unusable output from a model the user picked, or on their own key",
      { kind: "unusable_output", onCallerTerms: true },
      "caller",
    ],
    ["a refusal on the user's own key", callFailure("rejected", true), "caller"],
    ["a refusal on the server's key", callFailure("rejected", false), "transient"],
    ["a busy provider, on the user's key", callFailure("busy", true), "transient"],
    ["a busy provider, on the server's key", callFailure("busy", false), "transient"],
    ["a provider error", callFailure("failed", false), "transient"],
    ["an unreadable key", { kind: "error", error: new UnreadableApiKeyError("groq") }, "caller"],
    [
      "a model these keys can't use",
      { kind: "error", error: new Error("not configured") },
      "caller",
    ],
  ])("%s", (_, failure, expected) => {
    expect(narrationFailureScope(failure)).toBe(expected);
  });
});
