/**
 * Auth Router
 *
 * Handles user authentication: registration, login, logout, and OAuth.
 * Session listing and revocation is in users router.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { hashPassword, passwordSchema, verifyEmailPassword } from "@/server/auth/password";

import {
  createTRPCRouter,
  publicProcedure,
  protectedProcedure,
  expensivePublicProcedure,
  expensiveProtectedProcedure,
  scopedUnconfirmedProcedure,
  consumePasswordAttempt,
} from "../trpc";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { errors } from "@/server/errors";
import { users } from "@/server/db/schema";
import { signupConfig, ALL_SIGNUP_PROVIDERS } from "@/server/config/env";
import { createSession, revokeSessionByToken } from "@/server/auth/session";
import { setSessionCookie, clearSessionCookie } from "@/server/auth/session-cookie";
import { setOAuthStateCookie } from "@/server/auth/oauth/state-cookie";
import { extractClientInfo } from "@/server/http/client-ip";
import {
  getEnabledProviders,
  isProviderEnabled,
  PROVIDER_LABELS,
  type OAuthProviderName,
} from "@/server/auth/oauth/config";
import { createGoogleAuthUrl } from "@/server/auth/oauth/google";
import { startOAuthFlow } from "@/server/auth/oauth/providers";
import { createUser, runPostSignupTasks } from "@/server/auth/signup";
import { unlinkOAuthAccount } from "@/server/services/oauth-accounts";
import { getGoogleDocsGrant } from "@/server/google/tokens";
import {
  DISCORD_BOT_ENABLED,
  DISCORD_BOT_INVITE_URL,
  DISCORD_SERVER_INVITE_URL,
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
 * Registration input schema
 */
const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema(),
  inviteToken: z.string().optional(),
});

/**
 * Login input schema
 */
const loginInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema(),
});

const sessionOutputSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    createdAt: z.date(),
  }),
  sessionToken: z.string(),
});

const authUrlInputSchema = z.object({ inviteToken: z.string().optional() }).optional();

const authUrlOutputSchema = z.object({ url: z.string(), state: z.string() });

/**
 * Start a social sign-in: returns the URL to send the browser to. The provider
 * redirects back to its route handler in `src/app/api/v1/auth/oauth/{provider}/callback`,
 * which finishes sign-in.
 */
