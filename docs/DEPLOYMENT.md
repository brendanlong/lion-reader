# Lion Reader Deployment Guide

This guide covers deploying Lion Reader to [Fly.io](https://fly.io), including provisioning all required infrastructure.

## Prerequisites

A [Fly.io account](https://fly.io/app/sign-up), [`flyctl`](https://fly.io/docs/flyctl/install/) authenticated with `flyctl auth login`, and the code in a GitHub repository for CI/CD.

---

## Initial Setup

### 1. Initialize the Fly.io App

From the project root directory, run:

```bash
flyctl launch --no-deploy
```

When prompted:

- **App name**: Choose a unique name (e.g., `lion-reader` or `lion-reader-prod`)
- **Region**: Select your preferred region. This project's `fly.toml` uses `sjc` (US West) as `primary_region`; pick the region closest to you (e.g., `iad` for US East, `lhr` for London) and keep Postgres/Redis in the same one. **Keep the app, Postgres, and Redis all in one region** — a split (e.g. app in one region, DB in another) adds a cross-region proxy hop to every query. See [Fly.io Postgres operations](fly-postgres-ops.md) before changing regions.
- **Postgres**: Select "No" (we'll provision this separately for more control)
- **Redis**: Select "No" (we'll use Upstash)

This creates the app on Fly.io and updates your `fly.toml` with the app name.

### 2. Replace lionreader.com's Settings

`fly.toml` is lionreader.com's own deploy config. Change or delete every value commented "lionreader.com only" before your first deploy (set `NEXT_PUBLIC_APP_URL` to your own URL). Left as they are, your instance:

- reports page counts to lionreader.com's GoatCounter (`NEXT_PUBLIC_GOATCOUNTER_URL`; delete it to send none);
- loads its scripts from lionreader.com's CDN (`ASSET_PREFIX`; delete it to serve them yourself);
- hands out newsletter addresses on lionreader.com's mail domain, so newsletters never reach you (`INGEST_EMAIL_DOMAIN`; delete it to turn newsletters off, or set up your own domain as in the README's "Email Newsletter Subscriptions");
- asks every new user to certify they're outside the EU (`EU_RESTRICTED`; delete it);
- names lionreader.com's operator as the contact in every outgoing request's User-Agent (`FETCHER_CONTACT_EMAIL`; set your own or delete it);
- points Sign in with Apple and Discord, the Discord bot's emoji and invite, and object storage at lionreader.com's accounts and buckets (the `APPLE_*`, `DISCORD_*` and `STORAGE_*` values; set your own or delete them).

---

## Database Provisioning (Postgres)

Lion Reader uses PostgreSQL for all persistent data. Production runs **unmanaged
Fly Postgres (flex), single node**: `lion-reader-pg`, database `lion_reader`,
`shared-cpu-8x` / 2GB in `sjc`, 40GB volume, PostgreSQL 18. Unmanaged is chosen for
performance-per-dollar (shared-CPU pooling gives more burst headroom per dollar than
Managed Postgres); the tradeoff is that Fly does **not** support or upgrade unmanaged
clusters, so we own upgrades, backups, and monitoring (see "Operating unmanaged
Postgres" under Ongoing Operations).

### 1. Create a Postgres Cluster

```bash
flyctl postgres create \
  --name lion-reader-pg \
  --region sjc \
  --flex \
  --vm-size shared-cpu-8x \
  --vm-memory 2048 \
  --initial-cluster-size 1 \
  --volume-size 40 \
  --enable-backups
```

**Options explained:**

- `--name`: Name for your Postgres app (must be unique)
- `--region`: Should match your app's `primary_region` in `fly.toml`
- `--vm-size`/`--vm-memory`: shared-CPU quotas are pooled per machine, so
  `shared-cpu-8x` gives Postgres a 50%-of-a-core sustained floor (8 vCPUs × 6.25%
  baseline each) with burst to 8 cores — better burst behavior than a dedicated
  `performance-1x` core at similar
  cost. Memory is deliberately modest: the hot working
  set is small (ran comfortably at 1GB / ~98% cache-hit), so 2GB leaves headroom
  for cache (incl. the search GIN index) and growth. flex sizes `shared_buffers`
  etc. from VM memory **at each boot**, so resizing RAM re-tunes automatically and
  scaling down is safe. Save the superuser password it prints.
- `--initial-cluster-size`: 1 (deliberate — flex multi-node uses repmgr, which has a
  poor failure-mode track record; WAL backups + volume snapshots are the safety net)
- `--volume-size`: at least twice the database's size, since each daily base
  backup needs free space about the size of the database
  ([Volume headroom](fly-postgres-ops.md#volume-headroom-keep-data-under-45))
- `--enable-backups`: creates a Tigris bucket and turns on continuous WAL-based
  backups (point-in-time recovery via `flyctl postgres backup restore`), on top
  of daily volume snapshots. Restore runbook: [Fly Postgres operations](fly-postgres-ops.md#backups--point-in-time-recovery-pitr).

### 2. Attach Postgres to Your App

```bash
flyctl postgres attach lion-reader-pg --app lion-reader
```

This automatically:

- Creates a database user for your app
- Sets the `DATABASE_URL` secret on your app
- Configures network access between your app and database

---

## Redis Provisioning (Upstash)

Lion Reader uses Redis for short-lived state (rate limits, OAuth state), pub/sub for
real-time updates, and the site status ("Site Status" in `src/server/CLAUDE.md`).

### Option A: Fly.io Upstash Redis (Recommended)

Fly.io offers managed Upstash Redis:

```bash
flyctl redis create
```

When prompted:

- **Name**: `lion-reader-redis`
- **Region**: Same as your app (e.g., `sjc`)
- **Plan**: Pay-as-you-go
- **Eviction**: Disabled. The announcement banner and maintenance mode are
  stored in Redis with no expiry, so eviction could silently drop them.

After creation, attach it to your app:

```bash
flyctl redis connect
```

Copy the connection string and set it as a secret:

```bash
flyctl secrets set REDIS_URL="redis://default:password@fly-lion-reader-redis.upstash.io:6379"
```

### Option B: Upstash Console (Alternative)

1. Go to [console.upstash.com](https://console.upstash.com)
2. Create a new Redis database, with eviction off (see above)
3. Select a region close to your Fly.io region
4. Copy the Redis URL (TLS format recommended)
5. Set the secret:

```bash
flyctl secrets set REDIS_URL="rediss://default:password@your-endpoint.upstash.io:6379"
```

**Note**: Use `rediss://` (with double 's') for TLS connections.

---

## Object Storage

Images in saved articles, uploads and newsletters live in S3-compatible object
storage, and ebook import requires it (without it, images stay inline in the
HTML). Create two buckets (lionreader.com's are Tigris, in
`terraform/tigris.tf`):

- a publicly readable one (`STORAGE_BUCKET`, served from `STORAGE_PUBLIC_URL_BASE`);
- a private one (`STORAGE_ARCHIVE_BUCKET`) for article HTML we keep but never
  serve. **It must not be publicly readable**: its keys are guessable.

Set the `STORAGE_*` variables as `.env.example` describes.

---

## Configuring Secrets

`.env.example` describes each setting, optional ones included (AI, sign-in
providers, newsletters, limits). The secrets this guide sets:

| Secret                          | Required | Description                                                                 | How to Get                                                                            |
| ------------------------------- | -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | Yes      | Postgres connection string                                                  | Set by `fly postgres attach`                                                          |
| `REDIS_URL`                     | Yes      | Redis/Upstash connection string                                             | From Upstash console or `fly redis create`                                            |
| `ANDROID_APP_CERT_SHA256`       | No       | Android app signing-key SHA-256 fingerprints (comma-separated), for sign-in | `keytool -list -v -keystore <release keystore>`; add Play App Signing's key once used |
| `ANDROID_DEBUG_APP_CERT_SHA256` | No       | Same, for the debug app (`com.lionreader.app.debug`)                        | The private dev keystore (see `docs/android-dev.md`)                                  |

---

## GitHub Actions Setup

The repository includes a CI/CD workflow that deploys to Fly.io **after CI passes on `master`** — it is not a direct push-triggered deploy.

### 1. Generate a Fly.io Deploy Token

```bash
flyctl tokens create deploy -x 999999h
```

This creates a long-lived deploy token. Copy the token value.

### 2. Add Token to the `production` Environment

The deploy job runs in the `production` environment, so the token is an environment secret, not a repository secret: only jobs that name the environment can read it, and the branch rule keeps those to `master`.

1. Go to your GitHub repository
2. Navigate to **Settings** > **Environments** and create (or open) `production`
3. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `master`
4. Under **Environment secrets**, click **Add environment secret**
5. Name: `FLY_API_TOKEN`; Value: paste the token from step 1

### 3. Deploy Workflow

`.github/workflows/deploy.yml` deploys every commit that passes CI on `master`; its comments explain the gating, queueing and checkout. The Bunny CDN in front of the site (`terraform/bunny.tf`) needs no deploy step: it honors origin `Cache-Control`, so our headers decide what it caches (CDN section of `src/server/http/CLAUDE.md`).

### 4. Weekly Release Notes

`.github/workflows/release.yml` drafts each week's GitHub release with Claude. Give it an Anthropic API key as the `ANTHROPIC_API_KEY` secret of a `release-notes` environment limited to `master`, like `production` above.

---

## First Deployment

### 1. Deploy Manually (First Time)

For the first deployment, deploy manually to verify everything works:

```bash
flyctl deploy
```

This will:

1. Build the Docker image on Fly.io's remote builders
2. Run database migrations (via `release_command` in `fly.toml`)
3. Start your application
4. Run health checks

### 2. Monitor the Deployment

```bash
# Watch logs during deployment
flyctl logs

# Check deployment status
flyctl status
```

### 3. Verify App is Running

```bash
# Open the app in your browser
flyctl open

# Or check the health endpoint
curl https://lionreader.com/api/health
```

Expected response (see `src/app/api/health/route.ts`):

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T12:00:00.000Z",
  "version": "1.2.3",
  "checks": {
    "database": { "status": "healthy", "latencyMs": 3 },
    "redis": { "status": "healthy", "latencyMs": 1 }
  }
}
```

`status` is `healthy` when both the `database` and `redis` checks pass, `degraded`
when one is down (still HTTP 200), or `unhealthy` when both are down (HTTP 503). A
failing component reports `status: "unhealthy"` with an `error` message.

---

## Android app releases

The app releases on its own tags, `android-vX.Y.Z`, through
`.github/workflows/android-release.yml`. That builds the signed app bundle and
APK (shrunk with R8), attaches the APK to a GitHub release (not marked
latest, which stays the weekly server release), and keeps the bundle, the R8
mapping and the signing certificate as a workflow artifact. The version name is
the tag's, and the version code is `X*1000000 + Y*1000 + Z`, so every release
must be higher than the last.

### One-time setup

1. Create the upload key, and keep the keystore and its passwords somewhere
   safe (Play can reset a lost upload key, but GitHub APK installs couldn't update
   in place):

   ```bash
   keytool -genkeypair -v -keystore lionreader-upload.jks -alias upload \
     -keyalg RSA -keysize 4096 -validity 10000
   keytool -list -v -keystore lionreader-upload.jks -alias upload   # SHA256 line
   ```

2. Create an `android-release` environment (**Settings** > **Environments**)
   with yourself as a required reviewer, so no run can use the key until you
   approve it, and deployment branches and tags limited to `master` and the
   tag pattern `android-v*`. A leaked key lets anyone sign updates that every
   GitHub install accepts. Add its environment secrets:
   `ANDROID_RELEASE_KEYSTORE_BASE64` (`base64 -w0 lionreader-upload.jks`) and
   `ANDROID_RELEASE_KEYSTORE_PASSWORD`.
3. Set `ANDROID_APP_CERT_SHA256` on the server (see the table above) to the
   upload key's fingerprint, and, once Play App Signing is on, Play's key's
   (Play Console → Test and release → App integrity). The two builds are
   signed differently, so a GitHub install and a Play install can't update
   each other.

### Each release

```bash
git tag android-v0.2.0 && git push origin android-v0.2.0
```

or run the **Android Release** workflow by hand on master (Actions → Android
Release → Run workflow) with the version, e.g. `0.2.0`: it tags master's head
with the release, after checking the version is higher than the last one
(Play refuses anything else).

For Play, upload the `.aab` from the run's artifact (a new personal developer
account needs a closed test with testers for 14 days before production).

### Trying R8 on a device

CI builds the release variant on every pull request, so R8 errors show up
early, but missing keep rules only fail at run time. To try R8 on a device
against a dev server, add a throwaway build type (not committed) with release's
R8 and the debug app's identity, so it installs over the debug app and can
reach http:

```kotlin
create("r8test") {
    initWith(getByName("release"))
    applicationIdSuffix = ".debug"
    signingConfig = devSigning
    matchingFallbacks += listOf("release")
}
// after buildTypes:
sourceSets.getByName("r8test").manifest.srcFile("src/debug/AndroidManifest.xml")
```

then `./gradlew :androidApp:assembleR8test` from `kmp/`. (Debug builds with R8
turned on don't test it: debuggable builds skip R8's renaming.)

## Ongoing Operations

### Scaling

Both scale commands take `--process-group`; **without it they apply to every
process group**. The app runs three (`app`, `worker`, `discord` — see
[DESIGN.md](DESIGN.md#system-architecture)), sized in `fly.toml`.

**Increase VM resources** — pass a size at least as large as that group's current one:

```bash
flyctl scale vm shared-cpu-2x --memory 1024 --process-group app
```

**Add more instances** (never fewer than 2 `app` machines; see Slow Cold Starts):

```bash
flyctl scale count 3 --process-group app
```

### Slow Cold Starts

The app uses `auto_stop_machines = "stop"`, which stops idle app machines. The first request after an idle period can be slow while a machine wakes.

`fly.toml` already sets `min_machines_running = 2`. **Keep it at 2 or more** — the canary rolling-deploy strategy needs at least two app machines for zero-downtime deploys, so this also keeps a warm machine ready. Do **not** lower it to 1 (that reintroduces cold starts and breaks zero-downtime rollout). If you need more warm capacity, raise the app machine count (see Scaling above).

### Database Maintenance

**Connect to database:**

```bash
# Connect straight to the app database (defaults to the `postgres` admin DB otherwise)
flyctl postgres connect -a lion-reader-pg --database lion_reader
```

### Operating unmanaged Postgres

Fly does not manage this cluster, so these are ours:

- **Watch throttling.** On [fly-metrics.net](https://fly-metrics.net), the
  `lion-reader-pg` CPU dashboard shows burst balance (`fly_instance_cpu_balance`)
  and throttle/steal time. Shared-CPU has a ~50%-of-a-core sustained floor (6.25%
  baseline per vCPU, pooled across the 8) and bursts on a ~500 CPU-second-per-vCPU
  balance; if the balance pins at 0 outside of backups,
  the DB is throttled — upgrade the CPU (see below).
- **Minor version updates:** `flyctl image update -a lion-reader-pg` (restarts the node).
- **Major version upgrades:** dump/restore into a fresh cluster — Fly does not
  upgrade unmanaged clusters.
- **Disk:** keep `/data` under ~45%
  ([Volume headroom](fly-postgres-ops.md#volume-headroom-keep-data-under-45));
  `flyctl volumes extend` when needed, then check with `df -h /data` that the
  filesystem grew too: extending the volume doesn't always resize it. A full
  volume is an outage you have to notice — check the fly-metrics disk panel
  occasionally.
- **Backups & restore drill:** WAL archiving to Tigris gives PITR; periodically
  restore into a scratch cluster to prove it works. Full procedure in
  [Fly Postgres operations](fly-postgres-ops.md#backups--point-in-time-recovery-pitr).

**Temporarily scaling for expensive migrations:** see [Fly Postgres operations](fly-postgres-ops.md#expensive-migrations-temporarily-scale-the-machine).

### Maintenance-mode deploys

A release whose migration the previous release can't run against (`migrations/CLAUDE.md`) ships under maintenance mode. `deploy.yml` deploys every `master` commit once CI passes, so **maintenance goes on before the merge**:

1. Run the release PR's read-only pre-flight queries, if it has any, and note the time and `SELECT pg_current_wal_lsn();` (a point-in-time-recovery target).
2. Turn maintenance on in `/admin` → Status. Within a few seconds the app serves the maintenance page (except the demo, `/admin` and health checks), the worker stops claiming jobs and the Discord bot stops touching the database. Open SSE streams stay up but only re-check their credential (sessions and tokens), and jobs already running finish.
3. Wait for those: `SELECT type, running_since FROM jobs WHERE running_since > now() - interval '20 minutes';` (`STALE_JOB_THRESHOLD_MS`) must return nothing. A handler that hits the worker's 5-minute timeout keeps running until it settles, so a recent `running_since` may still be writing; an older one is a crashed worker's.
4. Merge. The auto-deploy runs the migration in `release_command`, and the new machines start in maintenance. (Or deploy the commit with the workflow's manual `workflow_dispatch` trigger before merging.)
5. Run whatever the release's PR lists (backfills, checks), then turn maintenance off.

**If the migration committed but the new release doesn't come up, stay in maintenance**: fix forward, or run the PR's rollback SQL and deploy the previous release. Never lift maintenance while the previous release runs against the new schema. A rollback is the same procedure with the reverse SQL.

---

## DNS

The zone lives in [`terraform/`](../terraform/README.md), along with the rest of
the third-party infrastructure. Mail is split across a subdomain pair:
SPF/DKIM/DMARC on `app.lionreader.com`, inbound `MX` on `in.app.lionreader.com`
(`INGEST_EMAIL_DOMAIN`).

Certificates: Fly accepts **any one of** an `AAAA` record pointing at the app, an
`_acme-challenge` CNAME, or a `_fly-ownership` TXT as proof of ownership. The apex
is dual-stack and carries no challenge records, so its `AAAA` is what keeps the
certificate renewing.

These rules apply whatever the zone is hosted on:

- **Never put a proxy or CDN in front of a Fly hostname.** It replaces the `AAAA`
  record Fly uses as ownership proof, breaking certificate renewal, and hides the
  client IP from rate limiting and abuse handling. On Cloudflare that means every
  record stays DNS-only ("grey cloud"); `announcements.lionreader.com` is a GitHub
  Pages CNAME with the same constraint, for the same reason.
- **Ignore Cloudflare's dashboard nudges.** It permanently shows "Proxying is
  required for most security and performance features" and recommends adding a
  `www` record. Acting on the first breaks certificate renewal and double-CDNs the
  site, for the reasons above. We have never had a `www` record and nothing links
  to one, so the second is a suggestion, not a defect.
- **Never flatten (or proxy) the `cdn.lionreader.com` CNAME.** Bunny steers to a
  nearby POP via GeoDNS — its nameservers honor EDNS Client Subnet and answer with
  a 35s TTL. Resolving that CNAME centrally and caching the result collapses the
  steering to a single edge chosen from the resolver's vantage point, and the hop
  it saves is usually a cache hit anyway.

---

## Cost Estimate (current production shape, July 2026)

| Resource        | Size                    | Estimated Cost    |
| --------------- | ----------------------- | ----------------- |
| App VMs         | 2× shared-cpu-2x, 512MB | ~$8/month         |
| Worker VM       | shared-cpu-1x, 512MB    | ~$3.50/month      |
| Discord VM      | shared-cpu-1x, 256MB    | ~$2/month         |
| Postgres        | shared-cpu-8x, 2GB      | ~$15.55/month     |
| Postgres volume | 40GB                    | ~$6/month         |
| PG WAL backups  | Tigris (base + WAL)     | ~$1/month         |
| Redis (Upstash) | Pay-as-you-go           | ~$0-5/month       |
| **Total**       |                         | **~$36-41/month** |

Costs vary by usage. Check [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) for current rates.
