# Private archive of article HTML we keep but never serve (#2115). It must stay
# private: the app's other bucket is public, and this one holds raw third-party
# pages at keys derived from entry IDs, which clients see.

resource "tigris_bucket" "archive" {
  bucket = "lion-reader-archive"

  lifecycle {
    prevent_destroy = true
  }
}

# Never delete a tigris_bucket_public_access block: the provider's delete (as
# of 1.1.4) turns public object listing *on*. To stop managing one, use a
# `removed` block with `destroy = false` instead.
resource "tigris_bucket_public_access" "archive" {
  bucket              = tigris_bucket.archive.bucket
  acl                 = "private"
  public_list_objects = false
}

# The app's public bucket (STORAGE_BUCKET in ../fly.toml): images and
# prerecorded speech, linked straight from entry HTML and the player, so every
# object must stay publicly readable.
import {
  to = tigris_bucket.public
  id = "lion-reader-prod"
}

resource "tigris_bucket" "public" {
  bucket = "lion-reader-prod"

  lifecycle {
    prevent_destroy = true
  }
}

import {
  to = tigris_bucket_public_access.public
  id = "lion-reader-prod"
}

# Spell `acl` out: the provider defaults it to private, which would break every
# image and recording already linked.
resource "tigris_bucket_public_access" "public" {
  bucket              = tigris_bucket.public.bucket
  acl                 = "public-read"
  public_list_objects = false
}
