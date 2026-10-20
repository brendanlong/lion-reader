import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { bundleOptions } from "../../scripts/build-backup-health-worker.mjs";
import {
  MAX_BACKUP_AGE_MS,
  SUBREQUEST_LIMIT,
  assessBackups,
  groupBackups,
  parseBackupListPage,
  type Backup,
  type Env,
} from "../../terraform/backup-health/check";

const NOW = new Date("2026-08-15T12:00:00Z");
const PREFIX = "lion-reader-pg/base/";

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function listingXml(
  objects: { key: string; lastModified: Date }[],
  extra = "<IsTruncated>false</IsTruncated>"
): string {
  const contents = objects
    .map(
      (o) =>
        `<Contents><Key>${PREFIX}${o.key}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><Size>1</Size></Contents>`
    )
    .join("");
  return `<ListBucketResult>${extra}${contents}</ListBucketResult>`;
}

describe("parseBackupListPage", () => {
  it("reads a single Contents element and a truncated page's token", () => {
    const xml = listingXml(
      [{ key: "20260801T013354/data.tar", lastModified: hoursAgo(1) }],
      "<IsTruncated>true</IsTruncated><NextContinuationToken>12345678901234567890</NextContinuationToken>"
    );
    expect(parseBackupListPage(xml, PREFIX)).toEqual({
      objects: [{ path: "20260801T013354/data.tar", lastModified: hoursAgo(1) }],
      nextContinuationToken: "12345678901234567890",
    });
  });

  it("returns nothing for an empty listing", () => {
    expect(parseBackupListPage(listingXml([]), PREFIX)).toEqual({
      objects: [],
      nextContinuationToken: null,
    });
  });

  it.each([
    [
      "is cut off mid-document",
      `<ListBucketResult><Contents><Key>${PREFIX}a/data.tar</Key></Contents>`,
    ],
    [
      "is truncated with no continuation token",
      "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
    ],
    ["isn't a listing", "<Error><Code>InternalError</Code></Error>"],
    [
      "has an entry with no timestamp",
      `<ListBucketResult><Contents><Key>${PREFIX}a/data.tar</Key></Contents></ListBucketResult>`,
    ],
  ])("throws when the page %s", (_label, xml) => {
    expect(() => parseBackupListPage(xml, PREFIX)).toThrow();
  });
});

describe("groupBackups", () => {
  it("groups files by backup, newest first, finishing at the newest file", () => {
    const backups = groupBackups([
      { path: "20260814T010000/backup.info", lastModified: hoursAgo(30) },
      { path: "20260815T010000/backup.info", lastModified: hoursAgo(10) },
      { path: "20260814T010000/data.tar", lastModified: hoursAgo(31) },
    ]);
    expect(backups).toEqual([
      { id: "20260815T010000", hasData: false, finishedAt: hoursAgo(10) },
      { id: "20260814T010000", hasData: true, finishedAt: hoursAgo(30) },
    ]);
  });

  it.each([
    ["data.tar", true],
    ["data.tar.gz", true],
    ["data.tar.zst", true],
    ["data_0001.tar", false],
    ["16384.tar", false],
    ["backup.info", false],
  ])("counts %s as the data archive: %s", (file, hasData) => {
    expect(groupBackups([{ path: `a/${file}`, lastModified: NOW }])[0].hasData).toBe(hasData);
  });
});

describe("assessBackups", () => {
  function success(finishedAt: Date): Backup {
    return { id: "20260814T010000", hasData: true, finishedAt };
  }

  it("is healthy at exactly the threshold and unhealthy just past it", () => {
    const at = new Date(NOW.getTime() - MAX_BACKUP_AGE_MS);
    expect(assessBackups([success(at)], NOW).healthy).toBe(true);
    const past = new Date(at.getTime() - 1);
    expect(assessBackups([success(past)], NOW).healthy).toBe(false);
  });

  it("reports the real outage shape: one stale success under many failures", () => {
    const failures = Array.from({ length: 20 }, (_, i) => ({
      id: `2026081${i}`,
      hasData: false,
      finishedAt: hoursAgo(i),
    }));
    const { healthy, report } = assessBackups(
      [...failures, { id: "20260801T013354", hasData: true, finishedAt: hoursAgo(340) }],
      NOW
    );
    expect(healthy).toBe(false);
    expect(report).toContain("20260801T013354");
    expect(report).toContain("Failed backups newer than that: 20");
  });

  it.each([
    ["an empty catalog", []],
    ["no backup with data", [{ id: "a", hasData: false, finishedAt: NOW }]],
  ] as const)("fails closed on %s", (_label, backups) => {
    expect(assessBackups([...backups], NOW).healthy).toBe(false);
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

  it("follows continuation tokens and pings success for a recent backup", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const { requests, ping } = await run((url) =>
      url.searchParams.has("continuation-token")
        ? new Response(listingXml([{ key: "20260815T010000/data.tar", lastModified: hoursAgo(1) }]))
        : new Response(
            listingXml(
              [{ key: "20260814T010000/backup.info", lastModified: hoursAgo(40) }],
              "<IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>"
            )
          )
    );
    expect(requests.map((u) => u.searchParams.get("prefix"))).toEqual([PREFIX, PREFIX]);
    expect(ping.url).toBe(env.HEARTBEAT_URL);
  });

  it("stops paging when only the ping's subrequest is left, then pings /fail", async () => {
    const { requests, ping } = await run(
      () =>
        new Response(
          listingXml(
            [],
            "<IsTruncated>true</IsTruncated><NextContinuationToken>more</NextContinuationToken>"
          )
        )
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
