/**
 * Unit tests for the Android app version metric (#1846): which installed app
 * versions still make requests, read from the app's User-Agent.
 *
 * `metricsEnabled` is read from the environment at module load, so we set
 * METRICS_ENABLED before dynamically importing the metrics module.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

let metrics: typeof import("@/server/metrics/metrics");
let prevMetricsEnabled: string | undefined;

beforeAll(async () => {
  prevMetricsEnabled = process.env.METRICS_ENABLED;
  process.env.METRICS_ENABLED = "true";
  metrics = await import("@/server/metrics/metrics");
});

afterAll(() => {
  if (prevMetricsEnabled === undefined) delete process.env.METRICS_ENABLED;
  else process.env.METRICS_ENABLED = prevMetricsEnabled;
});

describe("androidAppVersionLabel", () => {
  // What installed apps send (kmp/androidApp AppGraph.kt): releases up to 0.6.0
  // omit the versionCode, which is X*1000000 + Y*1000 + Z for release X.Y.Z.
  it.each([
    ["LionReader-Android/0.6.0", "0.6.0"],
    ["LionReader-Android/0.7.0 (7000)", "0.7.0"],
    ["LionReader-Android/2099.999.999 (2099999999)", "2099.999.999"],
    // Debug builds report versionCode 1 (and whatever versionName).
    ["LionReader-Android/0.1.0 (1)", "debug"],
  ])("labels %s as %s", (userAgent, label) => {
    expect(metrics.androidAppVersionLabel(userAgent, new Set())).toBe(label);
  });

  it.each([
    ["not the app", "okhttp/4.12.0"],
    ["not an X.Y.Z version", "LionReader-Android/0.6.0-debug"],
    ["a versionCode that isn't the versionName's", "LionReader-Android/0.1.0 (7000)"],
  ])("labels %s as other", (_, userAgent) => {
    expect(metrics.androidAppVersionLabel(userAgent, new Set())).toBe("other");
  });

  it("gives at most MAX_ANDROID_VERSION_LABELS versions their own label", () => {
    const seen = new Set<string>();
    for (let i = 0; i < metrics.MAX_ANDROID_VERSION_LABELS; i++) {
      expect(metrics.androidAppVersionLabel(`LionReader-Android/0.0.${i}`, seen)).toBe(`0.0.${i}`);
    }
    expect(metrics.androidAppVersionLabel("LionReader-Android/1.0.0", seen)).toBe("other");
    // Versions already labeled keep their label once the cap is reached.
    expect(metrics.androidAppVersionLabel("LionReader-Android/0.0.0", seen)).toBe("0.0.0");
  });
});

describe("trackAndroidAppRequest", () => {
  async function count(version: string): Promise<number> {
    const metric = metrics.registry.getSingleMetric("android_app_requests_total");
    const values = (await metric?.get())?.values ?? [];
    return values.find((v) => v.labels.version === version)?.value ?? 0;
  }

  it("counts requests by app version", async () => {
    const before = { release: await count("0.6.0"), other: await count("other") };

    metrics.trackAndroidAppRequest("LionReader-Android/0.6.0");
    metrics.trackAndroidAppRequest("LionReader-Android/0.6.0 (6000)");
    metrics.trackAndroidAppRequest("something else");

    expect(await count("0.6.0")).toBe(before.release + 2);
    expect(await count("other")).toBe(before.other + 1);
  });
});
