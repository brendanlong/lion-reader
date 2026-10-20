# Alerts when Postgres base backups stop succeeding (#2091): an hourly
# Cloudflare Worker reads the barman catalog in the Tigris backup bucket and
# pings the backup_health healthchecks.io check. It runs outside Fly so it
# keeps reporting when the app or its worker is down. What it checks and why:
# backup-health/worker.ts.
#
# `pnpm build:backup-health-worker` must run before plan; the missing file
# fails the plan otherwise.

locals {
  backup_health_bundle = "${path.module}/build/backup-health.js"
}

resource "cloudflare_workers_script" "backup_health" {
  account_id         = var.cloudflare_account_id
  script_name        = "lion-reader-backup-health"
  content_file       = local.backup_health_bundle
  content_sha256     = filesha256(local.backup_health_bundle)
  main_module        = "backup-health.js"
  compatibility_date = "2026-10-01"

  bindings = [
    {
      type = "plain_text"
      name = "BACKUP_BUCKET_ENDPOINT"
      text = "https://t3.storage.dev"
    },
    {
      type = "plain_text"
      name = "BACKUP_BUCKET"
      text = var.backup_bucket
    },
    {
      type = "plain_text"
      name = "BACKUP_SERVER_NAME"
      text = var.backup_server_name
    },
    {
      type = "secret_text"
      name = "BACKUP_ACCESS_KEY_ID"
      text = var.backup_bucket_access_key_id
    },
    {
      type = "secret_text"
      name = "BACKUP_SECRET_ACCESS_KEY"
      text = var.backup_bucket_secret_access_key
    },
    {
      type = "secret_text"
      name = "HEARTBEAT_URL"
      text = healthchecksio_check.this["backup_health"].ping_url
    },
  ]
}

resource "cloudflare_workers_cron_trigger" "backup_health" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.backup_health.script_name
  schedules = [{
    cron = "17 * * * *"
  }]
}
