# Lion Reader Operations Runbook

This runbook documents common operational issues, their symptoms, and resolution steps.

## Table of Contents

1. [Monitoring and Alerts](#monitoring-and-alerts)
2. [Investigating Errors](#investigating-errors)
3. [Database Troubleshooting](#database-troubleshooting)
4. [Redis Troubleshooting](#redis-troubleshooting)
5. [Worker Job Issues](#worker-job-issues)
6. [Performance Debugging](#performance-debugging)
7. [Common Issues and Solutions](#common-issues-and-solutions)

---

## Monitoring and Alerts

### Health Check Endpoint

The health check endpoint provides a quick overview of system health:

```bash
curl https://your-domain.com/api/health
```

**Response codes:**

- `200` - All systems healthy or degraded (partial availability)
- `503` - System unhealthy (all components down)

**Example healthy response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": {
    "database": { "status": "healthy", "latencyMs": 5 },
    "redis": { "status": "healthy", "latencyMs": 2 }
  }
}
```

### Sentry Error Tracking

Errors are tracked in Sentry. Access the Sentry dashboard to:

1. View recent errors and their frequency
2. See error stack traces and context
3. Track error resolution status
4. Set up alert rules for critical errors

**Key Sentry features:**

- Errors are grouped by type and stack trace
- Each error includes user context, request data, and breadcrumbs
- Use the Issues tab to triage and assign errors

### Structured Logs

Logs are output in JSON format in production:

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "error",
  "message": "Failed to fetch feed",
  "service": "lion-reader",
  "feedId": "abc123",
  "error": "Connection timeout"
}
```

**Log levels:**

- `debug` - Detailed debugging information (disabled in production)
- `info` - General operational events
- `warn` - Warning conditions that may need attention
- `error` - Error conditions that require investigation

---

## Investigating Errors

### Step 1: Check Sentry

1. Go to the Sentry dashboard
2. Filter by time range and error type
3. Look at the error frequency graph - is this new or recurring?
4. Check the stack trace and context data

### Step 2: Check Logs

For Fly.io deployments:

```bash
fly logs --app lion-reader
```

Filter for errors:

```bash
fly logs --app lion-reader | jq 'select(.level == "error")'
```

### Step 3: Check Health Endpoint

```bash
curl https://your-domain.com/api/health | jq
```

If a component is unhealthy, focus investigation there.

### Step 4: Reproduce Locally

If possible, reproduce the issue locally:

```bash
pnpm dev
```

Check local logs for more detailed output (development logs are human-readable).

---

## Database Troubleshooting

### Connection Issues

**Symptoms:**

- Health check shows database unhealthy
- Errors like "ECONNREFUSED" or "Connection timeout"
- Increased response times

**Resolution:**

1. Check if the database is running:

   ```bash
   fly postgres connect -a lion-reader-db
   ```

2. Check connection pool status:

   ```sql
   SELECT count(*) FROM pg_stat_activity WHERE datname = 'lion_reader';
   ```

3. Check for long-running queries:

   ```sql
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query
   FROM pg_stat_activity
   WHERE state = 'active'
   ORDER BY duration DESC;
   ```

4. Kill long-running queries if necessary:
   ```sql
   SELECT pg_cancel_backend(pid);
   ```

### Slow Queries

**Symptoms:**

- High latency on API requests
- Database health check showing high latency (> 100ms)

**Resolution:**

1. Enable query logging temporarily:

   ```sql
   ALTER SYSTEM SET log_min_duration_statement = '100';
   SELECT pg_reload_conf();
   ```

2. Check for missing indexes:

   ```sql
   SELECT schemaname, tablename, attname, null_frac, avg_width, n_distinct
   FROM pg_stats
   WHERE schemaname = 'public';
   ```

3. Analyze query plans:
   ```sql
   EXPLAIN ANALYZE SELECT ...;
   ```

### Lock Contention

**Symptoms:**

- Requests timing out
- Job processing stalling

**Resolution:**

1. Check for locks:

   ```sql
   SELECT blocked_locks.pid AS blocked_pid,
          blocked_activity.usename AS blocked_user,
          blocking_locks.pid AS blocking_pid,
          blocking_activity.usename AS blocking_user,
          blocked_activity.query AS blocked_statement
   FROM pg_catalog.pg_locks blocked_locks
   JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
   JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
   JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
   WHERE NOT blocked_locks.granted;
   ```

2. Consider terminating blocking connections:
   ```sql
   SELECT pg_terminate_backend(pid);
   ```

---

## Redis Troubleshooting

### Connection Issues

**Symptoms:**

- Health check shows Redis unhealthy
- Session validation failing
- Rate limiting not working
- Real-time updates not delivering

**Resolution:**

1. Check Redis connectivity:

   ```bash
   redis-cli -u $REDIS_URL ping
   ```

2. Check Redis memory usage:

   ```bash
   redis-cli -u $REDIS_URL info memory
   ```

3. Check for blocked clients:
   ```bash
   redis-cli -u $REDIS_URL client list
   ```

### Memory Pressure

**Symptoms:**

- Redis returning OOM errors
- Eviction notices in logs

**Resolution:**

1. Check memory usage:

   ```bash
   redis-cli -u $REDIS_URL info memory
   ```

2. Identify large keys:

   ```bash
   redis-cli -u $REDIS_URL --bigkeys
   ```

3. Consider flushing old session data:
   ```bash
   redis-cli -u $REDIS_URL keys "session:*" | head -100
   ```

### Pub/Sub Issues

**Symptoms:**

- Real-time updates not working
- SSE connections not receiving events

**Resolution:**

1. Check pub/sub channels:

   ```bash
   redis-cli -u $REDIS_URL pubsub channels
   ```

2. Monitor messages:
   ```bash
   redis-cli -u $REDIS_URL psubscribe "feed:*"
   ```

---

## Worker Job Issues

### Jobs Not Processing

**Symptoms:**

- Feeds not updating
- Job queue growing
- No worker activity in logs

**Resolution:**

1. Check job queue status:

   ```sql
   SELECT type, status, count(*)
   FROM jobs
   GROUP BY type, status
   ORDER BY count(*) DESC;
   ```

2. Check for stale jobs:

   ```sql
   SELECT * FROM jobs
   WHERE status = 'running'
   AND locked_at < NOW() - INTERVAL '10 minutes';
   ```

3. Manually reset stale jobs:

   ```sql
   UPDATE jobs
   SET status = 'pending', locked_at = NULL, locked_by = NULL
   WHERE status = 'running'
   AND locked_at < NOW() - INTERVAL '10 minutes';
   ```

4. Check worker logs for errors

### Jobs Failing Repeatedly

**Symptoms:**

- Jobs with high attempt counts
- Same error appearing in logs

**Resolution:**

1. Find problematic jobs:

   ```sql
   SELECT id, type, payload, attempts, last_error
   FROM jobs
   WHERE status = 'failed'
   ORDER BY created_at DESC
   LIMIT 20;
   ```

2. For feed fetch failures, check the feed:

   ```sql
   SELECT id, url, consecutive_failures, last_error
   FROM feeds
   WHERE id = 'feed-id-from-job';
   ```

3. Test the feed URL manually:
   ```bash
   curl -I https://example.com/feed.xml
   ```

### Job Queue Backlog

**Symptoms:**

- Increasing number of pending jobs
- Delayed feed updates

**Resolution:**

1. Check queue depth:

   ```sql
   SELECT type, count(*)
   FROM jobs
   WHERE status = 'pending'
   GROUP BY type;
   ```

2. Check if jobs are being claimed:

   ```sql
   SELECT type, started_at, locked_by
   FROM jobs
   WHERE status = 'running'
   ORDER BY started_at DESC
   LIMIT 10;
   ```

3. Scale up workers or increase concurrency if needed

---

## Performance Debugging

### High API Latency

**Symptoms:**

- Slow page loads
- API responses taking > 500ms

**Resolution:**

1. Check which endpoints are slow (Sentry transaction data)

2. Check database query performance:

   ```sql
   SELECT * FROM pg_stat_statements
   ORDER BY mean_time DESC
   LIMIT 10;
   ```

3. Check for N+1 queries in logs

4. Check Redis latency in health endpoint

### Memory Issues

**Symptoms:**

- OOM kills on Fly.io
- Increasing memory usage over time

**Resolution:**

1. Check current memory usage:

   ```bash
   fly machine status -a lion-reader
   ```

2. Look for memory leaks in long-running connections (SSE)

3. Check Node.js heap:
   ```bash
   NODE_OPTIONS="--max-old-space-size=512" pnpm start
   ```

### CPU Spikes

**Symptoms:**

- High CPU usage
- Slow response times

**Resolution:**

1. Check if feed parsing is causing issues (large feeds)

2. Check for infinite loops in job processing

3. Profile with Node.js inspector if reproducible locally

---

## Common Issues and Solutions

### "Failed to fetch feed" Errors

**Possible causes:**

- Feed URL changed or is down
- SSL certificate issues
- Rate limiting by the feed server

**Resolution:**

1. Check the feed URL manually
2. Check `consecutive_failures` count on the feed
3. If permanently broken, consider removing subscriptions

### "Session expired" for All Users

**Possible causes:**

- Redis connection lost
- Redis data flushed

**Resolution:**

1. Check Redis connectivity
2. Users will need to log in again
3. Investigate cause of Redis disruption

### Real-time Updates Not Working

**Possible causes:**

- SSE connections being dropped
- Redis pub/sub not functioning
- Client-side EventSource errors

**Resolution:**

1. Check browser console for EventSource errors
2. Check Redis pub/sub (see Redis troubleshooting)
3. Check for proxy/CDN issues with SSE

### High Error Rate After Deployment

**Resolution:**

1. Check Sentry for new error types
2. Consider rolling back: `fly deploy --image previous-image-ref`
3. Check database migrations ran successfully

### Rate Limiting Users

**Symptoms:**

- Users receiving 429 responses

**Resolution:**

1. Check if legitimate traffic spike
2. If attacking, consider IP blocking
3. Adjust rate limits if needed:
   ```typescript
   // In rate limit configuration
   capacity: 200, // Increase burst capacity
   refillRate: 20, // Increase refill rate
   ```

---

## Emergency Procedures

### Complete Outage

1. Check Fly.io status page
2. Check health endpoint
3. Check database and Redis connectivity
4. Check recent deployments
5. Consider rollback if recent deployment

### Data Recovery

1. Fly.io Postgres has automatic backups
2. Contact Fly.io support for point-in-time recovery
3. Document the incident

### Security Incident

1. Rotate all secrets immediately
2. Revoke all sessions:
   ```sql
   UPDATE sessions SET revoked_at = NOW();
   ```
3. Investigate access logs
4. Notify affected users if required

---

## Useful Commands

### Fly.io

```bash
# View logs
fly logs -a lion-reader

# SSH into machine
fly ssh console -a lion-reader

# Check machine status
fly machine status -a lion-reader

# Deploy
fly deploy -a lion-reader

# Rollback
fly deploy --image registry.fly.io/lion-reader:previous-tag
```

### Database

```bash
# Connect to database
fly postgres connect -a lion-reader-db

# Run migrations
pnpm db:migrate
```

### Local Development

```bash
# Start services
docker-compose up -d

# Run the app
pnpm dev

# Run tests
pnpm test
```
