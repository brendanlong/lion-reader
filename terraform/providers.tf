# Every provider reads its credential from the environment, so no secrets live in
# this repo or in the state config. README.md lists the variables and scopes.
#
# Two names are easy to get wrong because they aren't what the vendor's own docs
# use: Bunny reads BUNNYNET_API_KEY (not BUNNY_API_KEY, which its REST API uses)
# and healthchecks.io reads HEALTHCHECKSIO_API_KEY. Unset, Bunny sends an empty
# key and every call fails with a bare 401 naming no cause.

provider "cloudflare" {}

provider "bunnynet" {}

provider "mailgun" {}

provider "sentry" {}

provider "healthchecksio" {}

# Route 53 Domains is a us-east-1-only API regardless of where anything else
# lives (registrar.tf).
provider "aws" {
  region = "us-east-1"
}

# The Tigris provider's own fallback is AWS_ACCESS_KEY_ID, which would hand it
# the AWS credentials the registrar and state backend use, so its key comes in
# as variables instead.
provider "tigris" {
  endpoint   = "https://t3.storage.dev" # STORAGE_ENDPOINT in ../fly.toml
  access_key = var.tigris_access_key_id
  secret_key = var.tigris_secret_access_key
}
