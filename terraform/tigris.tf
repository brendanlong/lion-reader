# Private archive of article HTML we keep but never serve (#2115). It must stay
# private: the app's other bucket is public, and this one holds raw third-party
# pages at keys derived from entry IDs, which clients see.

resource "tigris_bucket" "archive" {
  bucket = "lion-reader-archive"

  lifecycle {
    prevent_destroy = true
  }
}

# Never delete this block: the provider's delete (as of 1.1.4) turns public
# object listing *on*. To stop managing it, use a `removed` block with
# `destroy = false` instead.
resource "tigris_bucket_public_access" "archive" {
  bucket              = tigris_bucket.archive.bucket
  acl                 = "private"
  public_list_objects = false
}
