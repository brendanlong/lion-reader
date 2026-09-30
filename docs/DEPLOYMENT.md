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

---

## Database Provisioning (Postgres)

Lion Reader uses PostgreSQL for all persistent data. Production runs **unmanaged
Fly Postgres (flex), single node**: `lion-reader-pg`, database `lion_reader`,
`shared-cpu-8x` / 2GB in `sjc`, 10GB volume, PostgreSQL 18. Unmanaged is chosen for
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
  --volume-size 10 \
  --enable-backups
```

**Options explained:**

- `--name`: Name for your Postgres app (must be unique)
- `--region`: Should match your app's `primary_region` in `fly.toml`
- `--vm-size`/`--vm-memory`: shared-CPU quotas are pooled per machine, so
  `shared-cpu-8x` gives Postgres a 50%-of-a-core sustained floor (8 vCPUs × 6.25%
  baseline each) with burst to 8 cores — better burst behavior than a dedicated
  `performance-1x` core at similar
  cost. Memory is deliberately modest: the DB is ~5GB on disk but the hot working
  set is small (ran comfortably at 1GB / ~98% cache-hit), so 2GB leaves headroom
  for cache (incl. the search GIN index) and growth. flex sizes `shared_buffers`
  etc. from VM memory **at each boot**, so resizing RAM re-tunes automatically and
  scaling down is safe. Save the superuser password it prints.
- `--initial-cluster-size`: 1 (deliberate — flex multi-node uses repmgr, which has a
  poor failure-mode track record; WAL backups + volume snapshots are the safety net)
- `--volume-size`: 10GB is plenty
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

Lion Reader uses Redis for session caching, rate limiting, and pub/sub for real-time updates.

### Option A: Fly.io Upstash Redis (Recommended)

Fly.io offers managed Upstash Redis:

```bash
flyctl redis create
```

When prompted:

- **Name**: `lion-reader-redis`
- **Region**: Same as your app (e.g., `sjc`)
- **Plan**: Free tier is fine for MVP (100 commands/day limit)
  - For production, choose "Pay-as-you-go" (~$0.20/1M commands)
- **Eviction**: Enable if you want auto-cleanup of old data

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
2. Create a new Redis database
3. Select a region close to your Fly.io region
4. Copy the Redis URL (TLS format recommended)
5. Set the secret:

```bash
flyctl secrets set REDIS_URL="rediss://default:password@your-endpoint.upstash.io:6379"
```

**Note**: Use `rediss://` (with double 's') for TLS connections.

---

## Configuring Secrets

Lion Reader requires several secrets for production.

### 1. Set Application URL (Optional but Recommended)

```bash
flyctl secrets set NEXT_PUBLIC_APP_URL="https://lionreader.com"
```

Replace with your custom domain if you have one.

### Complete Secrets Reference

| Secret                          | Required | Description                                                                 | How to Get                                                                            |
| ------------------------------- | -------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                  | Yes      | Postgres connection string                                                  | Set by `fly postgres attach`                                                          |
| `REDIS_URL`                     | Yes      | Redis/Upstash connection string                                             | From Upstash console or `fly redis create`                                            |
| `NEXT_PUBLIC_APP_URL`           | No       | Public URL for the app                                                      | Your Fly.io URL or custom domain                                                      |
| `ANDROID_APP_CERT_SHA256`       | No       | Android app signing-key SHA-256 fingerprints (comma-separated), for sign-in | `keytool -list -v -keystore <release keystore>`; add Play App Signing's key once used |
| `ANDROID_DEBUG_APP_CERT_SHA256` | No       | Same, for the debug app (`com.lionreader.app.debug`)                        | The private dev keystore (see `kmp/CLAUDE.md`)                                        |

---

## GitHub Actions Setup

The repository includes a CI/CD workflow that deploys to Fly.io **after CI passes on `master`** — it is not a direct push-triggered deploy.

### 1. Generate a Fly.io Deploy Token

```bash
flyctl tokens create deploy -x 999999h
```

This creates a long-lived deploy token. Copy the token value.

### 2. Add Token to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to **Settings** > **Secrets and variables** > **Actions**
3. Click **New repository secret**
4. Name: `FLY_API_TOKEN`
5. Value: Paste the token from step 1
6. Click **Add secret**

### 3. Deploy Workflow

