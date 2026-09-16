output "cloudflare_nameservers" {
  description = "Nameservers the registrar must delegate to."
  value       = cloudflare_zone.lionreader.name_servers
}

output "cloudflare_zone_status" {
  description = "Zone activation status (active once the nameservers propagate)."
  value       = cloudflare_zone.lionreader.status
}

# Sensitive because the provider returns the public and secret DSNs as one map,
# not because the public DSN is secret — it ships in the client bundle.
output "sentry_dsn" {
  description = "Public DSN for the Sentry project."
  value       = sentry_key.default.dsn["public"]
  sensitive   = true
}

# A ping URL is a write-only capability rather than a read secret, but it still
# lets anyone forge an "I'm alive" — hence sensitive.
output "healthcheck_ping_urls" {
  description = "healthchecks.io ping URLs, by the env var that carries them."
  value = {
    for k, v in local.healthchecks : v.env_var => healthchecksio_check.this[k].ping_url
  }
  sensitive = true
}
