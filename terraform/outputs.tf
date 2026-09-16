# Set these at the registrar during the cutover (see README, step 4).
output "cloudflare_nameservers" {
  description = "Nameservers to set at the registrar to move DNS to Cloudflare."
  value       = cloudflare_zone.lionreader.name_servers
}

output "cloudflare_zone_status" {
  description = "Zone activation status (active once the nameservers propagate)."
  value       = cloudflare_zone.lionreader.status
}

# The app reads this as SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN. Piping it into
# `flyctl secrets` is what makes a key rotation reproducible rather than a
# copy-paste out of the dashboard.
output "sentry_dsn" {
  description = "Public DSN for the Sentry project."
  value       = sentry_key.default.dsn["public"]
  sensitive   = true
}
