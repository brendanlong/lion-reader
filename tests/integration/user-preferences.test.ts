/**
 * `users.me.updatePreferences` changes only the fields it's given and answers
 * with the stored result.
 */

import { describe, it, expect } from "vitest";
import { createCaller } from "../../src/server/trpc/root";
import { createAuthContext, createTestUser } from "./helpers";

describe("users.me.updatePreferences", () => {
  it("updates the given fields, keeps the omitted ones, and clears on empty or null", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));

    const set = await caller.users["me.updatePreferences"]({
      showSpam: true,
      summarizationModel: "openai:gpt-test",
      narrationModel: "openai:gpt-narrate",
      summarizationMaxWords: 120,
      summarizationPrompt: "Be brief.",
    });
    expect(set).toMatchObject({
      showSpam: true,
      summarizationModel: "openai:gpt-test",
      narrationModel: "openai:gpt-narrate",
      summarizationMaxWords: 120,
      summarizationPrompt: "Be brief.",
    });

    const partial = await caller.users["me.updatePreferences"]({
      summarizationModel: "",
      summarizationMaxWords: null,
    });
    expect(partial).toMatchObject({
      showSpam: true,
      summarizationModel: null,
      narrationModel: "openai:gpt-narrate",
      summarizationMaxWords: null,
      summarizationPrompt: "Be brief.",
    });

    // A new request's session reads the stored preferences.
    const reread = await createCaller(await createAuthContext(userId)).users["me.preferences"]();
    expect(reread).toEqual(partial);
  });
});
