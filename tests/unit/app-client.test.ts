import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAppClient,
  getAppRedirectUri,
  getDebugAppRedirectUri,
} from "../../src/server/oauth/app-client";

const issuer = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = "https://reader.example.com";
});

afterEach(() => {
  delete process.env.ANDROID_DEBUG_APP_CERT_SHA256;
  if (issuer === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = issuer;
});

describe("the app's OAuth client", () => {
  it("redirects only to the release app's path without a debug key", () => {
    expect(getAppClient().redirectUris).toEqual([getAppRedirectUri()]);
  });

  it("adds the debug app's own path once it has a key", () => {
    process.env.ANDROID_DEBUG_APP_CERT_SHA256 = Array(32).fill("CC").join(":");
    expect(getAppClient().redirectUris).toEqual([getAppRedirectUri(), getDebugAppRedirectUri()]);
    expect(getDebugAppRedirectUri()).toBe("https://reader.example.com/oauth/app-callback/debug");
  });

  it("takes the debug app's path on a dev server on this machine, key or not", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(getAppClient().redirectUris).toEqual([getAppRedirectUri(), getDebugAppRedirectUri()]);
  });
});
