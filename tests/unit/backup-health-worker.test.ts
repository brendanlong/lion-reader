import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { bundleOptions } from "../../scripts/build-backup-health-worker.mjs";
import {
  MAX_BACKUP_AGE_MS,
  SUBREQUEST_LIMIT,
  assessBackups,
  parseBackupInfo,
  parseBackupListPage,
  type Env,
  type ScannedBackup,
} from "../../terraform/backup-health/check";

const NOW = new Date("2026-08-15T12:00:00Z");
const PREFIX = "lion-reader-pg/base/";

function done(id: string, endTime: Date): ScannedBackup {
  return { id, info: { status: "DONE", endTime } };
}

function failed(id: string): ScannedBackup {
  return { id, info: { status: "FAILED", endTime: null } };
}

describe("parseBackupInfo", () => {
  it("reads status and a tz-aware end_time with microseconds", () => {
    const info = parseBackupInfo(
      "backup_id=20260801T013354\nstatus=DONE\nend_time=2026-08-01 01:43:04.123456+00:00\n"
    );
    expect(info).toEqual({ status: "DONE", endTime: new Date("2026-08-01T01:43:04.123Z") });
  });

  it.each([
    ["missing", "status=FAILED\n"],
    ["None", "status=FAILED\nend_time=None\n"],
    ["garbage", "status=DONE\nend_time=yesterday\n"],
  ])("treats a %s end_time as unknown", (_label, body) => {
    expect(parseBackupInfo(body).endTime).toBeNull();
  });

  it("maps an unrecognized status to UNKNOWN", () => {
    expect(parseBackupInfo("status=WAITING_FOR_WALS\n").status).toBe("UNKNOWN");
  });
});

