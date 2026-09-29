import { afterEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/.well-known/assetlinks.json/route";

const RELEASE = "AA:BB";
const DEBUG = "CC:DD";

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

  it("publishes the release and debug apps with their own keys", async () => {
    process.env.ANDROID_APP_CERT_SHA256 = `${RELEASE}, EE:FF`;
    process.env.ANDROID_DEBUG_APP_CERT_SHA256 = DEBUG;
    expect(await packages()).toEqual({
      "com.lionreader.app": [RELEASE, "EE:FF"],
      "com.lionreader.app.debug": [DEBUG],
    });
  });

  it("omits an app whose keys aren't set", async () => {
    process.env.ANDROID_APP_CERT_SHA256 = RELEASE;
    expect(Object.keys(await packages())).toEqual(["com.lionreader.app"]);
  });
});
