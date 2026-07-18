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

Lion Reader uses PostgreSQL for all persistent data.

### 1. Create a Postgres Cluster

```bash
flyctl postgres create \
  --name lion-reader-db \
  --region lax \
  --vm-size shared-cpu-1x \
  --initial-cluster-size 1 \
  --volume-size 10
```

**Options explained:**

- `--name`: Name for your Postgres app (must be unique)
- `--region`: Should match your app's `primary_region` in `fly.toml`
- `--vm-size`: `shared-cpu-1x` is sufficient for MVP (~$7/month)
- `--initial-cluster-size`: 1 for MVP, increase for HA
- `--volume-size`: 10GB is plenty for MVP

### 2. Attach Postgres to Your App

```bash
flyctl postgres attach lion-reader-db --app lion-reader
```

This automatically:

- Creates a database user for your app
- Sets the `DATABASE_URL` secret on your app
- Configures network access between your app and database

### 3. Verify Database Connection

```bash
# Connect to the database
flyctl postgres connect -a lion-reader-db

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
- **CDN purge**: after a successful rollout, the workflow purges the Bunny CDN pull zone. Every deploy deletes the previous build's hashed `/_next/static` assets, so any HTML the CDN cached before the deploy references chunks that now 404 — hydration then fails and visitors get the global-error page (issue #1350). The purge makes the CDN refetch fresh HTML immediately; the short `s-maxage` in `src/server/http/page-cache.ts` is the backstop if the purge is skipped or fails. Requires two optional GitHub secrets (the step skips gracefully without them): `BUNNY_API_KEY` (Bunny dashboard > Account Settings > API) and `BUNNY_PULL_ZONE_ID` (the numeric pull zone id from the zone's dashboard URL).
- **Static assets to Bunny storage** (issue #1318): with the optional `BUNNY_STORAGE_ZONE_NAME` + `BUNNY_STORAGE_ZONE_PASSWORD` secrets set (plus `BUNNY_STORAGE_ENDPOINT` if the zone's primary region needs a region endpoint like `https://ny.storage.bunnycdn.com`), the deploy splits into build → extract `/_next/static` from the built image → upload to the storage zone (`scripts/upload-bunny-static.sh`) → release, so every asset is uploaded **before** any HTML referencing it goes live. Uploads are additive — old builds' hashed assets stay servable forever, which is the durable fix for the deploy-skew 404s of issue #1350. Serving them requires a pull zone backed by the storage zone and an Edge Rule on the main pull zone routing `/_next/static/*` to it (managed in Terraform; see issue #1318). Without the storage secrets the workflow uses the original single-step `flyctl deploy`.

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
flyctl postgres connect -a lion-reader-db
```

**Manual backup:**

```bash
flyctl postgres backup create -a lion-reader-db
```

**List backups:**

```bash
flyctl postgres backup list -a lion-reader-db
```

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
flyctl postgres connect -a lion-reader-db
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
flyctl postgres attach lion-reader-db
```

**"Authentication failed"**

The database user credentials may be wrong. Detach and reattach:

```bash
flyctl postgres detach lion-reader-db
flyctl postgres attach lion-reader-db
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

## Cost Estimate (MVP)

| Resource        | Size                 | Estimated Cost    |
| --------------- | -------------------- | ----------------- |
| App VM          | shared-cpu-1x, 512MB | ~$5/month         |
| Postgres        | shared-cpu-1x, 10GB  | ~$7/month         |
| Redis (Upstash) | Pay-as-you-go        | ~$0-5/month       |
| **Total**       |                      | **~$12-17/month** |

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
