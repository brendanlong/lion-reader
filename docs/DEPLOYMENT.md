# Lion Reader Deployment Guide

This guide covers deploying Lion Reader to [Fly.io](https://fly.io), including provisioning all required infrastructure.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Database Provisioning (Postgres)](#database-provisioning-postgres)
4. [Redis Provisioning (Upstash)](#redis-provisioning-upstash)
5. [Configuring Secrets](#configuring-secrets)
6. [GitHub Actions Setup](#github-actions-setup)
7. [First Deployment](#first-deployment)
8. [Verification](#verification)
9. [Ongoing Operations](#ongoing-operations)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before you begin, ensure you have:

### 1. Fly.io Account

Create a free account at [fly.io/app/sign-up](https://fly.io/app/sign-up).

### 2. Fly.io CLI (flyctl)

Install the Fly.io CLI:

```bash
# macOS
brew install flyctl

# Linux
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```

Verify installation:

```bash
flyctl version
```

### 3. Authenticate with Fly.io

```bash
flyctl auth login
```

This will open a browser window for authentication.

### 4. GitHub Repository

Ensure your code is pushed to a GitHub repository for CI/CD.

---

## Initial Setup

### 1. Initialize the Fly.io App

From the project root directory, run:

```bash
flyctl launch --no-deploy
```

When prompted:

- **App name**: Choose a unique name (e.g., `lion-reader` or `lion-reader-prod`)
- **Region**: Select your preferred region. This project's `fly.toml` uses `lax` (US West) as `primary_region`; pick the region closest to you (e.g., `iad` for US East, `lhr` for London) and keep Postgres/Redis in the same one.
- **Postgres**: Select "No" (we'll provision this separately for more control)
- **Redis**: Select "No" (we'll use Upstash)

This creates the app on Fly.io and updates your `fly.toml` with the app name.

### 2. Verify App Creation

```bash
flyctl apps list
```

You should see your new app listed.

---

## Database Provisioning (Postgres)

Lion Reader uses PostgreSQL for all persistent data. Production runs **unmanaged
Fly Postgres (flex), single node** — chosen over Fly Managed Postgres in July 2026
for performance-per-dollar. Fly does **not** support or upgrade unmanaged clusters,
so we own upgrades, backups, and monitoring (see "Operating unmanaged Postgres" under
Ongoing Operations). Current production: `lion-reader-pg`, database `lion_reader`,
`shared-cpu-8x` / 2GB in `lax`, 10GB volume, PostgreSQL 18.

### 1. Create a Postgres Cluster

```bash
flyctl postgres create \
  --name lion-reader-pg \
  --region lax \
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
- `--enable-backups`: WAL-based backups to a Tigris bucket (PITR via
  `flyctl postgres backup restore`), on top of daily volume snapshots

### 2. Attach Postgres to Your App

```bash
flyctl postgres attach lion-reader-pg --app lion-reader
```

This automatically:

- Creates a database user for your app
- Sets the `DATABASE_URL` secret on your app
- Configures network access between your app and database

### 3. Verify Database Connection

```bash
# Connect to the database
flyctl postgres connect -a lion-reader-pg

# Run a quick test
\conninfo
\q
```

### 4. (Optional) View Database URL

```bash
flyctl secrets list --app lion-reader
```

You should see `DATABASE_URL` listed (value is hidden).

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
- **Region**: Same as your app (e.g., `lax`)
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

### 2. Verify All Secrets

```bash
flyctl secrets list
```

You should see:

- `DATABASE_URL` (set automatically by postgres attach)
- `REDIS_URL`
- `NEXT_PUBLIC_APP_URL` (optional)

### Complete Secrets Reference

| Secret                | Required | Description                     | How to Get                                 |
| --------------------- | -------- | ------------------------------- | ------------------------------------------ |
| `DATABASE_URL`        | Yes      | Postgres connection string      | Set by `fly postgres attach`               |
| `REDIS_URL`           | Yes      | Redis/Upstash connection string | From Upstash console or `fly redis create` |
| `NEXT_PUBLIC_APP_URL` | No       | Public URL for the app          | Your Fly.io URL or custom domain           |

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

### 3. Verify Workflow Configuration

The deployment workflow is already configured in `.github/workflows/deploy.yml`. Read that file for the exact steps; its current behavior is:

- **Trigger**: a `workflow_run` on the `CI` workflow completing for `master` (plus `workflow_dispatch` for manual deploys). There is **no direct `push` trigger** — a push starts CI, and only a **successful** CI run triggers the deploy (`if: … github.event.workflow_run.conclusion == 'success'`). This prevents deploying a commit whose typecheck/lint/tests failed.
- **Concurrency**: `group: deploy` with `cancel-in-progress: false`, so deploys **queue** instead of cancelling each other — cancelling an in-flight `flyctl deploy` could kill a mid-flight canary rollout and leave a partial deployment.
- **Checkout**: `ref: ${{ github.event.workflow_run.head_sha || github.sha }}` — deploys the exact commit CI validated, since `workflow_run` runs against the branch tip, which may have moved on.
- **Deploy**: `flyctl deploy --remote-only` with `FLY_API_TOKEN` from GitHub secrets.
- **CDN**: the deploy workflow has no CDN steps. A single Bunny pull zone (`https://cdn.lionreader.com`, a custom hostname on the zone) has the app as origin and wraps the **whole site**, but honors origin `Cache-Control`, so what it caches is decided by our headers — configured by the `ASSET_PREFIX` build arg set in `[build.args]` in `fly.toml` (the `Dockerfile` leaves it unset, so non-Fly/local builds stay origin-served). It serves the hashed `/_next/static` assets via Next's `assetPrefix`, content-hashed + `immutable`, so no purging or upload ordering is needed. The demo hero/OG images fall under this too: they're `import`ed by the article files (from `src/app/(public)/demo/articles/images/`), so Next hashes them into `/_next/static/media` and serves them immutable from the CDN automatically — no manifest, `?v=` buster, or Bunny query-string config. HTML/RSC is never CDN-cached: dynamic pages keep Next's default `private, no-store`, and the statically-prerendered public pages' `s-maxage` is overridden to `private, no-cache` in `src/proxy.ts` (see below). The pull zone must send CORS headers (Bunny's "CORS headers" option) so cross-origin font loads work.

### Why HTML and RSC are not CDN-cached

HTML documents and RSC (`?_rsc=`) payloads reference build-specific artifacts — the `/_next/static/chunks/<hash>.js` bundles from the build that produced them — which are gone from the origin after the next deploy (Fly runs one build per release; it does not retain prior builds). A client holding a cached document or payload from an old build would 404 on its chunks, or version-skew against the newer origin, so we keep them off the edge. Note `?_rsc=<hash>` is a **router-state** cache-buster, not a build/deploy id, so it does **not** make an RSC payload safe to shared-cache across deploys — the same route+state hashes identically on both builds.

**Enforcement.** Next stamps `Cache-Control: s-maxage=31536000` on the statically-prerendered `(public)` pages **and their RSC payloads** — a year-long _shared_-cache lifetime for exactly the build-coupled content described above. Because our pull zone wraps the whole site and honors that header (and already keys on `_rsc`/`entry`), `src/proxy.ts` overrides it to `private, no-cache` on the `isPublicStaticPath` responses (alongside the static CSP it already sets there). This works at the source rather than needing a custom-server rewrite: `sendRenderResult` only stamps Next's default when the response has no Cache-Control yet (`!res.getHeader('Cache-Control')` in `next/dist/server/send-payload`), so the middleware header wins — verified on a production build for HTML, RSC, and the `?entry=` prerender. It also closes the maintenance-gate bypass (#1318): an edge-cached `/login`/`/register` would serve a 200 while the gate is trying to 503 everything DB-touching. `no-cache` (not `no-store`) still lets the browser hold a copy, but it must revalidate against the origin before use — so a deploy can't leave a browser booting a stale document (Next does not self-heal missing bootstrap chunks on an initial load), and a revalidation during maintenance hits the 503 gate.

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

## Verification

After deployment, verify the application works end-to-end:

### 1. Health Check

```bash
curl https://your-app.com/api/health
```

### 2. Create a Test Account

1. Open `https://your-app.com`
2. Click "Register" or navigate to `/register`
3. Create an account with a test email and password
4. Verify you're redirected to the main app

### 3. Subscribe to a Feed

1. Click the "+ Subscribe" button
2. Enter a test feed URL, for example:
   - `https://feeds.bbci.co.uk/news/rss.xml` (BBC News)
   - `https://xkcd.com/atom.xml` (XKCD)
   - `https://blog.cloudflare.com/rss/` (Cloudflare Blog)
3. Preview the feed and confirm subscription
4. Verify entries appear after a few moments

### 4. Verify Core Features

- [ ] Entries load in the feed list
- [ ] Clicking an entry shows full content
- [ ] Mark read/unread works
- [ ] Starring entries works
- [ ] Sidebar shows unread counts
- [ ] Real-time updates work (new entries appear without refresh)

### 5. Check Logs for Errors

```bash
flyctl logs --app lion-reader
```

Look for any errors or warnings.

---

## Ongoing Operations

### Scaling

**Increase VM resources:**

```bash
flyctl scale vm shared-cpu-2x --memory 1024
```

**Add more instances:**

The app runs three process groups (`app`, `worker`, `discord` — see the Architecture
Overview). Scale a specific group with `--process-group`; keep `app` at 2 or more for
zero-downtime deploys:

```bash
flyctl scale count 3 --process-group app
```

### Database Maintenance

**Connect to database:**

```bash
# Connect straight to the app database (defaults to the `postgres` admin DB otherwise)
flyctl postgres connect -a lion-reader-pg --database lion_reader
```

**Manual backup:**

```bash
flyctl postgres backup create -a lion-reader-pg
```

**List backups:**

```bash
flyctl postgres backup list -a lion-reader-pg
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
- **Disk:** 10GB volume; `flyctl volumes extend` when needed. A full volume is an
  outage you have to notice — check the fly-metrics disk panel occasionally.
- **Restore drill:** periodically `flyctl postgres backup restore` into a scratch
  cluster to prove the WAL backups actually restore.

**Temporarily scaling for expensive migrations.** A `machine update` resize is only
a few-second restart, so for a CPU- or memory-heavy migration you can bump to a
dedicated tier, run it, then scale back — this is a viable, low-friction pattern:

```bash
# Up (dedicated CPU removes the shared-CPU throttle). Size by bottleneck, not
# by "bigger" — a single-threaded table rewrite only needs performance-2x; an
# index build can use a few cores (see ../migrations/CLAUDE.md).
flyctl machine update <machine-id> --vm-size performance-4x --app lion-reader-pg
# ...run the migration...
# Back down (restore the original RAM explicitly; presets won't)
flyctl machine update <machine-id> --vm-size shared-cpu-8x --vm-memory 2048 --app lion-reader-pg
```

Pick the tier by the migration's bottleneck, not by "bigger is better" — see the
scaling guidance in `../migrations/CLAUDE.md`. Note the web dashboard's scale button
is disabled for Postgres apps; the CLI is the supported path.

### Viewing Logs

```bash
# Live logs
flyctl logs

# Recent logs
flyctl logs --no-tail

# Filter by type
flyctl logs --instance <instance-id>
```

### SSH into Running Machine

```bash
flyctl ssh console
```

### Restarting the App

```bash
flyctl apps restart lion-reader
```

### Custom Domains

1. Add your domain:

```bash
flyctl certs create yourdomain.com
```

2. Follow the DNS instructions provided
3. Verify certificate:

```bash
flyctl certs show yourdomain.com
```

---

## Troubleshooting

### Deployment Fails

**"Release command failed"**

This usually means database migrations failed.

```bash
# Check logs for migration errors
flyctl logs | grep -i migration

# Connect to database and check state
flyctl postgres connect -a lion-reader-pg
```

**"Health check failed"**

The app isn't responding on `/api/health`.

```bash
# Check app logs
flyctl logs

# SSH and check process
flyctl ssh console
ps aux | grep node
```

### Database Connection Issues

**"Connection refused"**

Ensure the database is attached:

```bash
flyctl secrets list
# Should show DATABASE_URL

# Re-attach if needed
flyctl postgres attach lion-reader-pg
```

**"Authentication failed"**

The database user credentials may be wrong. Detach and reattach:

```bash
flyctl postgres detach lion-reader-pg
flyctl postgres attach lion-reader-pg
```

### Redis Connection Issues

**"Connection timeout"**

Check if Redis is accessible:

```bash
# Verify secret is set
flyctl secrets list | grep REDIS

# Check if using correct protocol (redis:// vs rediss://)
```

For Upstash, ensure you're using TLS (`rediss://`).

### Application Errors

**"500 Internal Server Error"**

Check logs for the actual error:

```bash
flyctl logs --no-tail | tail -100
```

Common causes:

- Missing environment variables
- Database connection issues
- Redis connection issues

### Memory Issues

**"Out of memory"**

Scale up the VM:

```bash
flyctl scale vm shared-cpu-1x --memory 1024
```

### Slow Cold Starts

The app uses `auto_stop_machines = "stop"`, which stops idle app machines. The first request after an idle period can be slow while a machine wakes.

`fly.toml` already sets `min_machines_running = 2`. **Keep it at 2 or more** — the canary rolling-deploy strategy needs at least two app machines for zero-downtime deploys, so this also keeps a warm machine ready. Do **not** lower it to 1 (that reintroduces cold starts and breaks zero-downtime rollout):

```toml
[http_service]
  # Need at least 2 machines for zero-downtime rolling deploys
  min_machines_running = 2
```

If you need more warm capacity, raise the app machine count (`processes = ["app"]`):

```bash
flyctl scale count 3 --process-group app
```

---

## Architecture Overview

Fly.io runs three independent **process groups** (`[processes]` in `fly.toml`),
each on its own VM(s): `app` (Next.js web + SSE, min 2 machines for zero-downtime
deploys), `worker` (background feed fetching / jobs), and `discord` (Discord save
bot). Only `app` is behind the HTTP load balancer; all three share Postgres and Redis.

```
                    Internet
                        |
                   Fly.io Edge (LB)
                        |
            +-----------+-----------+
            |                       |
     +------+------+         +------+------+
     | App Server  |         | App Server  |     process group: app
     |  (Next.js)  |         |  (replica)  |     (min 2 machines)
     +------+------+         +------+------+
            |                       |
            +-----------+-----------+
                        |
    +-------------------+-------------------+
    |                   |                   |
    |            +------+------+     +------+------+
    |            |   Worker    |     |   Discord   |   process groups:
    |            | (feed jobs) |     |  save bot   |   worker, discord
    |            +------+------+     +------+------+
    |                   |                   |
    +---------+---------+---------+---------+
              |                   |
       +------+------+     +------+------+
       |   Postgres  |     |    Redis    |
       | (Fly.io PG) |     |  (Upstash)  |
       +-------------+     +-------------+
```

## Cost Estimate (current production shape, July 2026)

| Resource        | Size                            | Estimated Cost    |
| --------------- | ------------------------------- | ----------------- |
| App VMs         | 2× shared-cpu-2x, 512MB         | ~$8/month         |
| Worker VM       | shared-cpu-1x, 512MB            | ~$3.50/month      |
| Discord VM      | shared-cpu-1x, 256MB            | ~$2/month         |
| Postgres        | shared-cpu-8x, 2GB, 10GB volume | ~$18/month        |
| Redis (Upstash) | Pay-as-you-go                   | ~$0-5/month       |
| **Total**       |                                 | **~$32-37/month** |

Costs vary by usage. Check [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) for current rates.

---

## Next Steps

After successful deployment:

1. **Set up monitoring** - Configure Sentry for error tracking
2. **Add custom domain** - Use `flyctl certs create` for SSL
3. **Enable backups** - Configure automated Postgres backups
4. **Monitor usage** - Use Fly.io dashboard to track resource usage

For questions or issues, check:

- [Fly.io Documentation](https://fly.io/docs/)
- [Fly.io Community Forum](https://community.fly.io/)
