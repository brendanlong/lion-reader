# healthchecks.io — the dead-man's-switch monitors. What each one means and which
# process pings it is in ../docs/DESIGN.md ("Alerting").

# Looked up rather than hardcoded so a recreated channel needs no code change.
# `kind` alone is a unique-enough selector while there is one integration; on a
# miss the provider returns a null id rather than failing, so match on `name`
# too if a second email channel ever appears.
data "healthchecksio_channel" "email" {
  kind = "email"
}

locals {
  # timeout: how long a check may go unpinged before it is late.
  # grace:   how much longer before it goes down and notifies.
  # `slug` is left undeclared, so renaming a check does not move it. Deliberate:
  # ping URLs use the uuid, and a stable slug keeps slug-based URLs working.
  healthchecks = {
    worker = {
      name    = "Lion Reader Worker Liveness"
      env_var = "WORKER_HEARTBEAT_URL"
      timeout = 60
      grace   = 900
    }
    feed_health = {
      name    = "Lion Reader Feed Fetch Health"
      env_var = "FEED_HEALTH_HEARTBEAT_URL"
      timeout = 900
      grace   = 1200
    }
    discord_bot = {
      name    = "Lion Reader Discord Bot Liveness"
      env_var = "DISCORD_BOT_HEARTBEAT_URL"
      timeout = 300
      grace   = 1800
    }
  }
}

# One resource rather than three: `channels` is what must not be got wrong —
# omitting it detaches every notification and leaves the checks green — so it is
# declared once instead of three times.
resource "healthchecksio_check" "this" {
  for_each = local.healthchecks

  name     = each.value.name
  timeout  = each.value.timeout
  grace    = each.value.grace
  tags     = ["lion-reader"]
  channels = [data.healthchecksio_channel.email.id]

  lifecycle {
    # A channel lookup miss yields a null id, not an error. SDKv2 does refuse
    # the null one layer down ("Null value found in list"), so this is for the
    # message rather than the outcome. Compare against null, not "": a data
    # source with no match comes back as all-null attributes.
    precondition {
      condition     = data.healthchecksio_channel.email.id != null
      error_message = "No healthchecks.io channel of kind \"email\" found. Fix the lookup before applying — these checks must not be left with no notification channel."
    }
  }
}
