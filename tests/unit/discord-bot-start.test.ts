import { afterEach, describe, expect, it, vi } from "vitest";

/** Imports the bot fresh, since its config is read from the env at import. */
async function startWithEnv(env: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  vi.stubEnv("DISCORD_CLIENT_ID", "");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { startDiscordBot } = await import("@/server/discord/bot");
  return startDiscordBot();
}

describe("startDiscordBot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports the bot disabled without a token", async () => {
    await expect(startWithEnv({})).resolves.toBeNull();
  });

  it("fails rather than reporting itself started when the client ID is missing", async () => {
    await expect(startWithEnv({ DISCORD_BOT_TOKEN: "token" })).rejects.toThrow("DISCORD_CLIENT_ID");
  });
});
