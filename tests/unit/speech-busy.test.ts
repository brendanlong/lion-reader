import { describe, it, expect } from "vitest";
import { speakWhenFree } from "@/server/services/speech";
import {
  ProviderBusyError,
  providerError,
  retryAfterSeconds,
} from "@/server/services/provider-errors";

const signal = () => new AbortController().signal;

describe("speakWhenFree", () => {
  it("asks a busy provider again until it answers", async () => {
    let calls = 0;
    const result = await speakWhenFree(async () => {
      if (++calls < 3) throw new ProviderBusyError("busy", 0);
      return "speech";
    }, signal());
    expect(result).toBe("speech");
    expect(calls).toBe(3);
  });

  it("passes the busy error on once it has waited long enough", async () => {
    const busy = new ProviderBusyError("busy", 10);
    await expect(
      speakWhenFree(
        async () => {
          throw busy;
        },
        signal(),
        1_000
      )
    ).rejects.toBe(busy);
  });

  it("doesn't retry other failures, and stops when the client goes away", async () => {
    let calls = 0;
    await expect(
      speakWhenFree(async () => {
        calls++;
        throw new Error("refused");
      }, signal())
    ).rejects.toThrow("refused");
    expect(calls).toBe(1);

    const controller = new AbortController();
    let asked!: () => void;
    const busyOnce = new Promise<void>((resolve) => (asked = resolve));
    const waiting = speakWhenFree(async () => {
      asked();
      throw new ProviderBusyError("busy", 1);
    }, controller.signal);
    // While it waits to ask again.
    await busyOnce;
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("providerError", () => {
  it("is a busy error for 429, with how long to wait", async () => {
    const error = await providerError(
      "BreezeBlue",
      new Response(JSON.stringify({ detail: "Your plan's concurrent generation limit" }), {
        status: 429,
        headers: { "Retry-After": "3" },
      })
    );
    expect(error).toBeInstanceOf(ProviderBusyError);
    expect((error as ProviderBusyError).retryAfterSeconds).toBe(3);
    expect(error.message).toContain("concurrent generation limit");
  });

  it("reads OpenAI-style messages, and isn't busy for other statuses", async () => {
    const error = await providerError(
      "OpenRouter",
      new Response(JSON.stringify({ error: { message: "No credits" } }), { status: 402 })
    );
    expect(error).not.toBeInstanceOf(ProviderBusyError);
    expect(error.message).toBe("OpenRouter request failed with status 402: No credits");
  });
});

describe("retryAfterSeconds", () => {
  it("reads seconds or a date", () => {
    expect(retryAfterSeconds("5")).toBe(5);
    expect(retryAfterSeconds(new Date(10_000).toUTCString(), 4_000)).toBe(6);
    expect(retryAfterSeconds("soon")).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });
});
