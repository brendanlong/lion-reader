-- Clears stored entry links that 0189's constraints reject: written before the
-- app kept only http(s) links (relative links, `javascript:` and other
-- schemes). A feed entry still in its feed gets its link back, as an http(s)
-- href, when its next fetch sees the changed content hash.
UPDATE entries
SET
  url = CASE WHEN url ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN url END,
  image_url = CASE WHEN image_url ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN image_url END,
  unsubscribe_url =
    CASE WHEN unsubscribe_url ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN unsubscribe_url END,
  list_unsubscribe_https =
    CASE
      WHEN list_unsubscribe_https ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN list_unsubscribe_https
    END
WHERE url !~* '^https?://[^\x01-\x20\x7f"<>]*$'
  OR image_url !~* '^https?://[^\x01-\x20\x7f"<>]*$'
  OR unsubscribe_url !~* '^https?://[^\x01-\x20\x7f"<>]*$'
  OR list_unsubscribe_https !~* '^https?://[^\x01-\x20\x7f"<>]*$';
