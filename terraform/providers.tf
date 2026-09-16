# Every provider reads credentials from the environment, so no secrets live in
# this repo or in the state config:
#
#   export CLOUDFLARE_API_TOKEN=...   # Zone:Edit + DNS:Edit
#                                     # (no Dynamic Redirect scope needed — unlike
#                                     # brendanlong.com, this zone has no rulesets)
#   export BUNNYNET_API_KEY=...       # Bunny account API key. Note the name: the
#                                     # provider reads BUNNYNET_API_KEY, NOT
#                                     # BUNNY_API_KEY (which the REST API uses).
#                                     # Unset, it sends an empty key and every call
#                                     # fails with a bare 401.
#   export MAILGUN_API_KEY=...        # Mailgun account API key (Sending API keys
#                                     # can't read routes, which are account-level).
#
# AWS creds come from the usual AWS chain, and cover both the S3 state backend
# and the registrar (registrar.tf) — the latter needs route53domains:* .

provider "cloudflare" {}

provider "bunnynet" {}

provider "mailgun" {}

# Route 53 Domains is a us-east-1-only API regardless of where anything else
# lives (registrar.tf).
provider "aws" {
  region = "us-east-1"
}
