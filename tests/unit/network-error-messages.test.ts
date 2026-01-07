/**
 * Unit tests for network error message formatting.
 *
 * Tests that technical Node.js network error messages are translated
 * into user-friendly descriptions for display in the UI.
 */

import { describe, it, expect } from "vitest";
import { formatNetworkErrorMessage } from "@/server/feed/fetcher";

/**
 * Creates a mock Node.js error with an error code.
 */
function createNetworkError(message: string, code?: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  if (code) {
    error.code = code;
  }
  return error;
}

describe("formatNetworkErrorMessage", () => {
  describe("DNS errors", () => {
    it("formats ENOTFOUND with domain from message", () => {
      const error = createNetworkError("getaddrinfo ENOTFOUND betonit.blog", "ENOTFOUND");
      expect(formatNetworkErrorMessage(error)).toBe("Domain not found: betonit.blog");
    });

    it("formats ENOTFOUND with code only", () => {
      const error = createNetworkError("DNS lookup failed", "ENOTFOUND");
      expect(formatNetworkErrorMessage(error)).toBe("Domain not found (DNS lookup failed)");
    });

    it("formats ENOTFOUND from message without code", () => {
      const error = createNetworkError("getaddrinfo ENOTFOUND example.com");
      expect(formatNetworkErrorMessage(error)).toBe("Domain not found: example.com");
    });

    it("formats EAI_AGAIN (DNS temporary failure)", () => {
      const error = createNetworkError("getaddrinfo EAI_AGAIN example.com", "EAI_AGAIN");
      expect(formatNetworkErrorMessage(error)).toBe("DNS lookup timed out (temporary DNS failure)");
    });
  });

  describe("connection errors", () => {
    it("formats ECONNREFUSED", () => {
      const error = createNetworkError("connect ECONNREFUSED 127.0.0.1:8080", "ECONNREFUSED");
      expect(formatNetworkErrorMessage(error)).toBe(
        "Connection refused (server not accepting connections)"
      );
    });

    it("formats ETIMEDOUT", () => {
      const error = createNetworkError("connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT");
      expect(formatNetworkErrorMessage(error)).toBe("Connection timed out");
    });

    it("formats ECONNRESET", () => {
      const error = createNetworkError("read ECONNRESET", "ECONNRESET");
      expect(formatNetworkErrorMessage(error)).toBe("Connection reset by server");
    });

    it("formats EHOSTUNREACH", () => {
      const error = createNetworkError("connect EHOSTUNREACH 10.0.0.1:443", "EHOSTUNREACH");
      expect(formatNetworkErrorMessage(error)).toBe("Host unreachable");
    });

    it("formats ENETUNREACH", () => {
      const error = createNetworkError("connect ENETUNREACH 192.168.1.1:80", "ENETUNREACH");
      expect(formatNetworkErrorMessage(error)).toBe("Network unreachable");
    });

    it("formats socket hang up", () => {
      const error = createNetworkError("socket hang up");
      expect(formatNetworkErrorMessage(error)).toBe("Connection closed unexpectedly");
    });
  });

  describe("SSL/TLS errors", () => {
    it("formats CERT_HAS_EXPIRED", () => {
      const error = createNetworkError("certificate has expired", "CERT_HAS_EXPIRED");
      expect(formatNetworkErrorMessage(error)).toBe("SSL certificate has expired");
    });

    it("formats UNABLE_TO_VERIFY_LEAF_SIGNATURE", () => {
      const error = createNetworkError(
        "unable to verify the first certificate",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      );
      expect(formatNetworkErrorMessage(error)).toBe("SSL certificate verification failed");
    });

    it("formats DEPTH_ZERO_SELF_SIGNED_CERT", () => {
      const error = createNetworkError("self signed certificate", "DEPTH_ZERO_SELF_SIGNED_CERT");
      expect(formatNetworkErrorMessage(error)).toBe("SSL certificate is self-signed");
    });

    it("formats generic certificate errors", () => {
      const error = createNetworkError("certificate chain too long");
      expect(formatNetworkErrorMessage(error)).toBe("SSL/TLS error: certificate chain too long");
    });
  });

  describe("unknown errors", () => {
    it("returns original message for unknown errors", () => {
      const error = createNetworkError("Something went wrong");
      expect(formatNetworkErrorMessage(error)).toBe("Something went wrong");
    });
  });
});
