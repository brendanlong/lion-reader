# One-time adoption of existing infrastructure. Delete this file after the first
# successful `terraform apply` — state holds everything from then on.

# Already created in Cloudflare (status: pending — nameservers not yet switched).
import {
  to = cloudflare_zone.lionreader
  id = "21b908be12c4c80a7a4e64d34f09cb02"
}

import {
  to = bunnynet_pullzone.lionreader
  id = "6171160"
}

# bunnynet_pullzone_hostname import IDs are PULLZONE_ID|hostname, not a number.
import {
  to = bunnynet_pullzone_hostname.cdn
  id = "6171160|cdn.lionreader.com"
}
