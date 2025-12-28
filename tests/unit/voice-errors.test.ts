/**
 * Unit tests for voice error classification.
 *
 * These tests verify that errors are properly classified and
 * user-friendly messages are returned.
 */

import { describe, it, expect } from "vitest";
import {
  classifyVoiceError,
  getVoiceErrorInfo,
  getVoiceErrorMessage,
  isVoiceErrorRetryable,
} from "../../src/lib/narration/errors";

describe("classifyVoiceError", () => {
  describe("quota exceeded errors", () => {
    it("classifies QuotaExceededError by name", () => {
      const error = new Error("Storage quota exceeded");
      error.name = "QuotaExceededError";

      expect(classifyVoiceError(error)).toBe("quota_exceeded");
    });

    it("classifies errors with 'quota' in message", () => {
      const error = new Error("Quota exceeded for IndexedDB");

      expect(classifyVoiceError(error)).toBe("quota_exceeded");
    });

    it("classifies errors with 'storage' in message", () => {
      const error = new Error("Not enough storage space available");

      expect(classifyVoiceError(error)).toBe("quota_exceeded");
    });

    it("classifies errors with 'disk' in message", () => {
      const error = new Error("Disk full");

      expect(classifyVoiceError(error)).toBe("quota_exceeded");
    });

    it("classifies errors with 'space' in message", () => {
      const error = new Error("Not enough space");

      expect(classifyVoiceError(error)).toBe("quota_exceeded");
    });
  });

  describe("network errors", () => {
    it("classifies NetworkError by name", () => {
      const error = new Error("Network request failed");
      error.name = "NetworkError";

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies TypeError (common for fetch failures)", () => {
      const error = new TypeError("Failed to fetch");

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies errors with 'network' in message", () => {
      const error = new Error("A network error occurred");

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies errors with 'connection' in message", () => {
      const error = new Error("Connection refused");

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies errors with 'timeout' in message", () => {
      const error = new Error("Request timeout");

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies errors with 'dns' in message", () => {
      const error = new Error("DNS lookup failed");

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies errors with 'offline' in message", () => {
      const error = new Error("Browser is offline");

      expect(classifyVoiceError(error)).toBe("network_error");
    });

    it("classifies Chrome-style net errors", () => {
      const error = new Error("net::ERR_INTERNET_DISCONNECTED");

      expect(classifyVoiceError(error)).toBe("network_error");
    });
  });

  describe("download interrupted errors", () => {
    it("classifies AbortError by name", () => {
      const error = new Error("Request was aborted");
      error.name = "AbortError";

      expect(classifyVoiceError(error)).toBe("download_interrupted");
    });

    it("classifies errors with 'abort' in message", () => {
      const error = new Error("Download was aborted");

      expect(classifyVoiceError(error)).toBe("download_interrupted");
    });

    it("classifies errors with 'interrupt' in message", () => {
      const error = new Error("Download was interrupted");

      expect(classifyVoiceError(error)).toBe("download_interrupted");
    });

    it("classifies errors with 'cancel' in message", () => {
      const error = new Error("Request cancelled by user");

      expect(classifyVoiceError(error)).toBe("download_interrupted");
    });
  });

  describe("corrupted cache errors", () => {
    it("classifies errors with 'corrupt' in message", () => {
      const error = new Error("Cache data is corrupt");

      expect(classifyVoiceError(error)).toBe("corrupted_cache");
    });

    it("classifies errors with 'invalid' in message", () => {
      const error = new Error("Invalid data in cache");

      expect(classifyVoiceError(error)).toBe("corrupted_cache");
    });

    it("classifies errors with 'parse' in message", () => {
      const error = new Error("Failed to parse cached data");

      expect(classifyVoiceError(error)).toBe("corrupted_cache");
    });

    it("classifies errors with 'malformed' in message", () => {
      const error = new Error("Malformed cache entry");

      expect(classifyVoiceError(error)).toBe("corrupted_cache");
    });

    it("classifies IndexedDB errors", () => {
      const error = new Error("IndexedDB error: data corrupted");

      expect(classifyVoiceError(error)).toBe("corrupted_cache");
    });
  });

  describe("unknown errors", () => {
    it("returns unknown for non-Error values", () => {
      expect(classifyVoiceError("string error")).toBe("unknown");
      expect(classifyVoiceError(null)).toBe("unknown");
      expect(classifyVoiceError(undefined)).toBe("unknown");
      expect(classifyVoiceError(42)).toBe("unknown");
    });

    it("returns unknown for generic errors", () => {
      const error = new Error("Something went wrong");

      expect(classifyVoiceError(error)).toBe("unknown");
    });

    it("returns unknown for unrecognized error types", () => {
      const error = new Error("Unexpected server response");

      expect(classifyVoiceError(error)).toBe("unknown");
    });
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

  it("returns full error info for unknown error", () => {
    const error = new Error("Something went wrong");

    const info = getVoiceErrorInfo(error);

    expect(info.type).toBe("unknown");
    expect(info.message).toBeDefined();
    expect(info.retryable).toBe(true);
  });
});

describe("getVoiceErrorMessage", () => {
  it("returns user-friendly message for quota exceeded", () => {
    const error = new Error("Quota exceeded");
    error.name = "QuotaExceededError";

    const message = getVoiceErrorMessage(error);

    expect(message).toContain("storage");
    expect(message.length).toBeLessThan(100); // Should be concise
  });

  it("returns user-friendly message for network error", () => {
    const error = new Error("Failed to fetch");

    const message = getVoiceErrorMessage(error);

    expect(message).toContain("network");
    expect(message.length).toBeLessThan(100);
  });

  it("returns user-friendly message for unknown error", () => {
    const error = new Error("Unknown problem");

    const message = getVoiceErrorMessage(error);

    expect(message).toBeDefined();
    expect(message.length).toBeGreaterThan(0);
  });
});

describe("isVoiceErrorRetryable", () => {
  it("returns false for quota exceeded", () => {
    const error = new Error("Quota exceeded");
    error.name = "QuotaExceededError";

    expect(isVoiceErrorRetryable(error)).toBe(false);
  });

  it("returns true for network error", () => {
    const error = new Error("Network error");
    error.name = "NetworkError";

    expect(isVoiceErrorRetryable(error)).toBe(true);
  });

  it("returns true for download interrupted", () => {
    const error = new Error("Download was aborted");

    expect(isVoiceErrorRetryable(error)).toBe(true);
  });

  it("returns true for corrupted cache", () => {
    const error = new Error("Cache data is corrupt");

    expect(isVoiceErrorRetryable(error)).toBe(true);
  });

  it("returns true for unknown error", () => {
    const error = new Error("Something went wrong");

    expect(isVoiceErrorRetryable(error)).toBe(true);
  });

  it("returns true for non-Error values", () => {
    expect(isVoiceErrorRetryable("string error")).toBe(true);
    expect(isVoiceErrorRetryable(null)).toBe(true);
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
