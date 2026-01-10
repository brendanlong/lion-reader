/**
 * Shared Zod Validation Schemas
 *
 * Common validation schemas used across multiple tRPC routers.
 */

import { z } from "zod";

// ============================================================================
// URL Schemas
// ============================================================================

/**
 * URL validation schema for feed/subscription URLs.
 *
 * Validates:
 * - Required (non-empty)
 * - Max 2048 characters (reasonable URL limit)
 * - Valid URL format
 * - Must use http or https protocol
 */
export const feedUrlSchema = z
  .string()
  .min(1, "URL is required")
  .max(2048, "URL must be less than 2048 characters")
  .url("Invalid URL format")
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "URL must use http or https protocol",
  });
