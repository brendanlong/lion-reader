/**
 * API Tokens Router
 *
 * tRPC endpoints for managing API tokens - create, list, and revoke tokens.
 * Used by the settings page for users to generate tokens for MCP, extensions, etc.
 */

import { z } from "zod";
import { eq, and, isNull, desc } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { createApiToken, API_TOKEN_SCOPES, type ApiTokenScope } from "@/server/auth/api-token";
import { apiTokens } from "@/server/db/schema";

// ============================================================================
// Validation Schemas
// ============================================================================

const apiTokenScopeSchema = z.enum([API_TOKEN_SCOPES.SAVED_WRITE, API_TOKEN_SCOPES.MCP] as const);

const createTokenInputSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(apiTokenScopeSchema).min(1, "At least one scope is required"),
  expiresInDays: z.number().int().positive().optional(),
});

const revokeTokenInputSchema = z.object({
  tokenId: z.string().uuid(),
});

// ============================================================================
// Output Schemas
// ============================================================================

const apiTokenOutputSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  scopes: z.array(z.string()),
  createdAt: z.date(),
  expiresAt: z.date().nullable(),
  lastUsedAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});

const createTokenOutputSchema = z.object({
  token: z.string(), // Raw token - only shown once
  tokenInfo: apiTokenOutputSchema,
});

// ============================================================================
// Shared Select Fields
// ============================================================================

/**
 * Fields to select when returning API token info (excludes the raw token hash).
 */
const apiTokenSelectFields = {
  id: apiTokens.id,
  name: apiTokens.name,
  scopes: apiTokens.scopes,
  createdAt: apiTokens.createdAt,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
  revokedAt: apiTokens.revokedAt,
};

// ============================================================================
// Router
// ============================================================================

export const apiTokensRouter = createTRPCRouter({
  /**
   * List all API tokens for the current user
   */
  list: protectedProcedure.output(z.array(apiTokenOutputSchema)).query(async ({ ctx }) => {
    const tokens = await ctx.db
      .select(apiTokenSelectFields)
      .from(apiTokens)
      .where(eq(apiTokens.userId, ctx.session.user.id))
      .orderBy(desc(apiTokens.createdAt));

    return tokens;
  }),

  /**
   * Create a new API token
   *
   * Returns the raw token - this is the ONLY time it will be visible.
   * The user must copy it immediately.
   */
  create: protectedProcedure
    .input(createTokenInputSchema)
    .output(createTokenOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const { name, scopes, expiresInDays } = input;

      // Calculate expiration date if specified
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      // Create the token
      const token = await createApiToken(
        ctx.session.user.id,
        scopes as ApiTokenScope[],
        name,
        expiresAt
      );

      // Fetch the token info (without the raw token)
      const tokenInfo = await ctx.db
        .select(apiTokenSelectFields)
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, ctx.session.user.id), isNull(apiTokens.revokedAt)))
        .orderBy(desc(apiTokens.createdAt))
        .limit(1);

      if (!tokenInfo[0]) {
        throw new Error("Failed to retrieve created token");
      }

      return {
        token, // Raw token - only shown this once!
        tokenInfo: tokenInfo[0],
      };
    }),

  /**
   * Revoke an API token
   *
   * Sets the revokedAt timestamp, making the token invalid.
   */
  revoke: protectedProcedure
    .input(revokeTokenInputSchema)
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db
        .update(apiTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiTokens.id, input.tokenId),
            eq(apiTokens.userId, ctx.session.user.id), // Ensure user owns this token
            isNull(apiTokens.revokedAt) // Can't revoke already-revoked token
          )
        )
        .returning({ id: apiTokens.id });

      if (result.length === 0) {
        throw new Error("Token not found or already revoked");
      }

      return { success: true };
    }),
});
