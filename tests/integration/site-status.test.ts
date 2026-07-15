/**
 * Integration tests for the Redis-backed site-status service (announcement
 * banner + maintenance mode). Runs against a real Redis.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import {
  getMaintenance,
  getMaintenanceRaw,
  setMaintenance,
  getAnnouncement,
  getAnnouncementRaw,
  setAnnouncement,
  __resetSiteStatusCacheForTests,
} from "../../src/server/services/site-status";

const MAINTENANCE_KEY = "lion-reader:site-status:maintenance";
const ANNOUNCEMENT_KEY = "lion-reader:site-status:announcement";

let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for site-status integration tests");
  }
  redis = new Redis(redisUrl);
});

afterAll(async () => {
  await redis.del(MAINTENANCE_KEY, ANNOUNCEMENT_KEY);
  await redis.quit();
});

beforeEach(async () => {
  await redis.del(MAINTENANCE_KEY, ANNOUNCEMENT_KEY);
  delete process.env.MAINTENANCE_MODE;
  __resetSiteStatusCacheForTests();
});

describe("maintenance mode", () => {
  it("defaults to disabled when no key exists", async () => {
    expect(await getMaintenanceRaw()).toEqual({ enabled: false, message: "" });
    expect((await getMaintenance()).enabled).toBe(false);
  });

  it("round-trips enabled + message", async () => {
    await setMaintenance({ enabled: true, message: "Migrating the database" });
    const raw = await getMaintenanceRaw();
    expect(raw).toEqual({ enabled: true, message: "Migrating the database" });
    expect(await getMaintenance()).toEqual({ enabled: true, message: "Migrating the database" });
  });

  it("MAINTENANCE_MODE env var forces maintenance on even when Redis says off", async () => {
    await setMaintenance({ enabled: false });
    __resetSiteStatusCacheForTests();
    process.env.MAINTENANCE_MODE = "true";
    expect((await getMaintenance()).enabled).toBe(true);
    // getMaintenanceRaw reflects only the stored flag (no env override).
    expect((await getMaintenanceRaw()).enabled).toBe(false);
  });
});

describe("announcement banner", () => {
  it("returns null when no announcement is set", async () => {
    expect(await getAnnouncement()).toBeNull();
  });

  it("returns null when disabled or empty, even with a message", async () => {
    await setAnnouncement({ enabled: false, message: "Heads up", level: "info" });
    expect(await getAnnouncement()).toBeNull();

    await setAnnouncement({ enabled: true, message: "   ", level: "warning" });
    expect(await getAnnouncement()).toBeNull();
    // ...but the raw config is preserved for the admin form.
    expect(await getAnnouncementRaw()).toEqual({ enabled: true, message: "   ", level: "warning" });
  });

  it("returns the announcement with a stable, message-derived id", async () => {
    await setAnnouncement({ enabled: true, message: "Known issue", level: "warning" });
    const first = await getAnnouncement();
    expect(first).not.toBeNull();
    expect(first?.message).toBe("Known issue");
    expect(first?.level).toBe("warning");

    // Re-saving the same text keeps the same id (a dismiss sticks).
    await setAnnouncement({ enabled: true, message: "Known issue", level: "warning" });
    const second = await getAnnouncement();
    expect(second?.id).toBe(first?.id);
  });

  it("changes the id when the message or level changes (re-shows the banner)", async () => {
    await setAnnouncement({ enabled: true, message: "First", level: "info" });
    const a = await getAnnouncement();

    await setAnnouncement({ enabled: true, message: "Second", level: "info" });
    const b = await getAnnouncement();
    expect(b?.id).not.toBe(a?.id);

    await setAnnouncement({ enabled: true, message: "Second", level: "warning" });
    const c = await getAnnouncement();
    expect(c?.id).not.toBe(b?.id);
  });
});