function authUrlProcedure(provider: OAuthProviderName) {
  return publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: `/auth/oauth/${provider}`,
        tags: ["Auth"],
        summary: `Get ${PROVIDER_LABELS[provider]} OAuth authorization URL`,
      },
    })
    .input(authUrlInputSchema)
    .output(authUrlOutputSchema)
    .query(({ ctx, input }) =>
      startOAuthFlow(ctx.resHeaders, provider, { inviteToken: input?.inviteToken })
    );
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
    .output(sessionOutputSchema)
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

      const passwordHash = await hashPassword(password);

      const { userAgent, ipAddress } = extractClientInfo(ctx.headers);

      // Create user and session in a transaction
      const result = await ctx.db.transaction(async (tx) => {
        // Create user (handles invite validation and provider restriction atomically)
        const user = await createUser(tx, {
          email,
          passwordHash,
          emailVerified: false,
          inviteToken,
          provider: "email",
        });

        // Create session
        const { token } = await createSession(tx, {
          userId: user.userId,
          userAgent,
          ipAddress,
        });

        return { user, token };
      });

      // Announcement-feed subscription + Getting Started article (fire-and-forget,
      // errors are caught internally)
      void runPostSignupTasks(ctx.db, result.user.userId);

      // Set the httpOnly session cookie for the browser (the returned sessionToken
      // stays in the body for REST/OpenAPI clients that read it directly).
      setSessionCookie(ctx.resHeaders, result.token);

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
    .output(sessionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const { email, password } = input;

      // Per-account limit (in addition to the per-IP `expensivePublicProcedure`
      // middleware): throttles distributed, IP-rotating brute-force against a
      // single account. Shared with the Google Reader and Wallabag password
      // paths. Checked before the user lookup so attempts against non-existent
      // accounts are throttled identically (no enumeration side channel).
      await consumePasswordAttempt(email);

      // Same error for a missing user, a passwordless one and a wrong password,
      // and the same argon2 cost for each (no enumeration oracle, #1267).
      const login = await verifyEmailPassword(ctx.db, email, password);
      if (!login.valid) {
        throw errors.invalidCredentials();
      }
      const foundUser = login.user;

      const { userAgent, ipAddress } = extractClientInfo(ctx.headers);

      // Create new session
      const { token } = await createSession(ctx.db, {
        userId: foundUser.id,
        userAgent,
        ipAddress,
      });

      // Set the httpOnly session cookie for the browser (the returned sessionToken
      // stays in the body for REST/OpenAPI clients that read it directly).
      setSessionCookie(ctx.resHeaders, token);

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

  googleAuthUrl: authUrlProcedure("google"),
  appleAuthUrl: authUrlProcedure("apple"),
  discordAuthUrl: authUrlProcedure("discord"),

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
        serverInviteUrl: z.string().nullable(),
        saveEmoji: z.string().nullable(),
        successEmoji: z.string().nullable(),
        errorEmoji: z.string().nullable(),
      })
    )
    .query(() => {
      return {
        enabled: DISCORD_BOT_ENABLED,
        inviteUrl: DISCORD_BOT_INVITE_URL,
        serverInviteUrl: DISCORD_BOT_ENABLED ? DISCORD_SERVER_INVITE_URL : null,
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
        /** True when no provider can sign up publicly (an invite is required for any signup). */
        requiresInvite: z.boolean(),
        /** Providers allowed with a valid invite. */
        allowedSignupProviders: z.array(z.enum(ALL_SIGNUP_PROVIDERS)),
        /** Providers allowed without an invite (subset of allowedSignupProviders). */
        publicSignupProviders: z.array(z.enum(ALL_SIGNUP_PROVIDERS)),
        /**
         * True when this instance restricts EU users (EU_RESTRICTED=true): the
         * signup flow requires the not-in-the-EU certification and the register
         * page shows a notice that the service is not available in the EU.
         */
        euRestricted: z.boolean(),
      })
    )
    .query(() => {
      const publicSignupProviders = [...signupConfig.publicSignupProviders];
      return {
        requiresInvite: publicSignupProviders.length === 0,
        allowedSignupProviders: [...signupConfig.allowedSignupProviders],
        publicSignupProviders,
        euRestricted: signupConfig.euRestricted,
      };
    }),

  /**
   * Get the current authenticated user.
   *
   * Returns the profile of the signed-in user: a browser session's, or the
   * native app token's owner.
   */
  // The native app reads this to learn which account its token belongs to.
  me: scopedUnconfirmedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS)
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
          tosAgreedAt: z.date().nullable(),
          privacyPolicyAgreedAt: z.date().nullable(),
          notEuAgreedAt: z.date().nullable(),
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
          tosAgreedAt: user.tosAgreedAt,
          privacyPolicyAgreedAt: user.privacyPolicyAgreedAt,
          notEuAgreedAt: user.notEuAgreedAt,
          createdAt: user.createdAt,
        },
      };
    }),

  /**
   * Confirm signup by accepting Terms of Service, Privacy Policy, and — on
   * EU-restricted instances (EU_RESTRICTED=true) — the not-in-the-EU check.
   *
   * ToS and Privacy Policy are always required. The EU certification is only
   * required when the instance is EU-restricted; otherwise `confirmedNotInEu`
   * is ignored and `notEuAgreedAt` is left unset. This sets the individual
   * agreement timestamps on the user record.
   */
  confirmSignup: protectedProcedure
    .input(
      z.object({
        acceptedTermsOfService: z.literal(true, {
          error: "You must accept the Terms of Service",
        }),
        acceptedPrivacyPolicy: z.literal(true, {
          error: "You must accept the Privacy Policy",
        }),
        // Optional at the schema level so non-EU-restricted instances (where the
        // checkbox isn't shown) can confirm; enforced below only when required.
        confirmedNotInEu: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      const euRestricted = signupConfig.euRestricted;
      if (euRestricted && input.confirmedNotInEu !== true) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You must confirm you are not in the EU",
        });
      }

      await ctx.db
        .update(users)
        .set({
          tosAgreedAt: now,
          privacyPolicyAgreedAt: now,
          notEuAgreedAt: euRestricted ? now : null,
          updatedAt: now,
        })
        .where(eq(users.id, userId));

      // Invalidate session cache so the confirmed state is reflected immediately
      const { invalidateUserSessionCaches } = await import("@/server/auth/session");
      await invalidateUserSessionCaches(userId);

      return { success: true };
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

      // Clear the httpOnly session cookie for the browser.
      clearSessionCookie(ctx.resHeaders);

      return { success: true };
    }),

  /**
   * Start linking a social provider to the signed-in account.
   *
   * The flow records *this* user and session as its link target (see
   * `OAuthLinkTarget`), so the callback attaches the provider account to them
   * instead of picking an account by the provider's email — the two addresses
   * need not match (#1603).
   *
   * A mutation rather than a query because it has effects: it stores per-flow
   * state in Redis and sets the one-time state binding cookie.
   */
  linkAuthUrl: protectedProcedure
    .input(z.object({ provider: z.enum(["google", "apple", "discord"]) }))
    .output(authUrlOutputSchema)
    .mutation(({ ctx, input }) => {
      return startOAuthFlow(ctx.resHeaders, input.provider, {
        link: { userId: ctx.session.user.id, sessionId: ctx.session.session.id },
      });
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
  unlinkProvider: expensiveProtectedProcedure
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
      await unlinkOAuthAccount(ctx.db, {
        userId: ctx.session.user.id,
        provider: input.provider,
        currentSessionId: ctx.session.session.id,
      });

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
    .output(authUrlOutputSchema)
    .mutation(async ({ ctx }) => {
      if (!isProviderEnabled("google")) {
        throw errors.oauthProviderNotConfigured("Google");
      }

      if ((await getGoogleDocsGrant(ctx.session.user.id)).status === "unlinked") {
        throw errors.validation("You must link your Google account before requesting Docs access");
      }

      const result = await createGoogleAuthUrl({
        docsAccess: { userId: ctx.session.user.id, mode: "save" },
      });

      // Bind the state to this browser so the callback can't be replayed against
      // another user (login CSRF, issue #1263).
      setOAuthStateCookie(ctx.resHeaders, result.state);

      return result;
    }),
});
