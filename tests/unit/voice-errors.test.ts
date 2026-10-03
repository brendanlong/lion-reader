/**
 * Unit tests for voice error classification.
 *
 * These tests verify that errors are properly classified and
 * user-friendly messages are returned.
 */

import { describe, it, expect } from "vitest";
import { classifyVoiceError, getVoiceErrorInfo } from "../../src/lib/narration/errors";

/** An Error with the given message and, optionally, name. */
function err(message: string, name?: string): Error {
  const error = new Error(message);
  if (name) error.name = name;
  return error;
}

describe("classifyVoiceError", () => {
  // One case per kind of signal (error name vs message keyword) for each type;
  // the keyword lists themselves live in errors.ts.
  it.each([
    [
      "QuotaExceededError by name",
      err("Storage quota exceeded", "QuotaExceededError"),
      "quota_exceeded",
    ],
    ["a storage message", err("Not enough storage space available"), "quota_exceeded"],
    ["NetworkError by name", err("Network request failed", "NetworkError"), "network_error"],
    ["a fetch TypeError", new TypeError("Failed to fetch"), "network_error"],
    ["a Chrome-style net:: message", err("net::ERR_INTERNET_DISCONNECTED"), "network_error"],
    ["a 404 message", err("HTTP 404: Not Found"), "voice_not_found"],
    ["AbortError by name", err("Request was aborted", "AbortError"), "download_interrupted"],
    ["an interrupted message", err("Download was interrupted"), "download_interrupted"],
    ["a corrupt-cache message", err("Cache data is corrupt"), "corrupted_cache"],
    ["a generic error", err("Something went wrong"), "unknown"],
  ] as const)("classifies %s", (_label, error, expected) => {
    expect(classifyVoiceError(error)).toBe(expected);
  });

  it("returns unknown for non-Error values", () => {
    expect(classifyVoiceError("string error")).toBe("unknown");
    expect(classifyVoiceError(null)).toBe("unknown");
    expect(classifyVoiceError(undefined)).toBe("unknown");
    expect(classifyVoiceError(42)).toBe("unknown");
  });
});

describe("getVoiceErrorInfo", () => {
  it("returns full error info for quota exceeded", () => {
    const error = new Error("Quota exceeded");
    error.name = "QuotaExceededError";

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("quota_exceeded");
    expect(info.message).toContain("storage");
    expect(info.suggestion).toContain("delet"); // covers "delete" or "deleting"
    expect(info.retryable).toBe(false);
  });

  it("returns full error info for network error", () => {
    const error = new Error("Network error");
    error.name = "NetworkError";

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("network_error");
    expect(info.message).toContain("network");
    expect(info.suggestion).toContain("connection");
    expect(info.retryable).toBe(true);
  });

  it("returns full error info for corrupted cache", () => {
    const error = new Error("Cache data is corrupt");

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("corrupted_cache");
    expect(info.message).toContain("corrupted");
    expect(info.suggestion).toContain("cache");
    expect(info.retryable).toBe(true);
  });

  it("returns full error info for download interrupted", () => {
    const error = new Error("Download was aborted");

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("download_interrupted");
    expect(info.message).toContain("interrupted");
    expect(info.retryable).toBe(true);
  });

  it("returns full error info for voice not found", () => {
    const error = new Error("HTTP 404: Not Found");

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("voice_not_found");
    expect(info.message).toContain("not available");
    expect(info.suggestion).toContain("different voice");
    expect(info.retryable).toBe(false);
  });

  it("returns full error info for unknown error", () => {
    const error = new Error("Something went wrong");

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("unknown");
    expect(info.message).toBeDefined();
    expect(info.retryable).toBe(true);
  });
});

describe("error classification priority", () => {
  // When an error could match multiple categories, the most specific should win

  it("prioritizes quota errors over other storage errors", () => {
    const error = new Error("IndexedDB quota exceeded");

    // Could match both quota and corrupted_cache (indexeddb), but quota is more specific
    expect(classifyVoiceError(error)).toBe("quota_exceeded");
  });

  it("handles combined error messages appropriately", () => {
    // This tests that the classification order is correct
    const quotaWithNetwork = new Error("Quota exceeded while fetching");
    expect(classifyVoiceError(quotaWithNetwork)).toBe("quota_exceeded");

    const networkWithQuota = new Error("Failed to fetch due to storage");
    expect(classifyVoiceError(networkWithQuota)).toBe("quota_exceeded");
  });
});
