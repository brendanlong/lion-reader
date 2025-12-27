/**
 * Auth Router
 *
 * Handles user authentication: registration, login, logout, and OAuth.
 * Session listing and revocation is in users router.
 */

import { z } from "zod";
import * as argon2 from "argon2";
import { eq, and, sql } from "drizzle-orm";

import {
  createTRPCRouter,
  publicProcedure,
  protectedProcedure,
  expensivePublicProcedure,
  expensiveProtectedProcedure,
} from "../trpc";
import { errors } from "../errors";
import { users, sessions } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateSessionToken,
  getSessionExpiry,
  revokeSessionByToken,
  getEnabledProviders,
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
  createAppleAuthUrl,
  validateAppleCallback,
  isAppleOAuthEnabled,
} from "@/server/auth";
import { oauthAccounts } from "@/server/db/schema";

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
// Router
// ============================================================================

export const authRouter = createTRPCRouter({
  /**
   * Register a new user account.
   *
   * @param email - User's email address (will be normalized to lowercase)
   * @param password - Password (min 8 characters)
   * @returns The created user and session token
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * to prevent abuse.
   */
  register: expensivePublicProcedure
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
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * to prevent brute force attacks.
   */
  login: expensivePublicProcedure
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

  /**
   * Get list of enabled OAuth providers.
   *
   * Returns the list of OAuth providers that are configured and available.
   * UI uses this to decide which OAuth buttons to show.
   * If no OAuth providers are configured, returns empty array.
   */
  providers: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/auth/providers",
        tags: ["Auth"],
        summary: "Get enabled OAuth providers",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        providers: z.array(z.enum(["google", "apple"])),
      })
    )
    .query(() => {
      const enabledProviders = getEnabledProviders();

      return {
        providers: enabledProviders,
      };
    }),

  /**
   * Generate Google OAuth authorization URL.
   *
   * Returns a URL to redirect the user to for Google OAuth login.
   * The state parameter should be stored by the client to verify the callback.
   *
   * Flow:
   * 1. Client calls this endpoint
   * 2. Client stores the returned state (e.g., in localStorage)
   * 3. Client redirects user to the URL
   * 4. After Google auth, user is redirected to callback URL
   * 5. Client sends code and state to googleCallback endpoint
   */
  googleAuthUrl: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/auth/oauth/google",
        tags: ["Auth"],
        summary: "Get Google OAuth authorization URL",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        url: z.string(),
        state: z.string(),
      })
    )
    .query(async () => {
      if (!isGoogleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Google");
      }

      const result = await createGoogleAuthUrl();

      return {
        url: result.url,
        state: result.state,
      };
    }),

  /**
   * Handle Google OAuth callback.
   *
   * Exchanges the authorization code for tokens, retrieves user info,
   * and creates or links a user account.
   *
   * Account Linking Logic:
   * 1. If OAuth account exists: log in as that user
   * 2. If email matches existing user: link OAuth to that account
   * 3. Otherwise: create new user and OAuth account
   *
   * @param code - The authorization code from Google
   * @param state - The state parameter (must match the one from googleAuthUrl)
   * @returns The user and session token
   */
  googleCallback: expensivePublicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/oauth/google/callback",
        tags: ["Auth"],
        summary: "Handle Google OAuth callback",
      },
    })
    .input(
      z.object({
        code: z.string().min(1, "Authorization code is required"),
        state: z.string().min(1, "State parameter is required"),
      })
    )
    .output(
      z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          createdAt: z.date(),
        }),
        sessionToken: z.string(),
        isNewUser: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { code, state } = input;

      if (!isGoogleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Google");
      }

      // Validate the OAuth callback
      let googleResult;
      try {
        googleResult = await validateGoogleCallback(code, state);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Invalid or expired OAuth state")) {
            throw errors.oauthStateInvalid();
          }
          throw errors.oauthCallbackFailed(error.message);
        }
        throw errors.oauthCallbackFailed("Unknown error");
      }

      const { userInfo, tokens } = googleResult;
      const now = new Date();

      // Check if OAuth account already exists
      const existingOAuthAccount = await ctx.db
        .select({
          id: oauthAccounts.id,
          userId: oauthAccounts.userId,
        })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "google"),
            eq(oauthAccounts.providerAccountId, userInfo.sub)
          )
        )
        .limit(1);

      let userId: string;
      let userEmail: string;
      let userCreatedAt: Date;
      let isNewUser = false;

      if (existingOAuthAccount.length > 0) {
        // OAuth account exists - log in as that user
        userId = existingOAuthAccount[0].userId;

        // Get user details
        const userResult = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);

        if (userResult.length === 0) {
          // Orphaned OAuth account - this shouldn't happen
          throw errors.internal("User account not found");
        }

        userEmail = userResult[0].email;
        userCreatedAt = userResult[0].createdAt;

        // Update OAuth tokens
        await ctx.db
          .update(oauthAccounts)
          .set({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
          })
          .where(eq(oauthAccounts.id, existingOAuthAccount[0].id));
      } else {
        // OAuth account doesn't exist - check if email matches existing user
        const existingUser = await ctx.db
          .select()
          .from(users)
          .where(eq(users.email, userInfo.email.toLowerCase()))
          .limit(1);

        if (existingUser.length > 0) {
          // Link OAuth to existing user account
          userId = existingUser[0].id;
          userEmail = existingUser[0].email;
          userCreatedAt = existingUser[0].createdAt;

          // Create OAuth account link
          await ctx.db.insert(oauthAccounts).values({
            id: generateUuidv7(),
            userId,
            provider: "google",
            providerAccountId: userInfo.sub,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
            createdAt: now,
          });

          // Mark email as verified if not already (Google verified it)
          if (!existingUser[0].emailVerifiedAt) {
            await ctx.db
              .update(users)
              .set({
                emailVerifiedAt: now,
                updatedAt: now,
              })
              .where(eq(users.id, userId));
          }
        } else {
          // Create new user and OAuth account
          userId = generateUuidv7();
          userEmail = userInfo.email.toLowerCase();
          userCreatedAt = now;
          isNewUser = true;

          // Create user (no password since they're using OAuth)
          await ctx.db.insert(users).values({
            id: userId,
            email: userEmail,
            emailVerifiedAt: now, // Google verified the email
            passwordHash: null,
            createdAt: now,
            updatedAt: now,
          });

          // Create OAuth account
          await ctx.db.insert(oauthAccounts).values({
            id: generateUuidv7(),
            userId,
            provider: "google",
            providerAccountId: userInfo.sub,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
            createdAt: now,
          });
        }
      }

      // Create session
      const sessionId = generateUuidv7();
      const { token, tokenHash } = generateSessionToken();
      const expiresAt = getSessionExpiry();

      // Get client info from headers
      const userAgent = ctx.headers.get("user-agent") ?? undefined;
      const ipAddress =
        ctx.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
        ctx.headers.get("x-real-ip") ??
        undefined;

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
          email: userEmail,
          createdAt: userCreatedAt,
        },
        sessionToken: token,
        isNewUser,
      };
    }),

  /**
   * Generate Apple OAuth authorization URL.
   *
   * Returns a URL to redirect the user to for Apple OAuth login.
   * The state parameter should be stored by the client to verify the callback.
   *
   * Flow:
   * 1. Client calls this endpoint
   * 2. Client stores the returned state (e.g., in localStorage)
   * 3. Client redirects user to the URL
   * 4. After Apple auth, user is redirected to callback URL
   * 5. Client sends code, state, and user data to appleCallback endpoint
   *
   * Note: Apple uses form_post response mode, so the callback comes as a POST
   */
  appleAuthUrl: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/auth/oauth/apple",
        tags: ["Auth"],
        summary: "Get Apple OAuth authorization URL",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        url: z.string(),
        state: z.string(),
      })
    )
    .query(async () => {
      if (!isAppleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Apple");
      }

      const result = await createAppleAuthUrl();

      return {
        url: result.url,
        state: result.state,
      };
    }),

  /**
   * Handle Apple OAuth callback.
   *
   * Exchanges the authorization code for tokens, retrieves user info from JWT,
   * and creates or links a user account.
   *
   * Important Apple-specific behavior:
   * - Apple only sends user info (name, email) on FIRST authorization
   * - The `user` parameter contains this first-auth data
   * - Users may use Apple's private relay email (randomized@privaterelay.appleid.com)
   * - We store the email regardless - relay emails are fully functional
   *
   * Account Linking Logic:
   * 1. If OAuth account exists: log in as that user
   * 2. If email matches existing user: link OAuth to that account
   * 3. Otherwise: create new user and OAuth account
   *
   * @param code - The authorization code from Apple
   * @param state - The state parameter (must match the one from appleAuthUrl)
   * @param user - Optional user data (only sent on first authorization, JSON string or object)
   * @returns The user and session token
   */
  appleCallback: expensivePublicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/oauth/apple/callback",
        tags: ["Auth"],
        summary: "Handle Apple OAuth callback",
      },
    })
    .input(
      z.object({
        code: z.string().min(1, "Authorization code is required"),
        state: z.string().min(1, "State parameter is required"),
        // Apple sends user data only on first authorization - can be JSON string or object
        user: z
          .union([
            z.string(),
            z.object({
              name: z
                .object({
                  firstName: z.string().optional(),
                  lastName: z.string().optional(),
                })
                .optional(),
              email: z.string().optional(),
            }),
          ])
          .optional(),
      })
    )
    .output(
      z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          createdAt: z.date(),
        }),
        sessionToken: z.string(),
        isNewUser: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { code, state, user: userDataInput } = input;

      if (!isAppleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Apple");
      }

      // Validate the OAuth callback
      let appleResult;
      try {
        appleResult = await validateAppleCallback(code, state, userDataInput);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Invalid or expired OAuth state")) {
            throw errors.oauthStateInvalid();
          }
          throw errors.oauthCallbackFailed(error.message);
        }
        throw errors.oauthCallbackFailed("Unknown error");
      }

      const { userInfo, firstAuthData, tokens } = appleResult;
      const now = new Date();

      // Get email from JWT or first-auth data
      // Apple always includes email in JWT on first auth, may not on subsequent auths
      let email = userInfo.email ?? firstAuthData?.email;

      // Check if OAuth account already exists
      const existingOAuthAccount = await ctx.db
        .select({
          id: oauthAccounts.id,
          userId: oauthAccounts.userId,
        })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "apple"),
            eq(oauthAccounts.providerAccountId, userInfo.sub)
          )
        )
        .limit(1);

      let userId: string;
      let userEmail: string;
      let userCreatedAt: Date;
      let isNewUser = false;

      if (existingOAuthAccount.length > 0) {
        // OAuth account exists - log in as that user
        userId = existingOAuthAccount[0].userId;

        // Get user details
        const userResult = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);

        if (userResult.length === 0) {
          // Orphaned OAuth account - this shouldn't happen
          throw errors.internal("User account not found");
        }

        userEmail = userResult[0].email;
        userCreatedAt = userResult[0].createdAt;

        // Update OAuth tokens
        await ctx.db
          .update(oauthAccounts)
          .set({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
          })
          .where(eq(oauthAccounts.id, existingOAuthAccount[0].id));
      } else {
        // OAuth account doesn't exist
        // Apple only sends email on first auth - it MUST be present for new accounts
        if (!email) {
          throw errors.oauthCallbackFailed(
            "Email not provided. Please try signing in again and grant email permission."
          );
        }

        // Normalize email
        email = email.toLowerCase();

        // Check if email matches existing user
        const existingUser = await ctx.db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existingUser.length > 0) {
          // Link OAuth to existing user account
          userId = existingUser[0].id;
          userEmail = existingUser[0].email;
          userCreatedAt = existingUser[0].createdAt;

          // Create OAuth account link
          await ctx.db.insert(oauthAccounts).values({
            id: generateUuidv7(),
            userId,
            provider: "apple",
            providerAccountId: userInfo.sub,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
            createdAt: now,
          });

          // Mark email as verified if not already (Apple verified it)
          // Note: Even private relay emails are verified by Apple
          if (!existingUser[0].emailVerifiedAt) {
            await ctx.db
              .update(users)
              .set({
                emailVerifiedAt: now,
                updatedAt: now,
              })
              .where(eq(users.id, userId));
          }
        } else {
          // Create new user and OAuth account
          userId = generateUuidv7();
          userEmail = email;
          userCreatedAt = now;
          isNewUser = true;

          // Create user (no password since they're using OAuth)
          // Note: Apple private relay emails work just like regular emails
          await ctx.db.insert(users).values({
            id: userId,
            email: userEmail,
            emailVerifiedAt: now, // Apple verified the email
            passwordHash: null,
            createdAt: now,
            updatedAt: now,
          });

          // Create OAuth account
          await ctx.db.insert(oauthAccounts).values({
            id: generateUuidv7(),
            userId,
            provider: "apple",
            providerAccountId: userInfo.sub,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
            createdAt: now,
          });
        }
      }

      // Create session
      const sessionId = generateUuidv7();
      const { token, tokenHash } = generateSessionToken();
      const expiresAt = getSessionExpiry();

      // Get client info from headers
      const userAgent = ctx.headers.get("user-agent") ?? undefined;
      const ipAddress =
        ctx.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
        ctx.headers.get("x-real-ip") ??
        undefined;

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
          email: userEmail,
          createdAt: userCreatedAt,
        },
        sessionToken: token,
        isNewUser,
      };
    }),

  /**
   * Get the current authenticated user.
   *
   * Returns the user profile for the currently authenticated session.
   */
  me: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/auth/me",
        tags: ["Auth"],
        summary: "Get current user",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        user: z.object({
          id: z.string(),
          email: z.string(),
          emailVerifiedAt: z.date().nullable(),
          createdAt: z.date(),
        }),
      })
    )
    .query(({ ctx }) => {
      const { user } = ctx.session;

      return {
        user: {
          id: user.id,
          email: user.email,
          emailVerifiedAt: user.emailVerifiedAt,
          createdAt: user.createdAt,
        },
      };
    }),

  /**
   * Logout the current session.
   *
   * Revokes the current session token, invalidating it for future requests.
   * Also clears the session from Redis cache.
   */
  logout: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/logout",
        tags: ["Auth"],
        summary: "Logout current session",
      },
    })
    .input(z.object({}).optional())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx }) => {
      // Revoke the current session using the token from context
      if (ctx.sessionToken) {
        await revokeSessionByToken(ctx.sessionToken);
      }

      return { success: true };
    }),

  /**
   * Link Google OAuth to existing account.
   *
   * Similar to googleCallback but requires the user to be authenticated
   * and links the OAuth account to the current user rather than creating
   * a new account or finding an existing one.
   *
   * @param code - The authorization code from Google
   * @param state - The state parameter (must match the one from googleAuthUrl)
   * @returns Success status
   */
  linkGoogle: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/link/google",
        tags: ["Auth"],
        summary: "Link Google OAuth to existing account",
      },
    })
    .input(
      z.object({
        code: z.string().min(1, "Authorization code is required"),
        state: z.string().min(1, "State parameter is required"),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { code, state } = input;
      const userId = ctx.session.user.id;

      if (!isGoogleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Google");
      }

      // Check if user already has a Google account linked
      const existingLink = await ctx.db
        .select({ id: oauthAccounts.id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")))
        .limit(1);

      if (existingLink.length > 0) {
        throw errors.oauthAlreadyLinked("Google");
      }

      // Validate the OAuth callback
      let googleResult;
      try {
        googleResult = await validateGoogleCallback(code, state);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Invalid or expired OAuth state")) {
            throw errors.oauthStateInvalid();
          }
          throw errors.oauthCallbackFailed(error.message);
        }
        throw errors.oauthCallbackFailed("Unknown error");
      }

      const { userInfo, tokens } = googleResult;
      const now = new Date();

      // Check if this Google account is already linked to another user
      const existingOAuthAccount = await ctx.db
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "google"),
            eq(oauthAccounts.providerAccountId, userInfo.sub)
          )
        )
        .limit(1);

      if (existingOAuthAccount.length > 0) {
        throw errors.oauthCallbackFailed("This Google account is already linked to another user");
      }

      // Link the OAuth account to the current user
      await ctx.db.insert(oauthAccounts).values({
        id: generateUuidv7(),
        userId,
        provider: "google",
        providerAccountId: userInfo.sub,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt ?? null,
        createdAt: now,
      });

      return { success: true };
    }),

  /**
   * Link Apple OAuth to existing account.
   *
   * Similar to appleCallback but requires the user to be authenticated
   * and links the OAuth account to the current user rather than creating
   * a new account or finding an existing one.
   *
   * @param code - The authorization code from Apple
   * @param state - The state parameter (must match the one from appleAuthUrl)
   * @param user - Optional user data (only sent on first authorization)
   * @returns Success status
   */
  linkApple: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/auth/link/apple",
        tags: ["Auth"],
        summary: "Link Apple OAuth to existing account",
      },
    })
    .input(
      z.object({
        code: z.string().min(1, "Authorization code is required"),
        state: z.string().min(1, "State parameter is required"),
        user: z
          .union([
            z.string(),
            z.object({
              name: z
                .object({
                  firstName: z.string().optional(),
                  lastName: z.string().optional(),
                })
                .optional(),
              email: z.string().optional(),
            }),
          ])
          .optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { code, state, user: userDataInput } = input;
      const userId = ctx.session.user.id;

      if (!isAppleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Apple");
      }

      // Check if user already has an Apple account linked
      const existingLink = await ctx.db
        .select({ id: oauthAccounts.id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "apple")))
        .limit(1);

      if (existingLink.length > 0) {
        throw errors.oauthAlreadyLinked("Apple");
      }

      // Validate the OAuth callback
      let appleResult;
      try {
        appleResult = await validateAppleCallback(code, state, userDataInput);
      } catch (error) {
        if (error instanceof Error) {
          if (error.message.includes("Invalid or expired OAuth state")) {
            throw errors.oauthStateInvalid();
          }
          throw errors.oauthCallbackFailed(error.message);
        }
        throw errors.oauthCallbackFailed("Unknown error");
      }

      const { userInfo, tokens } = appleResult;
      const now = new Date();

      // Check if this Apple account is already linked to another user
      const existingOAuthAccount = await ctx.db
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "apple"),
            eq(oauthAccounts.providerAccountId, userInfo.sub)
          )
        )
        .limit(1);

      if (existingOAuthAccount.length > 0) {
        throw errors.oauthCallbackFailed("This Apple account is already linked to another user");
      }

      // Link the OAuth account to the current user
      await ctx.db.insert(oauthAccounts).values({
        id: generateUuidv7(),
        userId,
        provider: "apple",
        providerAccountId: userInfo.sub,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt: tokens.expiresAt ?? null,
        createdAt: now,
      });

      return { success: true };
    }),

  /**
   * Unlink OAuth provider from account.
   *
   * Removes the OAuth account link from the current user.
   * Will fail if it's the only authentication method (no password set).
   *
   * @param provider - The provider to unlink ('google' or 'apple')
   * @returns Success status
   */
  unlinkProvider: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/v1/auth/link/{provider}",
        tags: ["Auth"],
        summary: "Unlink OAuth provider from account",
      },
    })
    .input(
      z.object({
        provider: z.enum(["google", "apple"]),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const { provider } = input;
      const userId = ctx.session.user.id;

      // Check if user has a password
      const user = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const hasPassword = !!user[0]?.passwordHash;

      // Count linked OAuth accounts
      const linkedAccountsResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, userId));

      const linkedAccountsCount = linkedAccountsResult[0]?.count ?? 0;

      // Prevent unlinking if it's the only auth method
      if (!hasPassword && linkedAccountsCount <= 1) {
        throw errors.cannotUnlinkOnlyAuth();
      }

      // Find and delete the OAuth account
      const oauthAccount = await ctx.db
        .select({ id: oauthAccounts.id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider)))
        .limit(1);

      if (oauthAccount.length === 0) {
        throw errors.notFound(`${provider} account`);
      }

      await ctx.db.delete(oauthAccounts).where(eq(oauthAccounts.id, oauthAccount[0].id));

      return { success: true };
    }),
});
