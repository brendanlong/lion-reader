/**
 * Shared Zod Validation Schemas
 *
 * Common validation schemas used across multiple tRPC routers.
 */

import { z } from "zod";

// ============================================================================
// ID Schemas
// ============================================================================

/**
 * UUID validation schema for entity IDs.
 */
export const uuidSchema = z.string().uuid("Invalid ID");

// ============================================================================
// Tag Schemas
// ============================================================================

/**
 * Tag color validation schema.
 * Accepts hex colors like #ff6b6b or null. Shared between the tRPC tags
 * router and the MCP create_tag/update_tag tools so the two surfaces enforce
 * the same invariant (tag colors are rendered into inline styles).
 */
export const tagColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color must be a valid hex color (e.g., #ff6b6b)")
  .nullable();

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
