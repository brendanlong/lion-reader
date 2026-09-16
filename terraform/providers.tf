# Both providers read credentials from the environment, so no secrets live in
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
#
# AWS creds for the S3 state backend come from the usual AWS chain.

provider "cloudflare" {}

provider "bunnynet" {}
