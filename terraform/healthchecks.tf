# ---------------------------------------------------------------------------
# healthchecks.io — the three dead-man's-switch monitors
#
# This describes the EXISTING checks, adopted by import. Nothing here creates
# infrastructure. What each one means and which process pings it is in
# ../docs/DESIGN.md ("Alerting"); this file only owns their shape.
#
# ⚠️  `channels` is Optional and NOT Computed, and the provider's Read fills it
#     from live. Leave it undeclared and the plan plans a *removal*: the apply
#     sends an empty channel list and healthchecks.io detaches every
#     notification integration. The checks stay green and silently stop telling
#     anyone when they go red — a monitor that has quietly stopped monitoring is
#     worse than no monitor, because it still looks like coverage.
#
#     That hazard is why these are one `for_each` rather than three resources:
#     the attribute that must not be forgotten is the one they share, so there
#     is one place to forget it.
# ---------------------------------------------------------------------------

# Looked up rather than hardcoded so a recreated channel doesn't need a code
# change. `kind` is the only selector the provider offers, which is enough while
# there is exactly one integration; add `name` if a second email channel ever
# appears, or the match becomes order-dependent.
data "healthchecksio_channel" "email" {
  kind = "email"
}

locals {
  # timeout = how long a check may go unpinged before it is late.
  # grace   = how much longer before it goes down and notifies.
  # Both are live values. `grace` matters most: the provider defaults it to
  # 3600, which is longer than every value here, so an omitted grace would
  # quietly slow every alert down rather than erroring.
  healthchecks = {
    worker = {
      name    = "Lion Reader Worker Liveness"
      timeout = 60
      grace   = 900
    }
    feed_health = {
      name    = "Lion Reader Feed Fetch Health"
      timeout = 900
      grace   = 1200
    }
    discord_bot = {
      name    = "Lion Reader Discord Bot Liveness"
      timeout = 300
      grace   = 1800
    }
  }
}

resource "healthchecksio_check" "this" {
  for_each = local.healthchecks

  name    = each.value.name
  timeout = each.value.timeout
  grace   = each.value.grace
  tags    = ["lion-reader"]

  channels = [data.healthchecksio_channel.email.id]

  lifecycle {
    # The channel data source returns an empty id instead of failing when
    # nothing matches, and the provider drops empty strings from the list — so
    # a lookup miss would arrive as "detach all notifications" rather than as an
    # error. Catch it in the plan.
    precondition {
      condition     = data.healthchecksio_channel.email.id != ""
      error_message = "No healthchecks.io channel of kind \"email\" found. Applying would detach every notification from these checks."
    }
  }
}
