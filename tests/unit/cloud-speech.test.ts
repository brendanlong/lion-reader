import { describe, it, expect } from "vitest";
import { fetchWhenFree } from "@/lib/narration/cloud-speech";

function answers(...statuses: Array<[number, string?]>) {
  const queue = [...statuses];
  return () => {
    const [status, retryAfter] = queue.shift() ?? [200];
    return Promise.resolve(
      new Response(status === 200 ? "audio" : "{}", {
        status,
        headers: retryAfter ? { "Retry-After": retryAfter } : {},
      })
    );
  };
}

describe("fetchWhenFree", () => {
  it("waits out a busy voice, as long as it asks", async () => {
    const waits: number[] = [];
    const response = await fetchWhenFree(
      answers([503, "2"], [429], [200]),
      new AbortController().signal,
      async (ms) => {
        waits.push(ms);
      }
    );
    expect(response.status).toBe(200);
    expect(waits).toEqual([2000, 2000]);
  });

  it("gives up after a few tries, and doesn't retry other failures", async () => {
    const waits: number[] = [];
    const record = async (ms: number) => {
      waits.push(ms);
    };
    const busy = await fetchWhenFree(
      answers([503], [503], [503], [503], [503], [200]),
      new AbortController().signal,
      record
    );
    expect(busy.status).toBe(503);
    expect(waits).toHaveLength(4);

    const broken = await fetchWhenFree(answers([500]), new AbortController().signal, record);
    expect(broken.status).toBe(500);
    expect(waits).toHaveLength(4);
  });
});
