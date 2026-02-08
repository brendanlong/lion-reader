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
import { users, oauthAccounts } from "@/server/db/schema";
import { signupConfig } from "@/server/config/env";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  createSession,
  revokeSessionByToken,
  getEnabledProviders,
  createGoogleAuthUrl,
  validateGoogleCallback,
  isGoogleOAuthEnabled,
  createAppleAuthUrl,
  validateAppleCallback,
  isAppleOAuthEnabled,
  createDiscordAuthUrl,
  validateDiscordCallback,
  isDiscordOAuthEnabled,
  GOOGLE_DOCS_READONLY_SCOPE,
  createUser,
  processOAuthCallback,
} from "@/server/auth";
import { GOOGLE_DRIVE_SCOPE } from "@/server/google/docs";
import {
  DISCORD_BOT_ENABLED,
  DISCORD_BOT_INVITE_URL,
  DISCORD_SAVE_EMOJI,
  DISCORD_SUCCESS_EMOJI,
  DISCORD_ERROR_EMOJI,
} from "@/server/discord/config";

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
  inviteToken: z.string().optional(),
});

/**
 * Login input schema
 */
const loginInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract client info (user agent and IP address) from request headers.
 */
function getClientInfo(headers: Headers): {
  userAgent: string | undefined;
  ipAddress: string | undefined;
} {
  const userAgent = headers.get("user-agent") ?? undefined;
  const ipAddress =
    headers.get("x-forwarded-for")?.split(",")[0].trim() ?? headers.get("x-real-ip") ?? undefined;
  return { userAgent, ipAddress };
}

/**
 * Wrap an OAuth validation function with shared error handling.
 * Catches errors and rethrows as appropriate tRPC errors.
 */
async function validateOAuthCallback<T>(validateFn: () => Promise<T>): Promise<T> {
  try {
    return await validateFn();
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("Invalid or expired OAuth state")) {
        throw errors.oauthStateInvalid();
      }
      throw errors.oauthCallbackFailed(error.message);
    }
    throw errors.oauthCallbackFailed("Unknown error");
  }
}

/**
 * Handle the common post-validation OAuth callback flow:
 * create a session and return the standard response.
 */
