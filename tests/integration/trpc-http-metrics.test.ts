/**
 * A streamed tRPC batch is answered before its procedures finish, so the
 * HTTP request metric must wait for the body to end.
 *
 * `metricsEnabled` is read from the environment at module load, so we set
 * METRICS_ENABLED before dynamically importing the modules. Integration only
 * because `http.ts` imports the database client.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

let metrics: typeof import("@/server/metrics/metrics");
let http: typeof import("@/server/trpc/http");

const metricsEnabled = process.env.METRICS_ENABLED;

beforeAll(async () => {
  process.env.METRICS_ENABLED = "true";
  metrics = await import("@/server/metrics/metrics");
  http = await import("@/server/trpc/http");
});

afterAll(() => {
  if (metricsEnabled === undefined) delete process.env.METRICS_ENABLED;
  else process.env.METRICS_ENABLED = metricsEnabled;
});

async function requestCount(path: string): Promise<number> {
  const counter = await metrics.registry.getSingleMetric("http_requests_total")?.get();
  return (counter?.values ?? [])
    .filter((value) => value.labels.path === path)
    .reduce((sum, value) => sum + value.value, 0);
}

function serve(path: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  return http.serveTrpcHttp(
    new Request("http://localhost/api/trpc/test"),
    { label: "test", metricsPath: path, reject: () => new Response(null, { status: 400 }) },
    async () => new Response(body)
  );
}

describe("serveTrpcHttp's request metric", () => {
  it("is recorded once the body has been read, not when the response is returned", async () => {
    const path = "/api/trpc/metrics-streamed";
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first\n"));
        finish = () => {
          controller.enqueue(new TextEncoder().encode("second\n"));
          controller.close();
        };
      },
    });

    const response = await serve(path, body);
    const reader = response.body!.getReader();
    await reader.read();
    expect(await requestCount(path)).toBe(0);

    finish();
    const decoder = new TextDecoder();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toBe("second\n");
    expect(await requestCount(path)).toBe(1);
  });

  it("is recorded when the client goes away before the body ends", async () => {
    const path = "/api/trpc/metrics-cancelled";
    const response = await serve(path, new ReadableStream<Uint8Array>());

    await response.body!.cancel();
    expect(await requestCount(path)).toBe(1);
  });
});
