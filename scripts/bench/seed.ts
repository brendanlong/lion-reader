/**
 * Seeds the database benchmark dataset (`pnpm bench:db:seed`): production's
 * shape as of 2026-10-05, with exact row counts for the main tables except
 * collection_entries (see `COLLECTIONS`).
 *
 * The plan (who subscribes to what, how many entries each feed and library
 * has) is computed here from a seeded PRNG; the bulk rows are generated in SQL
 * from it. Every counter is maintained by the production triggers, which fire
 * on the bulk inserts. Destroys all data in the target database, so it refuses
 * to run on one that isn't empty or already a benchmark database.
 *
 * Text: entries draw paragraphs from a pool of 4,000 made-up-word paragraphs
 * (see `vocabulary()`), so full-text search has a realistic term spread. Web
 * entries average ~1.7 KB of cleaned HTML plus a ~2.6 KB raw copy, emails and
 * saved articles two to four times that, so a typical row spills its body and
 * search vector to TOAST. Production's entries average ~13 KB, mostly in a long
 * tail of large bodies that this doesn't reproduce.
 */

import { Client } from "pg";

import {
  ANCHOR,
  COLLECTIONS,
  FIRST_POOL_FEED,
  WEB,
  benchUuid,
  collectionSubscriptionId,
  prng,
  savedFeedId,
  subscriptionId,
  tagId,
  tagName,
  userEmail,
  userId,
  vocabulary,
  webFeedId,
  webFeedUrl,
  webSubscriptionId,
} from "./dataset";

// Production row counts, 2026-10-05. Its feeds then included one per
// collection, which collections no longer have (#1846), so the seed has
// that many fewer.
const TARGET = {
  users: 48,
  feeds: 2_932,
  subscriptions: 1_776,
  entries: 481_197,
  userEntries: 508_971,
};

interface HeavyUser {
  total: number;
  unread: number;
  webSubs: number;
  unsubWebSubs: number;
  emailSubs: number;
  emailEntries: number;
  saved: number;
  starredFrac: number;
  tags: number;
  taggedFrac: number;
}

// The five largest libraries (user_entries, unread) in production.
const HEAVY: HeavyUser[] = [
  { total: 129_627, unread: 129_487, webSubs: 330, unsubWebSubs: 30, emailSubs: 30, emailEntries: 3_000, saved: 1_500, starredFrac: 0.02, tags: 30, taggedFrac: 0.7 },
  { total: 116_497, unread: 53_388, webSubs: 270, unsubWebSubs: 20, emailSubs: 20, emailEntries: 2_000, saved: 400, starredFrac: 0.03, tags: 10, taggedFrac: 0.8 },
  { total: 61_034, unread: 59_071, webSubs: 160, unsubWebSubs: 10, emailSubs: 10, emailEntries: 800, saved: 200, starredFrac: 0.01, tags: 5, taggedFrac: 0.5 },
  { total: 55_342, unread: 55_333, webSubs: 125, unsubWebSubs: 5, emailSubs: 5, emailEntries: 300, saved: 50, starredFrac: 0.005, tags: 5, taggedFrac: 0.5 },
  { total: 32_257, unread: 32_227, webSubs: 105, unsubWebSubs: 5, emailSubs: 5, emailEntries: 300, saved: 50, starredFrac: 0.005, tags: 5, taggedFrac: 0.5 },
]; // prettier-ignore

/** U0's feeds with a fixed size (all their entries are in U0's library). */
const U0_SPECIAL: Array<[feedIdx: number, entries: number]> = [
  [WEB.popular, 1_500],
  [WEB.markAll, 4_000],
  [WEB.mostlyRead, 3_000],
  [WEB.large, 8_000],
  [WEB.mergeSource, 1_500],
];
const MOSTLY_READ_UNREAD = 40;
/** Production U0 has 140 read entries outside the mostly-read feed. */
const U0_OTHER_READ = 140;

/** Fixed sizes of the special feeds: [entries, entries in the current document]. */
const SPECIAL_FEEDS: Record<number, [number, number]> = {
  [WEB.popular]: [2_000, 50],
  [WEB.markAll]: [4_000, 100],
  [WEB.mostlyRead]: [3_000, 50],
  [WEB.large]: [8_000, 100],
  [WEB.mergeSource]: [1_500, 50],
  [WEB.mergeTarget]: [600, 300],
  [WEB.history]: [2_500, 500],
};
/** How many of mergeTarget's current entries republish mergeSource's newest guids. */
const MERGE_OVERLAP = 250;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

interface PlanUser {
  idx: number;
  total: number;
  unreadFrac: number;
  starredFrac: number;
  webSubs: number;
  unsubWebSubs: number;
  emailEntries: number[];
  saved: number;
  tags: number;
  taggedFrac: number;
}

