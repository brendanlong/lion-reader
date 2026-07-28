/**
 * Unit tests for the OpenRouter HTTP client.
 *
 * OpenRouter reports upstream failures two different ways (a non-2xx status,
 * and a 200 carrying an `error` object), and swallowing the second one would
 * hand callers an empty summary instead of an error.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clearOpenRouterModelsCache,
  listOpenRouterModels,
  openRouterChatCompletion,
} from "@/server/services/openrouter";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearOpenRouterModelsCache();
});

describe("openRouterChatCompletion", () => {
  it("sends an authorized OpenAI-shaped request and returns the text", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: "a summary" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const text = await openRouterChatCompletion("sk-or-test", {
      model: "openai/gpt-oss-120b",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 100,
    });

    expect(text).toBe("a summary");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-or-test");
    expect(JSON.parse(init.body)).toMatchObject({ model: "openai/gpt-oss-120b", max_tokens: 100 });
  });

  it("returns an empty string when the model produced no text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: null } }] }))
    );
    await expect(
      openRouterChatCompletion("sk-or-test", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      })
    ).resolves.toBe("");
  });

  it("throws with the API's message on a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "No credits" } }, 402))
    );
    await expect(
      openRouterChatCompletion("sk-or-test", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      })
    ).rejects.toThrow(/402.*No credits/);
  });

  it("throws on an error carried in a 200 body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: { message: "Upstream timed out" } }))
    );
    await expect(
      openRouterChatCompletion("sk-or-test", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      })
    ).rejects.toThrow(/Upstream timed out/);
  });

  it("throws rather than returning empty when the body isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 }))
    );
    await expect(
      openRouterChatCompletion("sk-or-test", {
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 10,
      })
    ).rejects.toThrow(/502/);
  });
});

describe("listOpenRouterModels", () => {
  it("caches the catalog process-wide instead of refetching per call", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ id: "openai/gpt-oss-120b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([listOpenRouterModels(), listOpenRouterModels()]);
    const third = await listOpenRouterModels();

    expect(first).toEqual(second);
    expect(third[0].id).toBe("openai/gpt-oss-120b");
    // Concurrent callers share one in-flight request, and later ones hit cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves the stale cache when a later refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: "openai/gpt-oss-120b" }] }))
      .mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      await listOpenRouterModels();
      // Age past the TTL so the next call actually refetches; the refresh fails
      // but the previously cached catalog must still come back.
      vi.advanceTimersByTime(60 * 60 * 1000);
      await expect(listOpenRouterModels()).resolves.toEqual([{ id: "openai/gpt-oss-120b" }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the first fetch fails and there is nothing cached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(listOpenRouterModels()).rejects.toThrow("network down");
  });
});