describe("parseBackupListPage", () => {
  it("handles a single CommonPrefixes element and a truncated page", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>12345678901234567890</NextContinuationToken>
      <CommonPrefixes><Prefix>${PREFIX}20260801T013354/</Prefix></CommonPrefixes>
    </ListBucketResult>`;
    expect(parseBackupListPage(xml, PREFIX)).toEqual({
      ids: ["20260801T013354"],
      nextContinuationToken: "12345678901234567890",
    });
  });

  it.each([
    [
      "is cut off mid-document",
      `<ListBucketResult><CommonPrefixes><Prefix>${PREFIX}a/</Prefix></CommonPrefixes>`,
    ],
    [
      "is truncated with no continuation token",
      "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
    ],
    ["isn't a listing", "<Error><Code>InternalError</Code></Error>"],
  ])("throws when the page %s", (_label, xml) => {
    expect(() => parseBackupListPage(xml, PREFIX)).toThrow();
  });

  it("returns no IDs for an empty listing", () => {
    const xml = "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>";
    expect(parseBackupListPage(xml, PREFIX)).toEqual({ ids: [], nextContinuationToken: null });
  });
});

describe("assessBackups", () => {
  it("is healthy at exactly the threshold and unhealthy just past it", () => {
    const at = new Date(NOW.getTime() - MAX_BACKUP_AGE_MS);
    expect(assessBackups([done("a", at)], 1, NOW).healthy).toBe(true);
    const past = new Date(at.getTime() - 1);
    expect(assessBackups([done("a", past)], 1, NOW).healthy).toBe(false);
  });

  it("reports the real outage shape: one stale success under many failures", () => {
    const scanned = [
      ...Array.from({ length: 20 }, (_, i) => failed(`2026081${i}`)),
      done("20260801T013354", new Date("2026-08-01T01:43:04Z")),
    ];
    const { healthy, report } = assessBackups(scanned, 118, NOW);
    expect(healthy).toBe(false);
    expect(report).toContain("20260801T013354");
    expect(report).toContain("Failed backups newer than that: 20");
  });

  it.each([
    ["an empty catalog", [] as ScannedBackup[], 0],
    ["no success among those read", [failed("b"), { id: "a", info: null }], 50],
    ["a success with no end_time", [{ id: "a", info: { status: "DONE", endTime: null } }], 1],
  ] as const)("fails closed on %s", (_label, scanned, catalogSize) => {
    expect(assessBackups([...scanned], catalogSize, NOW).healthy).toBe(false);
  });
});

interface BundledWorker {
  scheduled(controller: null, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): void;
}

/** The handler as deployed: the bundle Terraform uploads, built the same way. */
describe("bundled Worker", () => {
  let bundle: Record<string, unknown>;
  let worker: BundledWorker;

  beforeAll(async () => {
    const result = await build({ ...bundleOptions, write: false });
    const code = Buffer.from(result.outputFiles[0].contents).toString("base64");
    bundle = await import(/* @vite-ignore */ `data:text/javascript;base64,${code}`);
    worker = bundle.default as BundledWorker;
  });

  it("exports only the handler, since Workers rejects any other export", () => {
    expect(Object.keys(bundle)).toEqual(["default"]);
  });

  const env: Env = {
    BACKUP_BUCKET_ENDPOINT: "https://storage.test",
    BACKUP_BUCKET: "backups",
    BACKUP_SERVER_NAME: "lion-reader-pg",
    BACKUP_ACCESS_KEY_ID: "key",
    BACKUP_SECRET_ACCESS_KEY: "secret",
    HEARTBEAT_URL: "https://hc-ping.test/uuid",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** Runs the handler against a fake bucket and returns the requested URLs. */
  async function run(
    respond: (url: URL) => Response
  ): Promise<{ requests: URL[]; ping: { url: string; body: string } }> {
    const requests: URL[] = [];
    let ping: { url: string; body: string } | undefined;
    vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.host === "hc-ping.test") {
        ping = { url: request.url, body: await request.text() };
        return new Response("OK");
      }
      requests.push(url);
      return respond(url);
    });
    let pending: Promise<unknown> = Promise.resolve();
    worker.scheduled(null, env, { waitUntil: (p) => (pending = p) });
    await pending;
    return { requests, ping: ping! };
  }

  function listing(ids: string[]): Response {
    const prefixes = ids
      .map((id) => `<CommonPrefixes><Prefix>${PREFIX}${id}/</Prefix></CommonPrefixes>`)
      .join("");
    return new Response(`<ListBucketResult>${prefixes}</ListBucketResult>`);
  }

  it("reads newest first, stops at the first success, and pings success", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString().replace("T", " ");
    const { requests, ping } = await run((url) => {
      if (url.searchParams.has("list-type")) {
        return listing(["20260813T010000", "20260815T010000", "20260814T010000"]);
      }
      if (url.pathname.includes("20260815T010000")) return new Response("status=FAILED\n");
      return new Response(`status=DONE\nend_time=${recent}\n`);
    });
    expect(requests.map((u) => u.pathname)).toEqual([
      "/backups",
      `/backups/${PREFIX}20260815T010000/backup.info`,
      `/backups/${PREFIX}20260814T010000/backup.info`,
    ]);
    expect(ping.url).toBe(env.HEARTBEAT_URL);
  });

  it("reads backups until only the ping's subrequest is left, then pings /fail", async () => {
    const ids = Array.from(
      { length: SUBREQUEST_LIMIT + 5 },
      (_, i) => `id${String(i).padStart(3, "0")}`
    );
    const { requests, ping } = await run((url) =>
      url.searchParams.has("list-type") ? listing(ids) : new Response("status=FAILED\n")
    );
    expect(requests).toHaveLength(SUBREQUEST_LIMIT - 1);
    expect(ping.url).toBe(`${env.HEARTBEAT_URL}/fail`);
  });

  it("pings /fail with the cause when the bucket refuses access", async () => {
    const { ping } = await run(() => new Response("AccessDenied", { status: 403 }));
    expect(ping.url).toBe(`${env.HEARTBEAT_URL}/fail`);
    expect(ping.body).toContain("HTTP 403");
  });
});
