import { afterEach, describe, expect, it } from "vitest";
import {
  getAppClient,
  getAppRedirectUri,
  getDebugAppRedirectUri,
} from "../../src/server/oauth/app-client";

afterEach(() => {
  delete process.env.ANDROID_DEBUG_APP_CERT_SHA256;
});

describe("the app's OAuth client", () => {
  it("redirects only to the release app's path without a debug key", () => {
    expect(getAppClient().redirectUris).toEqual([getAppRedirectUri()]);
  });

  it("adds the debug app's own path once it has a key", () => {
    process.env.ANDROID_DEBUG_APP_CERT_SHA256 = Array(32).fill("CC").join(":");
    expect(getAppClient().redirectUris).toEqual([getAppRedirectUri(), getDebugAppRedirectUri()]);
    expect(getDebugAppRedirectUri()).toBe(`${getAppRedirectUri()}/debug`);
  });
});
