/**
 * OAuth Grants Router
 *
 * Lets a user see and revoke the OAuth applications they authorized — the
 * user-facing counterpart to the RFC 7009 `/oauth/revoke` endpoint, which
 * authenticates the *client*, not the user.
 *
 * Session-only (the default): `reader:full-access` and MCP tokens must not be
 * able to enumerate or revoke grants, least of all their own.
 */

import { z } from "zod";
import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { listUserConsentGrants, revokeUserConsentGrant } from "@/server/oauth/service";
import { SCOPE_DESCRIPTIONS, type OAuthScope } from "@/server/oauth/utils";

const grantOutputSchema = z.object({
  clientId: z.string(),
  clientName: z.string().nullable(),
  clientHost: z.string().nullable(),
  scopes: z.array(z.object({ name: z.string(), description: z.string() })),
  grantedAt: z.date(),
  lastUsedAt: z.date().nullable(),
});

export const oauthGrantsRouter = createTRPCRouter({
  /**
   * List the applications the current user has authorized.
   */
  list: protectedProcedure.output(z.array(grantOutputSchema)).query(async ({ ctx }) => {
    const grants = await listUserConsentGrants(ctx.session.user.id);

    return grants.map((grant) => ({
      ...grant,
      scopes: grant.scopes.map((scope) => ({
        name: scope,
        description: SCOPE_DESCRIPTIONS[scope as OAuthScope] ?? `Access to ${scope}`,
      })),
    }));
  }),

  /**
   * Revoke an application's access: drops the consent grant and kills its
   * outstanding access/refresh tokens.
   */
  revoke: protectedProcedure
    .input(z.object({ clientId: z.string().min(1) }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const revoked = await revokeUserConsentGrant(ctx.session.user.id, input.clientId);

      if (!revoked) {
        throw errors.notFound("Authorized application");
      }

      return { success: true };
    }),
});
