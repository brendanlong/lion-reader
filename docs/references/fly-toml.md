# fly.toml Configuration Reference

Simplified reference for Fly.io app configuration. See full docs at https://fly.io/docs/reference/configuration/

## Basic App Settings

```toml
app = "my-app-name"           # App name (also used for default hostname)
primary_region = "ord"        # Region for new Machines, sets PRIMARY_REGION env var

kill_signal = "SIGTERM"       # Signal sent on shutdown (default: SIGINT)
kill_timeout = 120            # Seconds to wait before forced shutdown (default: 5, max: 300)

swap_size_mb = 512            # Enable swap with this size in MB

console_command = "/app/manage.py shell"  # Command for `fly console`
```

## Build Section

```toml
[build]
  dockerfile = "Dockerfile"           # Path to Dockerfile (default: "Dockerfile")
  # OR
  image = "flyio/hellofly:latest"     # Deploy existing image directly
  # OR
  builder = "paketobuildpacks/builder:base"  # Use buildpacks
  buildpacks = ["gcr.io/paketo-buildpacks/nodejs"]

  build-target = "production"         # For multi-stage Dockerfiles
  ignorefile = ".dockerignore"        # Custom ignore file

[build.args]
  MODE = "production"                 # Build-time args (not available at runtime)
```

## Deploy Section

```toml
[deploy]
  release_command = "bin/rails db:prepare"  # Run before deploy (e.g., migrations)
  release_command_timeout = "10m"           # Default: 5m

  strategy = "rolling"        # Deployment strategy (see below)
  max_unavailable = 0.33      # For rolling: fraction or count of Machines down at once
  wait_timeout = "10m"        # Time to wait for Machine to start (default: 5m)

  [deploy.release_command_vm]
    size = "performance-1x"   # Override VM size for release command
    memory = "8gb"
```

**Deployment Strategies:**

- `rolling` (default): Replace Machines one by one
- `immediate`: Replace all at once, skip health checks
- `canary`: Deploy one Machine first, verify health, then rolling
- `bluegreen`: Deploy new Machines alongside old, switch traffic atomically (requires health checks, no volumes)

## Environment Variables

```toml
[env]
  LOG_LEVEL = "debug"
  RAILS_ENV = "production"
  # Note: Use `fly secrets` for sensitive values; secrets override env vars
```

## HTTP Service (Simple)

For apps that only need HTTP/HTTPS on ports 80/443:

```toml
[http_service]
  internal_port = 8080        # Port your app listens on
  force_https = true          # Redirect HTTP to HTTPS

  # Auto-scaling
  auto_stop_machines = "stop"   # "off", "stop", or "suspend"
  auto_start_machines = true
  min_machines_running = 0      # In primary region only

  processes = ["web"]           # Limit to specific process group(s)

  [http_service.concurrency]
    type = "requests"           # "connections" or "requests" (use requests for HTTP)
    soft_limit = 200            # Deprioritize traffic above this
    hard_limit = 250            # Stop sending traffic above this

  [http_service.tls_options]
    alpn = ["h2", "http/1.1"]
    versions = ["TLSv1.2", "TLSv1.3"]

  [http_service.http_options]
    idle_timeout = 600          # Connection idle timeout in seconds
    h2_backend = true           # Enable HTTP/2 cleartext to backend (for gRPC)
```

## HTTP Service Health Checks

```toml
[[http_service.checks]]
  grace_period = "10s"    # Wait after Machine start before checking
  interval = "30s"        # Time between checks
  timeout = "5s"          # Max time for check to complete
  method = "GET"
  path = "/"
  protocol = "http"       # or "https"
  tls_skip_verify = false
  [http_service.checks.headers]
    Authorization = "Bearer token"
```

## Services (Advanced)

For non-HTTP protocols or custom port configurations:

```toml
[[services]]
  internal_port = 8080
  protocol = "tcp"              # "tcp" or "udp"
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["web"]

  [[services.ports]]
    handlers = ["http"]
    port = 80
    force_https = true

  [[services.ports]]
    handlers = ["tls", "http"]
    port = 443

  [services.concurrency]
    type = "requests"
    soft_limit = 20
    hard_limit = 25

  [[services.tcp_checks]]
    grace_period = "1s"
    interval = "15s"
    timeout = "2s"

  [[services.http_checks]]
    grace_period = "5s"
    interval = "10s"
    timeout = "2s"
    method = "get"
    path = "/"
```

