import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/.well-known/assetlinks.json/route";

const key = (byte: string) => Array(32).fill(byte).join(":");
const RELEASE = key("AA");
const RELEASE_2 = key("BB");
const DEBUG = key("CC");

afterEach(() => {
  delete process.env.ANDROID_APP_CERT_SHA256;
  delete process.env.ANDROID_DEBUG_APP_CERT_SHA256;
});

async function packages(): Promise<Record<string, string[]>> {
  const statements = await GET().json();
  return Object.fromEntries(
    statements.map(
      (s: { target: { package_name: string; sha256_cert_fingerprints: string[] } }) => [
        s.target.package_name,
        s.target.sha256_cert_fingerprints,
      ]
    )
  );
}

describe("/.well-known/assetlinks.json", () => {
  it("publishes nothing when no app is configured", async () => {
    expect(await packages()).toEqual({});
  });

  it("publishes a statement Android can verify", async () => {
    process.env.ANDROID_APP_CERT_SHA256 = RELEASE;
    expect(await GET().json()).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "com.lionreader.app",
          sha256_cert_fingerprints: [RELEASE],
        },
      },
    ]);
  });

  it("publishes the release and debug apps with their own keys", async () => {
    process.env.ANDROID_APP_CERT_SHA256 = `${RELEASE}, ${RELEASE_2}`;
    process.env.ANDROID_DEBUG_APP_CERT_SHA256 = DEBUG;
    expect(await packages()).toEqual({
      "com.lionreader.app": [RELEASE, RELEASE_2],
      "com.lionreader.app.debug": [DEBUG],
    });
  });

  it("uppercases keys and drops malformed ones", async () => {
    process.env.ANDROID_APP_CERT_SHA256 = `${RELEASE.toLowerCase()},AA:BB,${key("AA").slice(0, 59)}`;
    process.env.ANDROID_DEBUG_APP_CERT_SHA256 = "not-a-key";
    expect(await packages()).toEqual({ "com.lionreader.app": [RELEASE] });
  });
});
