# The CAPTCHA on password signup (src/server/auth/captcha.ts). The app reads
# the keys as TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY; the README in this
# directory has the command that copies them into Fly.
resource "cloudflare_turnstile_widget" "signup" {
  account_id = var.cloudflare_account_id
  name       = "Lion Reader signup"
  domains    = [var.domain]
  # Shows a checkbox only when Cloudflare isn't sure about the visitor.
  mode = "managed"
}