## Volumes (Persistent Storage)

```toml
[mounts]
  source = "myapp_data"       # Volume name
  destination = "/data"       # Mount path in container
  processes = ["app"]         # Limit to process group(s)
  initial_size = "20gb"       # Size for auto-created volumes
  snapshot_retention = 14     # Days to keep snapshots (default: 5)
  scheduled_snapshots = true  # Enable daily snapshots (default: true)

  # Auto-extend (all three required)
  auto_extend_size_threshold = 80   # Percent usage to trigger
  auto_extend_size_increment = "1GB"
  auto_extend_size_limit = "5GB"
```

For multiple mounts (different process groups), use double brackets:

```toml
[[mounts]]
  source = "app_data"
  destination = "/data"
  processes = ["app"]

[[mounts]]
  source = "worker_data"
  destination = "/data"
  processes = ["worker"]
```

## VM Sizing

```toml
[[vm]]
  size = "shared-cpu-2x"      # Preset (run `fly platform vm-sizes` for list)
  memory = "1gb"              # Override memory
  cpus = 2                    # Override CPU count
  cpu_kind = "shared"         # "shared" or "performance"
  processes = ["app"]         # Limit to process group(s)

# Different sizes per process group
[[vm]]
  size = "shared-cpu-4x"

[[vm]]
  size = "performance-1x"
  processes = ["worker"]
```

**Note:** If you change size via `fly scale vm`, the next `fly deploy` will reset to fly.toml values. Remove the `[[vm]]` section to allow manual scaling.

## Process Groups

Run different commands on separate Machines:

```toml
[processes]
  web = "npm start"
  worker = "npm run worker"

[http_service]
  processes = ["web"]         # Only web receives HTTP traffic
  internal_port = 8080

[[mounts]]
  source = "data"
  destination = "/data"
  processes = ["worker"]      # Only worker gets volume
```

## Restart Policy

```toml
[[restart]]
  policy = "on-failure"       # "always", "never", or "on-failure" (default)
  retries = 10                # Max restart attempts
  processes = ["app"]         # Limit to process group(s)
```

## Top-Level Health Checks

For apps without public services or independent checks:

```toml
[checks]
  [checks.my_http_check]
    type = "http"             # Required: "http" or "tcp"
    port = 5500               # Required: internal port
    grace_period = "30s"
    interval = "15s"
    timeout = "10s"
    method = "get"
    path = "/health"
    processes = ["web"]

  [checks.my_tcp_check]
    type = "tcp"
    port = 1234
    interval = "15s"
    timeout = "10s"
```

## Metrics

```toml
[metrics]
  port = 9091
  path = "/metrics"

# Per-process metrics
[[metrics]]
  port = 9394
  path = "/metrics"
  processes = ["web"]
```

## Static Files

```toml
[[statics]]
  guest_path = "/app/public"
  url_prefix = "/public"
  # Optional: serve from Tigris bucket instead
  tigris_bucket = "my-bucket"
  index_document = "index.html"
```

**Caveat:** Machine must be running to serve statics; this is not a CDN.

## Files (Write files to Machine)

```toml
[[files]]
  guest_path = "/app/config.yaml"
  local_path = "/local/config.yaml"    # From local file
  processes = ["web"]

[[files]]
  guest_path = "/app/secret.txt"
  secret_name = "MY_SECRET"            # From fly secret (must be base64 encoded)

[[files]]
  guest_path = "/app/data.txt"
  raw_value = "aGVsbG8gd29ybGQK"       # Base64 encoded content
```

## Experimental

Override Dockerfile CMD/ENTRYPOINT:

```toml
[experimental]
  cmd = ["node", "server.js"]           # Override CMD
  entrypoint = ["/bin/sh", "-c"]        # Override ENTRYPOINT
  exec = ["node", "server.js"]          # Override both
```
