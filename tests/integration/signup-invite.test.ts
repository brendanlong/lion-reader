/**
 * Integration tests for invite-based signup (`createUser`).
 *
 * Issue #1447: `invites.used_by_user_id` and `users.invite_id` form a circular,
 * non-deferrable FK pair, so the order of the writes inside the signup
 * transaction is load-bearing — claiming the invite before the user row existed
 * made every invite-only signup fail with a 23503. These tests run against a
 * real Postgres so the constraints are actually enforced.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { db } from "../../src/server/db";
import { users, invites } from "../../src/server/db/schema";
import { createUser } from "../../src/server/auth/signup";
import { generateUuidv7 } from "../../src/lib/uuidv7";

const DAY_MS = 24 * 60 * 60 * 1000;

const createdUserIds: string[] = [];
const createdInviteIds: string[] = [];

let originalAllowed: string | undefined;
let originalPublic: string | undefined;

beforeEach(() => {
  originalAllowed = process.env.ALLOWED_SIGNUP_PROVIDERS;
  originalPublic = process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS;
  // email + google are allowed, but only with an invite.
  process.env.ALLOWED_SIGNUP_PROVIDERS = "email,google";
  delete process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS;
});

afterEach(async () => {
  if (originalAllowed === undefined) delete process.env.ALLOWED_SIGNUP_PROVIDERS;
  else process.env.ALLOWED_SIGNUP_PROVIDERS = originalAllowed;
  if (originalPublic === undefined) delete process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS;
  else process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = originalPublic;

  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds.splice(0)));
  }
  if (createdInviteIds.length > 0) {
    await db.delete(invites).where(inArray(invites.id, createdInviteIds.splice(0)));
  }
});

async function createInvite(options: { expiresAt?: Date; usedAt?: Date } = {}) {
  const id = generateUuidv7();
  const token = `test-invite-${id}`;
  await db.insert(invites).values({
    id,
    token,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 7 * DAY_MS),
    usedAt: options.usedAt ?? null,
  });
  createdInviteIds.push(id);
  return { id, token };
}

/** Runs `createUser` in its own transaction, the way the real signup paths do. */
async function signUp(params: { email: string; inviteToken?: string }) {
  const user = await db.transaction((tx) =>
    createUser(tx, {
      email: params.email,
      passwordHash: "not-a-real-hash",
      emailVerified: false,
      inviteToken: params.inviteToken,
      provider: "email",
    })
  );
  createdUserIds.push(user.userId);
  return user;
}

function appErrorCode(err: unknown): string | undefined {
  if (!(err instanceof TRPCError)) return undefined;
  const cause = err.cause as { code?: string } | undefined;
  return cause?.code;
}

async function expectSignupError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toThrow(TRPCError);
  const err = await promise.catch((e: unknown) => e);
  expect(appErrorCode(err)).toBe(code);
}

async function emailExists(email: string) {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return rows.length > 0;
}

describe("createUser with an invite", () => {
  it("creates the user and claims the invite", async () => {
    const invite = await createInvite();
    const email = `invite-ok-${generateUuidv7()}@example.com`;

    const user = await signUp({ email, inviteToken: invite.token });

    const [inviteRow] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(inviteRow.usedByUserId).toBe(user.userId);
    expect(inviteRow.usedAt).toBeInstanceOf(Date);

    const [userRow] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(userRow.inviteId).toBe(invite.id);
  });

  it("rejects a missing invite token without creating a user", async () => {
    const email = `invite-missing-${generateUuidv7()}@example.com`;
    await expectSignupError(signUp({ email }), "INVITE_REQUIRED");
    expect(await emailExists(email)).toBe(false);
  });

  it("rejects an unknown invite token without creating a user", async () => {
    const email = `invite-unknown-${generateUuidv7()}@example.com`;
    await expectSignupError(
      signUp({ email, inviteToken: "definitely-not-a-real-token" }),
      "INVITE_INVALID"
    );
    expect(await emailExists(email)).toBe(false);
  });

  it("rejects an already-used invite without creating a user", async () => {
    const invite = await createInvite({ usedAt: new Date() });
    const email = `invite-used-${generateUuidv7()}@example.com`;

    await expectSignupError(signUp({ email, inviteToken: invite.token }), "INVITE_ALREADY_USED");
    expect(await emailExists(email)).toBe(false);
  });

  it("rejects an expired invite without creating a user", async () => {
    const invite = await createInvite({ expiresAt: new Date(Date.now() - DAY_MS) });
    const email = `invite-expired-${generateUuidv7()}@example.com`;

    await expectSignupError(signUp({ email, inviteToken: invite.token }), "INVITE_EXPIRED");
    expect(await emailExists(email)).toBe(false);
  });

  it("lets only one of two concurrent signups claim the same invite", async () => {
    const invite = await createInvite();
    const emailA = `invite-race-a-${generateUuidv7()}@example.com`;
    const emailB = `invite-race-b-${generateUuidv7()}@example.com`;

    const results = await Promise.allSettled([
      signUp({ email: emailA, inviteToken: invite.token }),
      signUp({ email: emailB, inviteToken: invite.token }),
    ]);

    const winners = results.filter((r) => r.status === "fulfilled");
    const losers = results.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(appErrorCode((losers[0] as PromiseRejectedResult).reason)).toBe("INVITE_ALREADY_USED");

    // The loser's user insert must have rolled back with its failed claim.
    const [inviteRow] = await db.select().from(invites).where(eq(invites.id, invite.id));
    const survivors = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.email, [emailA, emailB]));
    expect(survivors).toHaveLength(1);
    expect(inviteRow.usedByUserId).toBe(survivors[0].id);
  });

  it("rejects a denied provider without creating a user", async () => {
    process.env.ALLOWED_SIGNUP_PROVIDERS = "google";
    const invite = await createInvite();
    const email = `invite-denied-${generateUuidv7()}@example.com`;

    await expectSignupError(
      signUp({ email, inviteToken: invite.token }),
      "SIGNUP_PROVIDER_NOT_ALLOWED"
    );
    expect(await emailExists(email)).toBe(false);

    const [inviteRow] = await db.select().from(invites).where(eq(invites.id, invite.id));
    expect(inviteRow.usedAt).toBeNull();
  });

  it("ignores invites for a publicly allowed provider", async () => {
    process.env.ALLOWED_PUBLIC_SIGNUP_PROVIDERS = "email";
    const email = `invite-public-${generateUuidv7()}@example.com`;

    const user = await signUp({ email });

    const [userRow] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(userRow.inviteId).toBeNull();
  });
});
