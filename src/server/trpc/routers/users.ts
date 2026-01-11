/**
 * Users Router
 *
 * Handles user profile and session management.
 */

import { z } from "zod";
import * as argon2 from "argon2";
import { eq, and, isNull, gt, desc } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { sessions, users, oauthAccounts } from "@/server/db/schema";
import { revokeSession, invalidateUserSessionCaches } from "@/server/auth";

// ============================================================================
// Schemas
// ============================================================================

/**
 * Session output schema - what we return for a session
 */
const sessionOutputSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.date(),
  lastActiveAt: z.date(),
  expiresAt: z.date(),
  isCurrent: z.boolean(),
});

// ============================================================================
// Router
// ============================================================================

export const usersRouter = createTRPCRouter({
  /**
   * List active sessions for the current user.
   *
   * Returns all non-revoked, non-expired sessions for the authenticated user.
   * Sessions are ordered by last active time (most recent first).
   */
  "me.sessions": protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/users/me/sessions",
        tags: ["Users"],
        summary: "List active sessions",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        sessions: z.array(sessionOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;
      const currentSessionId = ctx.session.session.id;

      // Get all active sessions for this user
      const activeSessions = await ctx.db
        .select({
          id: sessions.id,
          userAgent: sessions.userAgent,
          ipAddress: sessions.ipAddress,
          createdAt: sessions.createdAt,
          lastActiveAt: sessions.lastActiveAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date())
          )
        )
        .orderBy(desc(sessions.lastActiveAt));

      return {
        sessions: activeSessions.map((session) => ({
          ...session,
          isCurrent: session.id === currentSessionId,
        })),
      };
    }),

  /**
   * Revoke a specific session.
   *
   * Revokes a session by its ID. The session must belong to the current user.
   * Cannot revoke the current session (use logout instead).
   */
  "me.revokeSession": protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/users/me/sessions/{sessionId}",
        tags: ["Users"],
        summary: "Revoke a session",
      },
    })
    .input(
      z.object({
        sessionId: z.string().uuid("Invalid session ID"),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const currentSessionId = ctx.session.session.id;
      const { sessionId } = input;

      // Don't allow revoking the current session - use logout instead
      if (sessionId === currentSessionId) {
        throw errors.validation("Cannot revoke current session. Use logout instead.");
      }

      // Verify the session belongs to the current user
      const sessionResult = await ctx.db
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(
          and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt))
        )
        .limit(1);

      if (sessionResult.length === 0) {
        throw errors.notFound("Session");
      }

      // Revoke the session
      await revokeSession(sessionId);

      return { success: true };
    }),

  /**
   * Set password for an OAuth-only account.
   *
   * Only works if the user doesn't already have a password set.
   * This allows OAuth users to add password-based login to their account.
   */
  "me.setPassword": protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/users/me/set-password",
        tags: ["Users"],
        summary: "Set password for OAuth account",
      },
    })
    .input(
      z.object({
        newPassword: z
          .string()
          .min(8, "Password must be at least 8 characters")
          .max(128, "Password must be less than 128 characters"),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { newPassword } = input;

      // Check if user already has a password
      const user = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (user.length === 0) {
        throw errors.notFound("User");
      }

      if (user[0].passwordHash) {
        throw errors.validation("Account already has a password. Use change password instead.");
      }

      // Hash the new password
      const passwordHash = await argon2.hash(newPassword);

      // Set the password
      await ctx.db
        .update(users)
        .set({
          passwordHash,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return { success: true };
    }),

  /**
   * Change password for the current user.
   *
   * Requires the current password for verification before setting a new one.
   */
  "me.changePassword": protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/users/me/change-password",
        tags: ["Users"],
        summary: "Change password",
      },
    })
    .input(
      z.object({
        currentPassword: z.string().min(1, "Current password is required"),
        newPassword: z
          .string()
          .min(8, "New password must be at least 8 characters")
          .max(128, "New password must be less than 128 characters"),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { currentPassword, newPassword } = input;

      // Get the user's current password hash
      const user = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      if (user.length === 0 || !user[0].passwordHash) {
        throw errors.validation("Cannot change password for this account");
      }

      // Verify current password
      const isValidPassword = await argon2.verify(user[0].passwordHash, currentPassword);
      if (!isValidPassword) {
        throw errors.validation("Current password is incorrect");
      }

      // Hash the new password
      const newPasswordHash = await argon2.hash(newPassword);

      // Update the password
      await ctx.db
        .update(users)
        .set({
          passwordHash: newPasswordHash,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));

      return { success: true };
    }),

  /**
   * Get linked OAuth accounts for the current user.
   *
   * Returns a list of OAuth providers that are linked to the user's account.
   */
  "me.linkedAccounts": protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/users/me/linked-accounts",
        tags: ["Users"],
        summary: "Get linked OAuth accounts",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        accounts: z.array(
          z.object({
            provider: z.enum(["google", "apple"]),
            linkedAt: z.date(),
          })
        ),
        hasPassword: z.boolean(),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get linked OAuth accounts
      const linkedAccounts = await ctx.db
        .select({
          provider: oauthAccounts.provider,
          linkedAt: oauthAccounts.createdAt,
        })
        .from(oauthAccounts)
        .where(eq(oauthAccounts.userId, userId))
        .orderBy(oauthAccounts.createdAt);

      // Check if user has a password
      const user = await ctx.db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const hasPassword = !!user[0]?.passwordHash;

      return {
        accounts: linkedAccounts.map((account) => ({
          provider: account.provider as "google" | "apple",
          linkedAt: account.linkedAt,
        })),
        hasPassword,
      };
    }),

  /**
   * Get current user preferences.
   *
   * Returns user preferences including spam visibility setting.
   */
  "me.preferences": protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/users/me/preferences",
        tags: ["Users"],
        summary: "Get user preferences",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        showSpam: z.boolean(),
      })
    )
    .query(async ({ ctx }) => {
      // Return preferences from session (cached from database)
      return {
        showSpam: ctx.session.user.showSpam,
      };
    }),

  /**
   * Update user preferences.
   *
   * Updates preferences and invalidates session cache to reflect changes immediately.
   */
  "me.updatePreferences": protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/users/me/preferences",
        tags: ["Users"],
        summary: "Update user preferences",
      },
    })
    .input(
      z.object({
        showSpam: z.boolean().optional(),
      })
    )
    .output(
      z.object({
        showSpam: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Build update object with only provided fields
      const updateData: { showSpam?: boolean; updatedAt: Date } = {
        updatedAt: new Date(),
      };

      if (input.showSpam !== undefined) {
        updateData.showSpam = input.showSpam;
      }

      // Update user preferences in database
      await ctx.db.update(users).set(updateData).where(eq(users.id, userId));

      // Invalidate all session caches for this user so they get fresh data
      await invalidateUserSessionCaches(userId);

      // Fetch updated preferences to return
      const updatedUser = await ctx.db
        .select({ showSpam: users.showSpam })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      return {
        showSpam: updatedUser[0]?.showSpam ?? false,
      };
    }),
});
