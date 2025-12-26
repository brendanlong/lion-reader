/**
 * Auth Router
 *
 * Handles user authentication: registration, login.
 * Session management (logout, session listing) is in users router.
 */

import { z } from "zod";
import * as argon2 from "argon2";
import crypto from "crypto";
import { eq } from "drizzle-orm";

import { createTRPCRouter, publicProcedure } from "../trpc";
import { errors } from "../errors";
import { users, sessions } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Email validation schema.
 * Uses Zod's built-in email validation.
 */
const emailSchema = z
  .string()
  .min(1, "Email is required")
  .max(255, "Email must be less than 255 characters")
  .email("Invalid email format")
  .toLowerCase()
  .trim();

/**
 * Password validation schema.
 * Enforces minimum security requirements:
 * - At least 8 characters
 * - Maximum 128 characters (reasonable limit)
 */
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password must be less than 128 characters");

/**
 * Registration input schema
 */
const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

/**
 * Login input schema
 */
const loginInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

// ============================================================================
// Constants
// ============================================================================

/**
 * Session duration in days
 */
const SESSION_DURATION_DAYS = 30;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generates a secure session token.
 * Returns both the raw token (for client) and its hash (for storage).
 */
function generateSessionToken(): { token: string; tokenHash: string } {
  // Generate 32 random bytes, encode as base64url
  const token = crypto.randomBytes(32).toString("base64url");

  // Hash the token for storage (we never store raw tokens)
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  return { token, tokenHash };
}

/**
 * Calculates session expiry date
 */
function getSessionExpiry(): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);
  return expiresAt;
}

// ============================================================================
// Router
// ============================================================================

export const authRouter = createTRPCRouter({
  /**
   * Register a new user account.
   *
   * @param email - User's email address (will be normalized to lowercase)
   * @param password - Password (min 8 characters)
   * @returns The created user and session token
   */
  register: publicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/register",
        tags: ["Auth"],
        summary: "Register a new account",
      },
    })
    .input(registerInputSchema)
    .output(
      z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          createdAt: z.date(),
        }),
        sessionToken: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { email, password } = input;

      // Check if email already exists
      const existingUser = await ctx.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existingUser.length > 0) {
        throw errors.emailExists();
      }

      // Hash the password with argon2
      const passwordHash = await argon2.hash(password);

      // Generate IDs
      const userId = generateUuidv7();
      const sessionId = generateUuidv7();
      const { token, tokenHash } = generateSessionToken();
      const expiresAt = getSessionExpiry();

      // Get client info from headers
      const userAgent = ctx.headers.get("user-agent") ?? undefined;
      const ipAddress =
        ctx.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
        ctx.headers.get("x-real-ip") ??
        undefined;

      // Create user and session in a transaction
      const now = new Date();

      await ctx.db.insert(users).values({
        id: userId,
        email,
        passwordHash,
        createdAt: now,
        updatedAt: now,
      });

      await ctx.db.insert(sessions).values({
        id: sessionId,
        userId,
        tokenHash,
        userAgent,
        ipAddress,
        expiresAt,
        createdAt: now,
        lastActiveAt: now,
      });

      return {
        user: {
          id: userId,
          email,
          createdAt: now,
        },
        sessionToken: token,
      };
    }),

  /**
   * Login with email and password.
   *
   * @param email - User's email address
   * @param password - User's password
   * @returns The user and session token
   */
  login: publicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/login",
        tags: ["Auth"],
        summary: "Login with email and password",
      },
    })
    .input(loginInputSchema)
    .output(
      z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          createdAt: z.date(),
        }),
        sessionToken: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { email, password } = input;

      // Find user by email
      const user = await ctx.db.select().from(users).where(eq(users.email, email)).limit(1);

      if (user.length === 0) {
        // User not found - use same error as wrong password to prevent enumeration
        throw errors.invalidCredentials();
      }

      const foundUser = user[0];

      // Check if user has a password (they might be OAuth-only in the future)
      if (!foundUser.passwordHash) {
        throw errors.invalidCredentials();
      }

      // Verify password
      const isValidPassword = await argon2.verify(foundUser.passwordHash, password);

      if (!isValidPassword) {
        throw errors.invalidCredentials();
      }

      // Create new session
      const sessionId = generateUuidv7();
      const { token, tokenHash } = generateSessionToken();
      const expiresAt = getSessionExpiry();

      // Get client info from headers
      const userAgent = ctx.headers.get("user-agent") ?? undefined;
      const ipAddress =
        ctx.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
        ctx.headers.get("x-real-ip") ??
        undefined;

      const now = new Date();

      await ctx.db.insert(sessions).values({
        id: sessionId,
        userId: foundUser.id,
        tokenHash,
        userAgent,
        ipAddress,
        expiresAt,
        createdAt: now,
        lastActiveAt: now,
      });

      return {
        user: {
          id: foundUser.id,
          email: foundUser.email,
          createdAt: foundUser.createdAt,
        },
        sessionToken: token,
      };
    }),
});
