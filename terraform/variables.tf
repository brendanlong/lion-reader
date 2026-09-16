variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the zone."
  type        = string
  default     = "3fe97ba8167f61f971aae8459edc3717"
}

variable "domain" {
  description = "Apex domain."
  type        = string
  default     = "lionreader.com"
}

variable "fly_ipv4" {
  description = "Fly.io shared IPv4 for the lion-reader app."
  type        = string
  default     = "66.241.125.131"
}

variable "fly_ipv6" {
  description = "Fly.io dedicated IPv6 for the lion-reader app."
  type        = string
  default     = "2a09:8280:1::be:9f32:0"
}

variable "bunny_cdn_hostname" {
  description = "Bunny pull-zone hostname the cdn record points at."
  type        = string
  default     = "lionreader.b-cdn.net"
}

variable "mail_domain" {
  description = "Mailgun domain. Carries SPF/DKIM and, via wildcard, the ingest subdomain."
  type        = string
  default     = "app.lionreader.com"
}

variable "ingest_email_domain" {
  description = "Newsletter ingest domain. Must match INGEST_EMAIL_DOMAIN in ../fly.toml."
  type        = string
  default     = "in.app.lionreader.com"
}
