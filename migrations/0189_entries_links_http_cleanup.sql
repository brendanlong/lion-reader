-- Clears stored entry links that aren't http(s) URLs a client can't parse
-- differently (relative links, `javascript:` and other schemes, controls,
-- spaces, quotes, angle brackets): written before the app stored only
-- `linkableUrl`'s href. 0190 then refuses them. Cleanup comes first: with the
-- constraint in place, any update to a still-bad row would fail.
--
-- A feed entry still in its feed gets its link back, as an href, when its next
-- fetch sees the changed content hash. Bumping updated_at tells syncing clients
-- (Android) to drop the link they cached.
SET LOCAL lock_timeout = '5s';

UPDATE entries
SET
  updated_at = now(),
  url = CASE WHEN url ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN url END,
  image_url = CASE WHEN image_url ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN image_url END,
  unsubscribe_url = CASE WHEN unsubscribe_url ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN unsubscribe_url END,
  list_unsubscribe_https =
    CASE WHEN list_unsubscribe_https ~* '^https?://[^\x01-\x20\x7f"<>]*$' THEN list_unsubscribe_https END
WHERE url !~* '^https?://[^\x01-\x20\x7f"<>]*$'
  OR image_url !~* '^https?://[^\x01-\x20\x7f"<>]*$'
  OR unsubscribe_url !~* '^https?://[^\x01-\x20\x7f"<>]*$'
  OR list_unsubscribe_https !~* '^https?://[^\x01-\x20\x7f"<>]*$';
