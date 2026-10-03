import { describe, it, expect } from "vitest";
import { speakWhenFree } from "@/server/services/speech";
import {
  classifyProviderError,
  classifyProviderStatus,
  ProviderBusyError,
  providerError,
  ProviderRejectedError,
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

  it("asks again when the provider couldn't be reached", async () => {
    let calls = 0;
    const result = await speakWhenFree(async () => {
      if (++calls < 2) throw new TypeError("fetch failed");
      return "speech";
    }, signal());
    expect(result).toBe("speech");
    expect(calls).toBe(2);
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

  it("gives up on a provider that stays unreachable within the same budget", async () => {
    let calls = 0;
    const unreachable = new TypeError("fetch failed");
    await expect(
      speakWhenFree(
        async () => {
          calls++;
          throw unreachable;
        },
        signal(),
        1_000
      )
    ).rejects.toBe(unreachable);
    expect(calls).toBeLessThanOrEqual(3);
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

  it("reads OpenAI-style messages, and is a rejection for the provider's refusals", async () => {
    const error = await providerError(
      "OpenRouter",
      new Response(JSON.stringify({ error: { message: "No credits" } }), { status: 402 })
    );
    expect(error).not.toBeInstanceOf(ProviderBusyError);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(error).toMatchObject({ provider: "OpenRouter", detail: "No credits" });
    expect(error.message).toBe("OpenRouter request failed with status 402: No credits");
  });

  it("isn't a rejection for a request made without a key", async () => {
    const error = await providerError("DeepInfra", new Response("{}", { status: 403 }), {
      keyed: false,
    });
    expect(error).not.toBeInstanceOf(ProviderRejectedError);
  });

  it("is a busy error for a timeout, an overloaded or unavailable provider", async () => {
    for (const status of [408, 498, 502, 503, 504, 529]) {
      const error = await providerError("DeepInfra", new Response("oops", { status }));
      expect(error).toBeInstanceOf(ProviderBusyError);
      expect((error as ProviderBusyError).retryAfterSeconds).toBeNull();
    }
  });

  it("is a plain error for other trouble", async () => {
    for (const status of [409, 500]) {
      const error = await providerError("DeepInfra", new Response("oops", { status }));
      expect(error).not.toBeInstanceOf(ProviderRejectedError);
      expect(error).not.toBeInstanceOf(ProviderBusyError);
      expect(error.message).toBe(`DeepInfra request failed with status ${status}`);
    }
  });
});

describe("classifyProviderStatus", () => {
  it.each([
    [408, "busy"],
    [429, "busy"],
    [498, "busy"],
    [502, "busy"],
    [503, "busy"],
    [504, "busy"],
    [529, "busy"],
    [400, "rejected"],
    [401, "rejected"],
    [402, "rejected"],
    [403, "rejected"],
    [409, "failed"],
    [500, "failed"],
  ] as const)("%i is %s", (status, expected) => {
    expect(classifyProviderStatus(status)).toBe(expected);
  });

  it("never calls a keyless request's answer a rejection", () => {
    expect(classifyProviderStatus(403, { keyed: false })).toBe("failed");
    expect(classifyProviderStatus(429, { keyed: false })).toBe("busy");
  });
});

describe("classifyProviderError", () => {
  it("treats a busy answer and an unreachable provider as busy", () => {
    expect(classifyProviderError(new ProviderBusyError("busy", null))).toBe("busy");
    expect(classifyProviderError(new TypeError("fetch failed"))).toBe("busy");
    expect(classifyProviderError(new DOMException("timed out", "TimeoutError"))).toBe("busy");
  });

  it("passes on rejections, and calls anything else a failure", () => {
    expect(classifyProviderError(new ProviderRejectedError("402", "DeepInfra", null))).toBe(
      "rejected"
    );
    expect(classifyProviderError(new DOMException("gone", "AbortError"))).toBe("failed");
    expect(classifyProviderError(new Error("oops"))).toBe("failed");
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
