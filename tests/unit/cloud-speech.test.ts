import { afterEach, describe, it, expect, vi } from "vitest";
import { BUSY_ATTEMPTS, BUSY_FIRST_WAIT_MS, fetchWhenFree } from "@/lib/narration/cloud-speech";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits out a busy voice, as long as it asks", async () => {
    // Jitter's midpoint: the wait unspread.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const waits: number[] = [];
    const response = await fetchWhenFree(
      answers([503, "2"], [429], [200]),
      new AbortController().signal,
      async (ms) => {
        waits.push(ms);
      }
    );
    expect(response.status).toBe(200);
    // The asked-for 2 s, then the backoff, which has doubled once already.
    expect(waits).toEqual([2000, 2 * BUSY_FIRST_WAIT_MS]);
  });

  it("spreads out the waits of listeners turned away together", async () => {
    const waits: number[] = [];
    for (const random of [0, 0.99]) {
      vi.spyOn(Math, "random").mockReturnValue(random);
      await fetchWhenFree(answers([503, "2"], [200]), new AbortController().signal, async (ms) => {
        waits.push(ms);
      });
    }
    expect(waits[0]).toBeLessThan(2000);
    expect(waits[1]).toBeGreaterThan(2000);
  });

  it("gives up after a few tries, and doesn't retry other failures", async () => {
    const waits: number[] = [];
    const record = async (ms: number) => {
      waits.push(ms);
    };
    const busy = await fetchWhenFree(
      answers(...Array.from({ length: BUSY_ATTEMPTS }, (): [number] => [503]), [200]),
      new AbortController().signal,
      record
    );
    expect(busy.status).toBe(503);
    expect(waits).toHaveLength(BUSY_ATTEMPTS - 1);

    const broken = await fetchWhenFree(answers([500]), new AbortController().signal, record);
    expect(broken.status).toBe(500);
    expect(waits).toHaveLength(BUSY_ATTEMPTS - 1);
  });
});
