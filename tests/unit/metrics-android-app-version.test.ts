/**
 * Unit tests for the Android app version metric (#1846): which installed app
 * versions still make requests, read from the app's User-Agent.
 *
 * `metricsEnabled` is read from the environment at module load, so we set
 * METRICS_ENABLED before dynamically importing the metrics module.
 */
import { describe, it, expect, beforeAll } from "vitest";

let metrics: typeof import("@/server/metrics/metrics");

beforeAll(async () => {
  process.env.METRICS_ENABLED = "true";
  metrics = await import("@/server/metrics/metrics");
});

describe("androidAppVersionLabel", () => {
  // The User-Agent is what the installed apps send (kmp/androidApp AppGraph.kt):
  // released installs up to 0.6.0 omit the versionCode.
  it.each([
    ["LionReader-Android/0.7.0 (7000)", "0.7.0"],
    ["LionReader-Android/0.6.0", "0.6.0"],
    ["LionReader-Android/2099.999.999 (2099999999)", "2099.999.999"],
  ])("labels %s as %s", (userAgent, label) => {
    expect(metrics.androidAppVersionLabel(userAgent, new Set())).toBe(label);
  });

  it.each([
    null,
    "",
    "okhttp/4.12.0",
    "Mozilla/5.0 LionReader-Android/0.6.0",
    "LionReader-Android/0.6.0 (7000) extra",
    "LionReader-Android/0.6.0-debug",
    "LionReader-Android/0.6",
    "LionReader-Android/12345.0.0",
    'LionReader-Android/0.6.0 (x")',
  ])("labels %j as other", (userAgent) => {
    expect(metrics.androidAppVersionLabel(userAgent, new Set())).toBe("other");
  });

  it("gives at most MAX_ANDROID_VERSION_LABELS versions their own label", () => {
    const seen = new Set<string>();
    for (let i = 0; i < metrics.MAX_ANDROID_VERSION_LABELS; i++) {
      expect(metrics.androidAppVersionLabel(`LionReader-Android/0.0.${i}`, seen)).toBe(`0.0.${i}`);
    }
    expect(metrics.androidAppVersionLabel("LionReader-Android/1.0.0", seen)).toBe("other");
    // Versions already labeled keep their label once the cap is reached.
    expect(metrics.androidAppVersionLabel("LionReader-Android/0.0.0 (1)", seen)).toBe("0.0.0");
  });
});

describe("trackAndroidAppRequest", () => {
  it("counts requests by app version", async () => {
    metrics.trackAndroidAppRequest("LionReader-Android/0.6.0");
    metrics.trackAndroidAppRequest("LionReader-Android/0.6.0 (6000)");
    metrics.trackAndroidAppRequest("something else");

    const output = await metrics.registry.metrics();
    expect(output).toMatch(/android_app_requests_total\{version="0\.6\.0"\} 2\n/);
    expect(output).toMatch(/android_app_requests_total\{version="other"\} 1\n/);
  });
});
