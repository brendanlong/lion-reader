# Set these at the registrar during the cutover (see README, step 4).
output "cloudflare_nameservers" {
  description = "Nameservers to set at the registrar to move DNS to Cloudflare."
  value       = cloudflare_zone.lionreader.name_servers
}

output "cloudflare_zone_status" {
  description = "Zone activation status (active once the nameservers propagate)."
  value       = cloudflare_zone.lionreader.status
}