async function handleOAuthCallback(
  db: Parameters<typeof createSession>[0],
  headers: Headers,
  oauthResult: { userId: string; email: string; createdAt: Date; isNewUser: boolean }
): Promise<{
  user: { id: string; email: string; createdAt: Date };
  sessionToken: string;
  isNewUser: boolean;
}> {
  const { userAgent, ipAddress } = getClientInfo(headers);

  const { token } = await createSession(db, {
    userId: oauthResult.userId,
    userAgent,
    ipAddress,
  });

  return {
    user: {
      id: oauthResult.userId,
      email: oauthResult.email,
      createdAt: oauthResult.createdAt,
    },
    sessionToken: token,
    isNewUser: oauthResult.isNewUser,
  };
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
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * to prevent abuse.
   */
  register: expensivePublicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/auth/register",
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
      const { email, password, inviteToken } = input;

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

      const { userAgent, ipAddress } = getClientInfo(ctx.headers);

      // Create user and session in a transaction
      const result = await ctx.db.transaction(async (tx) => {
        // Create user (handles invite validation atomically)
        const user = await createUser(tx, {
          email,
          passwordHash,
          emailVerified: false,
          inviteToken,
        });

        // Create session
        const { token } = await createSession(tx, {
          userId: user.userId,
          userAgent,
          ipAddress,
        });

        return { user, token };
      });

      return {
        user: {
          id: result.user.userId,
          email: result.user.email,
          createdAt: result.user.createdAt,
        },
        sessionToken: result.token,
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
        path: "/auth/login",
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

      const { userAgent, ipAddress } = getClientInfo(ctx.headers);

      // Create new session
      const { token } = await createSession(ctx.db, {
        userId: foundUser.id,
        userAgent,
        ipAddress,
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
        path: "/auth/providers",
        tags: ["Auth"],
        summary: "Get enabled OAuth providers",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        providers: z.array(z.enum(["google", "apple", "discord"])),
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
        path: "/auth/oauth/google",
        tags: ["Auth"],
        summary: "Get Google OAuth authorization URL",
      },
    })
    .input(
      z
        .object({
          inviteToken: z.string().optional(),
        })
        .optional()
    )
    .output(
      z.object({
        url: z.string(),
        state: z.string(),
      })
    )
    .query(async ({ input }) => {
      if (!isGoogleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Google");
      }

      const result = await createGoogleAuthUrl(
        undefined, // additionalScopes
        "login", // mode
        undefined, // returnUrl
        input?.inviteToken // inviteToken
      );

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
        path: "/auth/oauth/google/callback",
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

      const googleResult = await validateOAuthCallback(() => validateGoogleCallback(code, state));

      const { userInfo, tokens, scopes, inviteToken } = googleResult;

      const oauthResult = await processOAuthCallback({
        provider: "google",
        providerAccountId: userInfo.sub,
        email: userInfo.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes,
        inviteToken,
      });

      return handleOAuthCallback(ctx.db, ctx.headers, oauthResult);
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
        path: "/auth/oauth/apple",
        tags: ["Auth"],
        summary: "Get Apple OAuth authorization URL",
      },
    })
    .input(
      z
        .object({
          inviteToken: z.string().optional(),
        })
        .optional()
    )
    .output(
      z.object({
        url: z.string(),
        state: z.string(),
      })
    )
    .query(async ({ input }) => {
      if (!isAppleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Apple");
      }

      const result = await createAppleAuthUrl(input?.inviteToken);

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
        path: "/auth/oauth/apple/callback",
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

      const appleResult = await validateOAuthCallback(() =>
        validateAppleCallback(code, state, userDataInput)
      );

      const { userInfo, firstAuthData, tokens, inviteToken } = appleResult;

      // Get email from JWT or first-auth data
      // Apple always includes email in JWT on first auth, may not on subsequent auths
      const email = userInfo.email ?? firstAuthData?.email;

      const oauthResult = await processOAuthCallback({
        provider: "apple",
        providerAccountId: userInfo.sub,
        email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        inviteToken,
      });

      return handleOAuthCallback(ctx.db, ctx.headers, oauthResult);
    }),

  /**
   * Generate Discord OAuth authorization URL.
   *
   * Returns a URL to redirect the user to for Discord OAuth login.
   * The state parameter should be stored by the client to verify the callback.
   *
   * Flow:
   * 1. Client calls this endpoint
   * 2. Client stores the returned state (e.g., in localStorage)
   * 3. Client redirects user to the URL
   * 4. After Discord auth, user is redirected to callback URL
   * 5. Client sends code and state to discordCallback endpoint
   */
  discordAuthUrl: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/auth/oauth/discord",
        tags: ["Auth"],
        summary: "Get Discord OAuth authorization URL",
      },
    })
    .input(
      z
        .object({
          inviteToken: z.string().optional(),
        })
        .optional()
    )
    .output(
      z.object({
        url: z.string(),
        state: z.string(),
      })
    )
    .query(async ({ input }) => {
      if (!isDiscordOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Discord");
      }

      const result = await createDiscordAuthUrl(input?.inviteToken);

      return {
        url: result.url,
        state: result.state,
      };
    }),

  /**
   * Handle Discord OAuth callback.
   *
   * Exchanges the authorization code for tokens, retrieves user info,
   * and creates or links a user account.
   *
   * Account Linking Logic:
   * 1. If OAuth account exists: log in as that user
   * 2. If email matches existing user: link OAuth to that account
   * 3. Otherwise: create new user and OAuth account
   *
   * @param code - The authorization code from Discord
   * @param state - The state parameter (must match the one from discordAuthUrl)
   * @returns The user and session token
   */
  discordCallback: expensivePublicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/auth/oauth/discord/callback",
        tags: ["Auth"],
        summary: "Handle Discord OAuth callback",
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

      if (!isDiscordOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Discord");
      }

      const discordResult = await validateOAuthCallback(() => validateDiscordCallback(code, state));

      const { userInfo, tokens, inviteToken } = discordResult;

      const oauthResult = await processOAuthCallback({
        provider: "discord",
        providerAccountId: userInfo.id,
        email: userInfo.email,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        inviteToken,
      });

      return handleOAuthCallback(ctx.db, ctx.headers, oauthResult);
    }),

  /**
   * Get Discord bot configuration.
   *
   * Returns whether the Discord bot is enabled and the invite URL.
   * Used by the settings page to show the bot invite link.
   */
  discordBotConfig: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/auth/discord-bot-config",
        tags: ["Auth"],
        summary: "Get Discord bot configuration",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        enabled: z.boolean(),
        inviteUrl: z.string().nullable(),
        saveEmoji: z.string().nullable(),
        successEmoji: z.string().nullable(),
        errorEmoji: z.string().nullable(),
      })
    )
    .query(() => {
      return {
        enabled: DISCORD_BOT_ENABLED,
        inviteUrl: DISCORD_BOT_INVITE_URL,
        saveEmoji: DISCORD_BOT_ENABLED ? DISCORD_SAVE_EMOJI : null,
        successEmoji: DISCORD_BOT_ENABLED ? DISCORD_SUCCESS_EMOJI : null,
        errorEmoji: DISCORD_BOT_ENABLED ? DISCORD_ERROR_EMOJI : null,
      };
    }),

  /**
   * Get signup configuration.
   *
   * Returns whether signups require an invite token.
   * UI uses this to show/hide signup links and display appropriate messages.
   */
  signupConfig: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/auth/signup-config",
        tags: ["Auth"],
        summary: "Get signup configuration",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        requiresInvite: z.boolean(),
      })
    )
    .query(() => {
      return {
        requiresInvite: !signupConfig.allowAllSignups,
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
        path: "/auth/me",
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
   *
   * This is a public procedure so that logout works even if the session is
   * already expired or invalid. If there's no valid session, this just
   * returns success (the user is already logged out from the server's perspective).
   */
  logout: publicProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/auth/logout",
        tags: ["Auth"],
        summary: "Logout current session",
      },
    })
    .input(z.object({}).optional())
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx }) => {
      // Revoke the current session using the token from context
      // If there's no valid session token, we're already logged out
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
        path: "/auth/link/google",
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

      // Validate the OAuth callback first (need userInfo to check account match)
      const googleResult = await validateOAuthCallback(() => validateGoogleCallback(code, state));

      const { userInfo, tokens, scopes } = googleResult;
      const now = new Date();

      // Check if user already has a Google account linked
      const existingLink = await ctx.db
        .select({
          id: oauthAccounts.id,
          providerAccountId: oauthAccounts.providerAccountId,
        })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")))
        .limit(1);

      if (existingLink.length > 0) {
        // User already has Google linked - this might be incremental authorization
        // (e.g., adding Google Docs scope to existing account)
        if (existingLink[0].providerAccountId !== userInfo.sub) {
          // User is trying to link a different Google account
          throw errors.oauthAlreadyLinked("Google");
        }

        // Same Google account - update with new tokens and scopes (incremental auth)
        await ctx.db
          .update(oauthAccounts)
          .set({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? null,
            expiresAt: tokens.expiresAt ?? null,
            scopes,
          })
          .where(eq(oauthAccounts.id, existingLink[0].id));

        return { success: true };
      }

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
        scopes,
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
        path: "/auth/link/apple",
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

      const appleResult = await validateOAuthCallback(() =>
        validateAppleCallback(code, state, userDataInput)
      );

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
   * Link Discord OAuth to existing account.
   *
   * Similar to discordCallback but requires the user to be authenticated
   * and links the OAuth account to the current user rather than creating
   * a new account or finding an existing one.
   *
   * @param code - The authorization code from Discord
   * @param state - The state parameter (must match the one from discordAuthUrl)
   * @returns Success status
   */
  linkDiscord: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/auth/link/discord",
        tags: ["Auth"],
        summary: "Link Discord OAuth to existing account",
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

      if (!isDiscordOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Discord");
      }

      // Check if user already has a Discord account linked
      const existingLink = await ctx.db
        .select({ id: oauthAccounts.id })
        .from(oauthAccounts)
        .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "discord")))
        .limit(1);

      if (existingLink.length > 0) {
        throw errors.oauthAlreadyLinked("Discord");
      }

      const discordResult = await validateOAuthCallback(() => validateDiscordCallback(code, state));

      const { userInfo, tokens } = discordResult;
      const now = new Date();

      // Check if this Discord account is already linked to another user
      const existingOAuthAccount = await ctx.db
        .select({ userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.provider, "discord"),
            eq(oauthAccounts.providerAccountId, userInfo.id)
          )
        )
        .limit(1);

      if (existingOAuthAccount.length > 0) {
        throw errors.oauthCallbackFailed("This Discord account is already linked to another user");
      }

      // Link the OAuth account to the current user
      await ctx.db.insert(oauthAccounts).values({
        id: generateUuidv7(),
        userId,
        provider: "discord",
        providerAccountId: userInfo.id,
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
   * @param provider - The provider to unlink ('google', 'apple', or 'discord')
   * @returns Success status
   */
  unlinkProvider: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/auth/link/{provider}",
        tags: ["Auth"],
        summary: "Unlink OAuth provider from account",
      },
    })
    .input(
      z.object({
        provider: z.enum(["google", "apple", "discord"]),
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

  /**
   * Request Google Docs access (incremental authorization).
   *
   * Generates a new OAuth URL that includes the Google Docs readonly scope
   * in addition to the existing profile scopes. This allows users to grant
   * access to their Google Docs without re-authenticating.
   *
   * Flow:
   * 1. User tries to save a private Google Doc
   * 2. Backend detects they need Docs permission
   * 3. Frontend calls this endpoint
   * 4. Frontend redirects to the returned URL
   * 5. User grants permission on Google's consent screen
   * 6. OAuth callback updates the scopes in the database
   * 7. User can now save private Google Docs
   *
   * @returns OAuth authorization URL with Google Docs scope
   * @throws If user doesn't have Google OAuth account linked
   */
  requestGoogleDocsAccess: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/auth/request-google-docs-access",
        protect: true,
        summary: "Request Google Docs access",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        url: z.string(),
        state: z.string(),
      })
    )
    .mutation(async ({ ctx }) => {
      if (!isGoogleOAuthEnabled()) {
        throw errors.oauthProviderNotConfigured("Google");
      }

      // Check if user has Google OAuth account linked
      const existingLink = await ctx.db
        .select()
        .from(oauthAccounts)
        .where(
          and(eq(oauthAccounts.userId, ctx.session.user.id), eq(oauthAccounts.provider, "google"))
        )
        .limit(1);

      if (existingLink.length === 0) {
        throw errors.validation("You must link your Google account before requesting Docs access");
      }

      // Create OAuth URL with both scopes needed for Google Docs access:
      // - documents.readonly for native Google Docs via Docs API
      // - drive.readonly for uploaded .docx files via Drive API
      // Pass mode: "save" so the callback knows to redirect back to /save
      const result = await createGoogleAuthUrl(
        [GOOGLE_DOCS_READONLY_SCOPE, GOOGLE_DRIVE_SCOPE],
        "save"
      );

      // Return the URL with a note that this is for incremental auth
      // The state should be stored by the client to verify the callback
      return {
        url: result.url,
        state: result.state,
      };
    }),
});