`.github/workflows/deploy.yml` deploys every commit that passes CI on `master`; its comments explain the gating, queueing and checkout. The Bunny CDN in front of the site (`terraform/bunny.tf`) needs no deploy step: it honors origin `Cache-Control`, so our headers decide what it caches (CDN section of `src/server/http/CLAUDE.md`).

### Why HTML and RSC are not CDN-cached

HTML documents and RSC (`?_rsc=`) payloads reference build-specific artifacts — the `/_next/static/chunks/<hash>.js` bundles from the build that produced them — which are gone from the origin after the next deploy (Fly runs one build per release; it does not retain prior builds). A client holding a cached document or payload from an old build would 404 on its chunks, or version-skew against the newer origin, so we keep them off the edge. Note `?_rsc=<hash>` is a **router-state** cache-buster, not a build/deploy id, so it does **not** make an RSC payload safe to shared-cache across deploys — the same route+state hashes identically on both builds.

**Enforcement** (`src/proxy.ts` overriding Next's `s-maxage` on the prerendered public pages) is described in the CDN section of `src/server/http/CLAUDE.md`. It also keeps the maintenance gate (#1318) from being bypassed by an edge-cached page.

If we ever want to cache HTML/RSC, treat it as a fresh design effort: at minimum it needs Next's [`deploymentId`](https://nextjs.org/docs/app/api-reference/config/next-config-js/deploymentId) set, and — for anything cached on the CDN — old builds' assets kept available for as long as a cached response can reference them.

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

2. Add GitHub secrets: `ANDROID_RELEASE_KEYSTORE_BASE64`
   (`base64 -w0 lionreader-upload.jks`), `ANDROID_RELEASE_KEYSTORE_PASSWORD`,
   `ANDROID_RELEASE_KEY_ALIAS` (`upload`), `ANDROID_RELEASE_KEY_PASSWORD`.
3. Set `ANDROID_APP_CERT_SHA256` on the server to the key's SHA-256
   fingerprint, so sign-in works for the GitHub APK. With Play App Signing,
   Play re-signs its installs with Google's key: add that fingerprint too
   (Play Console → Test and release → App integrity), comma-separated.

### Each release

```bash
git tag android-v0.2.0 && git push origin android-v0.2.0
```

For Play, upload the `.aab` from the run's artifact (a new personal developer
account needs a closed test with testers for 14 days before production).

## Ongoing Operations

### Scaling

Both scale commands take `--process-group`; **without it they apply to every
process group**. The app runs three (`app`, `worker`, `discord` — see
[DESIGN.md](DESIGN.md#system-architecture)), sized in `fly.toml` (`app`: 2 CPU / 512MB, `worker`: 1 CPU
/ 512MB, `discord`: 1 CPU / 256MB).

**Increase VM resources** — pass a size at least as large as that group's current one:

```bash
flyctl scale vm shared-cpu-2x --memory 1024 --process-group app
```

**Add more instances** — keep `app` at 2 or more for zero-downtime deploys:

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

**Backups & PITR.** Continuous WAL archiving to Tigris is **enabled** on
`lion-reader-pg` (point-in-time recovery, 7-day window, worst-case RPO ~60s), on
top of daily volume snapshots. The full enable/configure/**restore** runbook —
including PITR restore, the periodic restore drill, and monitoring — lives in
[Fly Postgres operations](fly-postgres-ops.md#backups--point-in-time-recovery-pitr).

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
- **Disk:** 10GB volume; `flyctl volumes extend` when needed. A full volume is an
  outage you have to notice — check the fly-metrics disk panel occasionally.
- **Backups & restore drill:** WAL archiving to Tigris gives PITR; periodically
  restore into a scratch cluster to prove it works. Full procedure in
  [Fly Postgres operations](fly-postgres-ops.md#backups--point-in-time-recovery-pitr).

**Temporarily scaling for expensive migrations:** see "Expensive migrations on production Postgres" in `../migrations/CLAUDE.md`.

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

Two rules apply whatever the zone is hosted on:

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
| Postgres volume | 10GB                    | ~$1.50/month      |
| PG WAL backups  | Tigris (base + WAL)     | ~$1/month         |
| Redis (Upstash) | Pay-as-you-go           | ~$0-5/month       |
| **Total**       |                         | **~$31-37/month** |

Costs vary by usage. Check [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) for current rates.