interface PlanFeed {
  id: string;
  kind: "web" | "email" | "saved";
  webIdx: number | null;
  userIdx: number | null;
  n: number;
  current: number;
  spanDays: number;
  url: string | null;
  title: string;
  sender: string | null;
  spamFrac: number;
  guidPrefix: string;
  aliasPrefix: string | null;
  aliasCount: number;
  aliasN: number;
  lastUpdatedMinutesAgo: number;
}

interface PlanSub {
  id: string;
  userIdx: number;
  feedId: string;
  n: number;
  active: boolean;
  unreadFrac: number;
  starredFrac: number;
  tagNumbers: number[];
  customTitle: string | null;
}

/** Splits `total` into integers proportional to `weights`, each at least `min`. */
function apportion(total: number, weights: number[], min = 1): number[] {
  const spare = total - min * weights.length;
  if (spare < 0) throw new Error(`apportion: ${total} < ${min} × ${weights.length}`);
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (spare * w) / sum);
  const out = exact.map((x) => min + Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k++, left--) out[order[k % order.length][1]]++;
  return out;
}

function buildPlan() {
  const rand = prng(20261005);
  const users: PlanUser[] = HEAVY.map((h, idx) => ({
    idx,
    total: h.total,
    unreadFrac:
      idx === 0
        ? 1 - U0_OTHER_READ / (h.total - SPECIAL_FEEDS[WEB.mostlyRead][0])
        : h.unread / h.total,
    starredFrac: h.starredFrac,
    webSubs: h.webSubs,
    unsubWebSubs: h.unsubWebSubs,
    emailEntries: apportion(
      h.emailEntries,
      Array.from({ length: h.emailSubs }, () => 0.2 + rand() ** 2)
    ),
    saved: h.saved,
    tags: h.tags,
    taggedFrac: h.taggedFrac,
  }));

  // The other 43 users share the rest of the subscriptions and user_entries.
  const noiseIdx = Array.from({ length: TARGET.users - HEAVY.length }, (_, i) => i + HEAVY.length);
  const noiseTotals = apportion(
    TARGET.userEntries - HEAVY.reduce((a, h) => a + h.total, 0),
    noiseIdx.map(() => 0.05 + rand() ** 2),
    200
  );
  const emailFeedsSoFar = HEAVY.reduce((a, h) => a + h.emailSubs, 0);
  const collectionCount = Object.keys(COLLECTIONS).length;
  // Email subscriptions: two each for the first 30 noise users.
  const noiseEmailUsers = 30;
  const emailSubsTotal = emailFeedsSoFar + noiseEmailUsers * 2;
  const webSubsTotal = TARGET.subscriptions - emailSubsTotal - collectionCount;
  const noiseWebSubs = apportion(
    webSubsTotal - HEAVY.reduce((a, h) => a + h.webSubs, 0),
    noiseTotals.map((t) => Math.sqrt(t)),
    3
  );
  noiseIdx.forEach((idx, i) => {
    const total = noiseTotals[i];
    const emailSize = () => Math.min(20 + Math.floor(rand() * 60), Math.floor(total * 0.15));
    users.push({
      idx,
      total,
      unreadFrac: 0.2 + rand() * 0.75,
      starredFrac: 0.005 + rand() * 0.025,
      webSubs: noiseWebSubs[i],
      unsubWebSubs: i < 40 ? 1 : 0,
      emailEntries: i < noiseEmailUsers ? [emailSize(), emailSize()] : [],
      saved: i < 20 ? Math.min(10 + Math.floor(rand() * 90), Math.floor(total * 0.1)) : 0,
      tags: i < 16 ? 3 : 0,
      taggedFrac: 0.5,
    });
  });

  const savedUsers = users.filter((u) => u.saved > 0).length;
  const webFeedCount = TARGET.feeds - emailSubsTotal - savedUsers - collectionCount;

  // Subscriptions to the special web feeds; the rest are drawn from the pool.
  const subs: PlanSub[] = [];
  const fixedSubs = new Map<number, Array<[feedIdx: number, n: number]>>();
  fixedSubs.set(0, [...U0_SPECIAL]);
  fixedSubs.set(1, [[WEB.popular, 1_200]]);
  for (const idx of [2, 3, 4]) fixedSubs.set(idx, [[WEB.popular, 800]]);
  for (const u of users.slice(HEAVY.length)) {
    const webTotal = u.total - u.saved - u.emailEntries.reduce((a, b) => a + b, 0);
    const fixed: Array<[number, number]> = [];
    const size = (base: number, spread: number) =>
      Math.max(1, Math.min(base + Math.floor(rand() * spread), Math.floor(webTotal * 0.3)));
    if (u.idx < HEAVY.length + 15) fixed.push([WEB.popular, size(100, 500)]);
    else if (u.idx < HEAVY.length + 18) fixed.push([WEB.mergeTarget, size(50, 250)]);
    else if (u.idx < HEAVY.length + 20) fixed.push([WEB.history, size(50, 250)]);
    fixedSubs.set(u.idx, fixed);
  }

  const poolWeight = (f: number) => (f - FIRST_POOL_FEED + 1) ** -0.8;
  for (const u of users) {
    const fixed = fixedSubs.get(u.idx) ?? [];
    const webTotal = u.total - u.saved - u.emailEntries.reduce((a, b) => a + b, 0);
    const poolCount = u.webSubs - fixed.length;
    // Weighted sampling without replacement (exponential race), favouring low indexes.
    const pool = Array.from({ length: webFeedCount - FIRST_POOL_FEED }, (_, i) => {
      const f = i + FIRST_POOL_FEED;
      return { f, key: -Math.log(1 - rand()) / poolWeight(f) };
    })
      .sort((a, b) => a.key - b.key)
      .slice(0, poolCount)
      .map((p) => p.f);
    const fixedTotal = fixed.reduce((a, [, n]) => a + n, 0);
    const sizes = apportion(
      webTotal - fixedTotal,
      pool.map(() => 0.05 + rand() ** 3)
    );
    const userSubs: PlanSub[] = [
      ...fixed.map(([f, n]) => ({ f, n })),
      ...pool.map((f, i) => ({ f, n: sizes[i] })),
    ].map(({ f, n }) => ({
      id: webSubscriptionId(u.idx, f),
      userIdx: u.idx,
      feedId: webFeedId(f),
      n,
      active: true,
      unreadFrac:
        u.idx === 0 && f === WEB.mostlyRead
          ? MOSTLY_READ_UNREAD / SPECIAL_FEEDS[WEB.mostlyRead][0]
          : u.unreadFrac,
      starredFrac: u.starredFrac,
      tagNumbers: [],
      customTitle: rand() < 0.05 ? `My feed ${f}` : null,
    }));
    // Unsubscribed: the last pool picks (never a special feed).
    for (let k = 0; k < u.unsubWebSubs; k++) userSubs[userSubs.length - 1 - k].active = false;
    subs.push(...userSubs);
  }

  // Web feeds: big enough for their largest subscriber (at least one entry),
  // plus history nobody has.
  const webBase = new Array<number>(webFeedCount).fill(1);
  const feedIdxById = new Map<string, number>();
  for (let f = 0; f < webFeedCount; f++) feedIdxById.set(webFeedId(f), f);
  for (const s of subs) {
    const f = feedIdxById.get(s.feedId)!;
    webBase[f] = Math.max(webBase[f], s.n);
  }
  for (const [f, [n]] of Object.entries(SPECIAL_FEEDS)) {
    if (webBase[Number(f)] > n) throw new Error(`special feed ${f} smaller than a subscriber`);
    webBase[Number(f)] = n;
  }
  const emailTotal = users.reduce((a, u) => a + u.emailEntries.reduce((x, y) => x + y, 0), 0);
  const savedTotal = users.reduce((a, u) => a + u.saved, 0);
  const webEntries = TARGET.entries - emailTotal - savedTotal;
  const growable = webBase.map((_, f) => f).filter((f) => !(f in SPECIAL_FEEDS));
  const extra = apportion(
    webEntries - webBase.reduce((a, b) => a + b, 0),
    growable.map(() => 0.1 + rand() ** 2),
    0
  );
  growable.forEach((f, i) => (webBase[f] += extra[i]));

  const feeds: PlanFeed[] = [];
  for (let f = 0; f < webFeedCount; f++) {
    const n = webBase[f];
    const special = SPECIAL_FEEDS[f];
    feeds.push({
      id: webFeedId(f),
      kind: "web",
      webIdx: f,
      userIdx: null,
      n,
      current: special ? special[1] : Math.min(n, 10 + Math.floor(rand() * 60)),
      spanDays: f === WEB.popular ? 200 : n > 2_000 ? 365 : 30 + rand() * 1_400,
      url: webFeedUrl(f),
      title: `Feed ${f}`,
      sender: null,
      spamFrac: 0,
      guidPrefix: `https://feed-${f}.example.com/p/`,
      aliasPrefix: f === WEB.mergeTarget ? `http://feed-${WEB.mergeSource}.example.com/p/` : null,
      aliasCount: f === WEB.mergeTarget ? MERGE_OVERLAP : 0,
      aliasN: SPECIAL_FEEDS[WEB.mergeSource][0],
      lastUpdatedMinutesAgo:
        f === WEB.history || f === WEB.mergeTarget ? 10 : 15 + Math.floor(rand() * 180),
    });
  }

  for (const u of users) {
    u.emailEntries.forEach((n, k) => {
      const key = `email:${u.idx}:${k}`;
      const id = benchUuid(`feed:${key}`);
      feeds.push({
        id,
        kind: "email",
        webIdx: null,
        userIdx: u.idx,
        n,
        current: 0,
        spanDays: 30 + rand() * 700,
        url: null,
        title: `Newsletter ${u.idx}-${k}`,
        sender: `news${k}@sender-${u.idx}-${k}.example.net`,
        spamFrac: u.idx === 0 && k < 3 ? 0.6 : 0.03,
        guidPrefix: `<msg-${u.idx}-${k}-`,
        aliasPrefix: null,
        aliasCount: 0,
        aliasN: 0,
        lastUpdatedMinutesAgo: 0,
      });
      subs.push({
        id: subscriptionId(u.idx, key),
        userIdx: u.idx,
        feedId: id,
        n,
        active: true,
        unreadFrac: u.unreadFrac,
        starredFrac: u.starredFrac,
        tagNumbers: [],
        customTitle: null,
      });
    });
    if (u.saved > 0) {
      feeds.push({
        id: savedFeedId(u.idx),
        kind: "saved",
        webIdx: null,
        userIdx: u.idx,
        n: u.saved,
        current: 0,
        spanDays: 30 + rand() * 900,
        url: null,
        title: "Saved Articles",
        sender: null,
        spamFrac: 0,
        guidPrefix: `https://site-${u.idx}.example.org/articles/`,
        aliasPrefix: null,
        aliasCount: 0,
        aliasN: 0,
        lastUpdatedMinutesAgo: 0,
      });
    }
  }

  // Tags: each active web/email subscription gets one or two of its user's
  // tags with the user's probability; the special feeds are tagged by hand.
  const handTagged = new Map<string, number[]>([
    [webSubscriptionId(0, WEB.popular), [1]],
    [webSubscriptionId(0, WEB.markAll), [1]],
    [webSubscriptionId(0, WEB.mostlyRead), []],
    [webSubscriptionId(0, WEB.large), [2, 3]],
    [webSubscriptionId(0, WEB.mergeSource), [4]],
  ]);
  for (const s of subs) {
    const u = users[s.userIdx];
    const hand = handTagged.get(s.id);
    if (hand) s.tagNumbers = hand;
    else if (s.active && u.tags > 0 && rand() < u.taggedFrac) {
      const first = 1 + Math.floor(rand() * u.tags);
      const second = 1 + Math.floor(rand() * u.tags);
      s.tagNumbers = rand() < 0.3 && second !== first ? [first, second] : [first];
    }
  }

  return { users, feeds, subs };
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const A = `'${ANCHOR}'::timestamptz`;

const FUNCTIONS = `
CREATE FUNCTION pg_temp.h(k text) RETURNS float8 LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('x' || substr(md5(k), 1, 13))::bit(52)::bigint / 4503599627370496.0 $$;
CREATE FUNCTION pg_temp.uuid7(ts timestamptz, k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT (lpad(to_hex((extract(epoch FROM ts) * 1000)::bigint), 12, '0') || '7'
             || substr(md5(k), 1, 3) || '8' || substr(md5(k), 4, 15))::uuid $$;
`;

const RESET = `
TRUNCATE users, feeds, entries, subscriptions, user_entries, tags, subscription_tags,
  collection_entries, entry_tombstones, jobs RESTART IDENTITY CASCADE;
ALTER SEQUENCE greader_id_seq RESTART;
`;

const PARAGRAPHS = `
CREATE TEMP TABLE bench_para AS
SELECT p AS id, string_agg(bw.word, ' ' ORDER BY w) AS body
FROM generate_series(1, 4000) p
CROSS JOIN LATERAL generate_series(1, 40 + floor(100 * pg_temp.h('pl' || p))::int) w
JOIN bench_word bw ON bw.rank = 1 + floor(5000 * pg_temp.h('p' || p || '.' || w) ^ 3)::int
GROUP BY p;
ALTER TABLE bench_para ADD PRIMARY KEY (id);
`;

// One row per entry to create, without content; ord 1 is a feed's newest.
const ENTRY_PLAN = `
CREATE TEMP TABLE bench_entry AS
SELECT pg_temp.uuid7(t.fetched_at, f.id || ':' || o) AS id,
       f.id AS feed_id, f.kind, o AS ord,
       CASE WHEN f.alias_prefix IS NOT NULL AND o <= f.alias_count
            THEN f.alias_prefix || (f.alias_n - o + 1)
            WHEN f.kind = 'email' THEN f.guid_prefix || (f.n - o + 1) || '@mail.example.net>'
            ELSE f.guid_prefix || (f.n - o + 1) END AS guid,
       CASE WHEN f.kind = 'saved' OR pg_temp.h(f.id || ':' || o || ':np') < 0.03 THEN NULL
            ELSE t.ts END AS published_at,
       t.fetched_at,
       CASE WHEN f.kind <> 'web' THEN NULL
            WHEN o <= f.cur THEN f.last_upd
            ELSE LEAST(t.fetched_at + interval '1 day', f.last_upd - interval '1 hour') END AS last_seen_at,
       f.kind = 'email' AND pg_temp.h(f.id || ':' || o || ':spam') < f.spam_frac AS is_spam,
       CASE f.kind WHEN 'web' THEN 1 + floor(5 * pg_temp.h(f.id || ':' || o || ':k') ^ 2)
                   WHEN 'email' THEN 2 + floor(10 * pg_temp.h(f.id || ':' || o || ':k') ^ 2)
                   ELSE 3 + floor(16 * pg_temp.h(f.id || ':' || o || ':k') ^ 2) END::int AS k
FROM bench_feed f
CROSS JOIN LATERAL generate_series(1, f.n) o
CROSS JOIN LATERAL (
  SELECT f.last_upd - (o - 1 + pg_temp.h(f.id || ':' || o)) * (f.span_days / f.n) * interval '1 day' AS ts
) t0
CROSS JOIN LATERAL (SELECT t0.ts, t0.ts + interval '5 minutes' AS fetched_at) t;
CREATE INDEX ON bench_entry (feed_id, ord);
ANALYZE bench_entry;
`;

// Bulk-loads entries with their secondary indexes dropped and rebuilt (from
// their own definitions) in the same transaction, which is several times
// faster than maintaining them row by row; a failure rolls the drop back.
const ENTRIES = `
BEGIN;
SET LOCAL maintenance_work_mem = '512MB';
CREATE TEMP TABLE bench_entry_index ON COMMIT DROP AS
SELECT indexrelid::regclass::text AS name, pg_get_indexdef(indexrelid) AS def
FROM pg_index i
WHERE indrelid = 'entries'::regclass
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT name FROM bench_entry_index LOOP EXECUTE 'DROP INDEX ' || r.name; END LOOP;
END $$;
INSERT INTO entries (
  id, feed_id, type, guid, url, title, author, content_original, content_cleaned, summary,
  published_at, fetched_at, created_at, updated_at, last_seen_at, content_hash,
  site_name, image_url, spam_score, is_spam, list_unsubscribe_mailto
)
SELECT e.id, e.feed_id, e.kind, e.guid,
       CASE WHEN e.kind = 'email' THEN NULL ELSE replace(e.guid, 'http://', 'https://') END,
       initcap(left(tp.body, 20 + floor(50 * pg_temp.h(e.id::text || ':tl'))::int)),
       CASE WHEN e.kind = 'saved' AND pg_temp.h(e.id::text || ':a') < 0.5 THEN NULL
            ELSE 'Author ' || floor(50 * pg_temp.h(e.id::text || ':a'))::int END,
       '<article class="post"><header>' || tp.body || '</header>' || c.html
         || '<footer><a href="https://example.com/share">Share</a></footer></article>',
       c.html,
       left(c.first, 280),
       e.published_at, e.fetched_at, e.fetched_at, e.fetched_at, e.last_seen_at,
       md5(e.id::text),
       CASE WHEN e.kind = 'saved' THEN 'site-' || floor(200 * pg_temp.h(e.id::text || ':s'))::int || '.example.org' END,
       CASE WHEN e.kind = 'saved' AND pg_temp.h(e.id::text || ':i') < 0.5
            THEN 'https://cdn.example.org/' || e.id || '.jpg' END,
       CASE WHEN e.kind = 'email' THEN
         CASE WHEN e.is_spam THEN 6 + 4 * pg_temp.h(e.id::text || ':ss') ELSE 3 * pg_temp.h(e.id::text || ':ss') END
       END,
       e.is_spam,
       CASE WHEN e.kind = 'email' THEN 'mailto:unsubscribe@' || e.feed_id || '.example.net' END
FROM bench_entry e
CROSS JOIN LATERAL (
  SELECT string_agg('<p>' || p.body || '.</p>', E'\\n' ORDER BY j) AS html,
         (array_agg(p.body ORDER BY j))[1] AS first
  FROM generate_series(1, e.k) j
  JOIN bench_para p ON p.id = 1 + floor(4000 * pg_temp.h(e.id::text || ':' || j))::int
) c
JOIN bench_para tp ON tp.id = 1 + floor(4000 * pg_temp.h(e.id::text || ':t'))::int
ORDER BY e.fetched_at, e.id;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT def FROM bench_entry_index LOOP EXECUTE r.def; END LOOP;
END $$;
COMMIT;
`;

const USER_ENTRIES = `
INSERT INTO user_entries (
  user_id, entry_id, read, starred, subscription_id, is_spam, published_or_fetched_at,
  read_changed_at, starred_changed_at, created_at, updated_at
)
SELECT x.user_id, x.entry_id, x.read, x.starred, x.subscription_id, x.is_spam, x.pof,
       CASE WHEN x.read THEN x.read_at END, x.created_at, x.created_at,
       CASE WHEN x.read THEN GREATEST(x.created_at, x.read_at) ELSE x.created_at END
FROM (
  SELECT s.user_id, e.id AS entry_id, s.id AS subscription_id, e.is_spam,
         COALESCE(e.published_at, e.fetched_at) AS pof,
         pg_temp.h(e.id::text || s.user_id::text) >= s.unread_frac AS read,
         pg_temp.h(s.user_id::text || e.id::text) < s.starred_frac AS starred,
         GREATEST(e.fetched_at + interval '2 minutes', s.subscribed_at) AS created_at,
         LEAST(GREATEST(e.fetched_at + interval '2 minutes', s.subscribed_at)
               + 72 * pg_temp.h(e.id::text || ':r') * interval '1 hour', ${A}) AS read_at
  FROM bench_sub s
  JOIN bench_entry e ON e.feed_id = s.feed_id AND e.ord <= s.n
  UNION ALL
  SELECT f.user_id, e.id, NULL, false, e.fetched_at,
         pg_temp.h(e.id::text || f.user_id::text) >= u.unread_frac,
         pg_temp.h(f.user_id::text || e.id::text) < u.starred_frac,
         e.fetched_at, LEAST(e.fetched_at + 72 * pg_temp.h(e.id::text || ':r') * interval '1 hour', ${A})
  FROM bench_feed f
  JOIN bench_user u ON u.id = f.user_id
  JOIN bench_entry e ON e.feed_id = f.id
  WHERE f.kind = 'saved'
) x
ORDER BY x.user_id, x.pof;
`;

/** Members are picked by hash among the owner's rows of the given kinds. */
function collectionMembers(
  key: string,
  ownerIdx: number,
  picks: Array<{ n: number; where: string }>
): string {
  const sub = collectionSubscriptionId(ownerIdx, key);
  const owner = userId(ownerIdx);
  return picks
    .map(
      ({ n, where }) => `
INSERT INTO collection_entries (subscription_id, user_id, entry_id, created_at)
SELECT '${sub}', ue.user_id, ue.entry_id, ${A} - interval '3 days'
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
LEFT JOIN subscriptions s ON s.id = ue.subscription_id
WHERE ue.user_id = '${owner}' AND ${where}
  AND NOT EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.user_id = ue.user_id AND ce.entry_id = ue.entry_id)
ORDER BY md5(ue.entry_id::text || '${key}')
LIMIT ${n};`
    )
    .join("\n");
}

const activeWeb = "e.type = 'web' AND s.unsubscribed_at IS NULL";
const COLLECTION_ENTRIES = [
  collectionMembers(COLLECTIONS.readingList.key, 0, [
    { n: 35, where: activeWeb },
    // Visible only through the collection: unsubscribed and not starred.
    { n: 5, where: "e.type = 'web' AND s.unsubscribed_at IS NOT NULL AND NOT ue.starred" },
  ]),
  collectionMembers(COLLECTIONS.research.key, 0, [
    { n: 15, where: activeWeb },
    { n: 3, where: "e.type = 'saved'" },
    { n: 2, where: "e.type = 'email' AND NOT e.is_spam" },
  ]),
  collectionMembers(COLLECTIONS.favorites.key, 1, [{ n: 11, where: activeWeb }]),
  collectionMembers(COLLECTIONS.archive.key, 1, [{ n: 1000, where: activeWeb }]),
].join("\n");

const STATS = `
SELECT 'users' AS what, count(*)::int AS n FROM users
UNION ALL SELECT 'feeds', count(*) FROM feeds
UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions
UNION ALL SELECT 'entries', count(*) FROM entries
UNION ALL SELECT 'user_entries', count(*) FROM user_entries
UNION ALL SELECT 'collection_entries', count(*) FROM collection_entries
UNION ALL SELECT 'U0 user_entries', count(*) FROM user_entries WHERE user_id = '${userId(0)}'
UNION ALL SELECT 'U0 unread', count(*) FROM user_entries WHERE user_id = '${userId(0)}' AND NOT read
UNION ALL SELECT 'U1 user_entries', count(*) FROM user_entries WHERE user_id = '${userId(1)}'
UNION ALL SELECT 'U1 unread', count(*) FROM user_entries WHERE user_id = '${userId(1)}' AND NOT read
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (run `pnpm services` first)");
  const force = process.argv.includes("--force");
  const client = new Client({ connectionString: url });
  await client.connect();

  const existing = await client.query<{ users: number; bench: boolean }>(
    `SELECT count(*)::int AS users, bool_or(email = $1) AS bench FROM users`,
    [userEmail(0)]
  );
  const { users: existingUsers, bench } = existing.rows[0];
  if (existingUsers > 0 && !bench && !force) {
    throw new Error(
      `Refusing to seed: the database has ${existingUsers} users and isn't a benchmark database. ` +
        "The seed deletes everything; pass --force if that's what you want."
    );
  }

  const plan = buildPlan();
  const started = Date.now();
  const step = async (label: string, sql: string, params: unknown[] = []): Promise<void> => {
    const t = Date.now();
    await client.query(sql, params);
    console.log(`${label.padEnd(20)} ${((Date.now() - t) / 1000).toFixed(1).padStart(6)} s`);
  };

  await step("functions", FUNCTIONS);
  await step("reset", RESET);
  await step(
    "plan users",
    `CREATE TEMP TABLE bench_user AS
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::float8[], $4::float8[])
       AS t(id, email, unread_frac, starred_frac)`,
    [
      plan.users.map((u) => userId(u.idx)),
      plan.users.map((u) => userEmail(u.idx)),
      plan.users.map((u) => u.unreadFrac),
      plan.users.map((u) => u.starredFrac),
    ]
  );
  await step(
    "vocabulary",
    `CREATE TEMP TABLE bench_word AS
     SELECT ord::int AS rank, word FROM unnest($1::text[]) WITH ORDINALITY AS t(word, ord)`,
    [vocabulary()]
  );
  const f = plan.feeds;
  await step(
    "plan feeds",
    `
CREATE TEMP TABLE bench_feed AS
SELECT t.*, ${A} - t.minutes_ago * interval '1 minute' AS last_upd
FROM unnest($1::uuid[], $2::feed_type[], $3::uuid[], $4::int[], $5::int[], $6::float8[], $7::text[],
            $8::text[], $9::text[], $10::float8[], $11::text[], $12::text[], $13::int[], $14::int[],
            $15::int[], $16::int[])
  AS t(id, kind, user_id, n, cur, span_days, url, title, sender, spam_frac, guid_prefix,
       alias_prefix, alias_count, alias_n, minutes_ago, web_idx)
`,
    [
      f.map((x) => x.id),
      f.map((x) => x.kind),
      f.map((x) => (x.userIdx === null ? null : userId(x.userIdx))),
      f.map((x) => x.n),
      f.map((x) => x.current),
      f.map((x) => x.spanDays),
      f.map((x) => x.url),
      f.map((x) => x.title),
      f.map((x) => x.sender),
      f.map((x) => x.spamFrac),
      f.map((x) => x.guidPrefix),
      f.map((x) => x.aliasPrefix),
      f.map((x) => x.aliasCount),
      f.map((x) => x.aliasN),
      f.map((x) => x.lastUpdatedMinutesAgo),
      f.map((x) => x.webIdx),
    ]
  );
  const s = plan.subs;
  await step(
    "plan subscriptions",
    `
CREATE TEMP TABLE bench_sub AS
SELECT t.*, ${A} - (800 + 200 * pg_temp.h(t.id::text)) * interval '1 day' AS subscribed_at
FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::int[], $5::bool[], $6::float8[], $7::float8[], $8::text[])
  AS t(id, user_id, feed_id, n, active, unread_frac, starred_frac, custom_title)
`,
    [
      s.map((x) => x.id),
      s.map((x) => userId(x.userIdx)),
      s.map((x) => x.feedId),
      s.map((x) => x.n),
      s.map((x) => x.active),
      s.map((x) => x.unreadFrac),
      s.map((x) => x.starredFrac),
      s.map((x) => x.customTitle),
    ]
  );
  await step(
    "plan tagging",
    `CREATE TEMP TABLE bench_sub_tag AS
     SELECT * FROM unnest($1::uuid[], $2::uuid[]) AS t(subscription_id, tag_id)`,
    [
      s.flatMap((x) => x.tagNumbers.map(() => x.id)),
      s.flatMap((x) => x.tagNumbers.map((n) => tagId(x.userIdx, n))),
    ]
  );

  await step(
    "users",
    `INSERT INTO users (id, email, created_at, updated_at, tos_agreed_at, getting_started_at)
     SELECT id, email, ${A} - interval '900 days', ${A}, ${A} - interval '900 days', ${A} - interval '900 days'
     FROM bench_user ORDER BY email`
  );
  await step(
    "feeds",
    `INSERT INTO feeds (id, type, url, title, site_url, user_id, email_sender_pattern,
                        last_fetched_at, last_entries_updated_at, next_fetch_at, created_at, updated_at)
     SELECT id, kind, url, title, replace(url, '/rss', ''), user_id, sender,
            CASE WHEN kind = 'web' THEN last_upd END, CASE WHEN kind = 'web' THEN last_upd END,
            CASE WHEN kind = 'web' THEN last_upd + interval '1 hour' END,
            ${A} - interval '1000 days', ${A}
     FROM bench_feed ORDER BY kind, web_idx, id`
  );
  await step("paragraphs", PARAGRAPHS);
  await step("entry plan", ENTRY_PLAN);
  await step("entries", ENTRIES);
  await step(
    "subscriptions",
    `INSERT INTO subscriptions (id, user_id, feed_id, type, custom_title, subscribed_at, created_at, updated_at)
     SELECT s.id, s.user_id, s.feed_id, f.kind, s.custom_title, s.subscribed_at, s.subscribed_at, s.subscribed_at
     FROM bench_sub s JOIN bench_feed f ON f.id = s.feed_id ORDER BY s.subscribed_at, s.id`
  );
  const tagRows = plan.users.flatMap((u) =>
    Array.from({ length: u.tags }, (_, k) => [tagId(u.idx, k + 1), userId(u.idx), tagName(k + 1)])
  );
  await step(
    "tags",
    `INSERT INTO tags (id, user_id, name, created_at, updated_at)
     SELECT id, user_id, name, ${A} - interval '700 days', ${A} - interval '700 days'
     FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS t(id, user_id, name)`,
    [tagRows.map((r) => r[0]), tagRows.map((r) => r[1]), tagRows.map((r) => r[2])]
  );
  await step(
    "subscription tags",
    `INSERT INTO subscription_tags (subscription_id, tag_id, created_at)
     SELECT subscription_id, tag_id, ${A} - interval '700 days' FROM bench_sub_tag`
  );
  await step("user_entries", USER_ENTRIES);
  await step(
    "collections",
    `INSERT INTO subscriptions (id, user_id, type, custom_title, subscribed_at, created_at, updated_at)
     SELECT v.sub, v.user_id, 'collection', v.title, ${A} - interval '30 days', ${A} - interval '30 days', ${A} - interval '30 days'
     FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS v(sub, user_id, title)`,
    [
      Object.values(COLLECTIONS).map((c) => collectionSubscriptionId(c.userIdx, c.key)),
      Object.values(COLLECTIONS).map((c) => userId(c.userIdx)),
      Object.values(COLLECTIONS).map((c) => c.title),
    ]
  );
  await step(
    "collection tag",
    `INSERT INTO subscription_tags (subscription_id, tag_id) VALUES ($1, $2)`,
    [collectionSubscriptionId(0, COLLECTIONS.research.key), tagId(0, 1)]
  );
  await step(
    "unsubscribes",
    `UPDATE subscriptions s
     SET unsubscribed_at = ${A} - (10 + 300 * pg_temp.h(s.id::text || ':u')) * interval '1 day',
         updated_at = ${A} - (10 + 300 * pg_temp.h(s.id::text || ':u')) * interval '1 day'
     FROM bench_sub b WHERE b.id = s.id AND NOT b.active`
  );
  await step("collection members", COLLECTION_ENTRIES);
  await step(
    "feed jobs",
    `INSERT INTO jobs (id, type, payload, next_run_at, created_at, updated_at)
     SELECT pg_temp.uuid7(${A} - interval '900 days', 'job:' || f.id), 'fetch_feed',
            jsonb_build_object('feedId', f.id), f.last_upd + interval '1 hour',
            ${A} - interval '900 days', f.last_upd
     FROM bench_feed f
     WHERE f.kind = 'web' AND EXISTS (SELECT 1 FROM bench_sub s WHERE s.feed_id = f.id AND s.active)`
  );
  await step("vacuum analyze", "VACUUM (ANALYZE)");

  const stats = await client.query<{ what: string; n: number }>(STATS);
  console.log(`\nSeeded in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  for (const row of stats.rows) console.log(`${row.what.padEnd(22)} ${row.n}`);
  const size = await client.query<{ size: string }>(
    "SELECT pg_size_pretty(pg_database_size(current_database())) AS size"
  );
  console.log(`database size          ${size.rows[0].size}`);
  await client.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
