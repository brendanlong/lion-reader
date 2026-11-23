-- Clears feed site URLs that 0193 refuses, as 0189 does for entry links.
SET LOCAL lock_timeout = '5s';

UPDATE feeds SET site_url = NULL WHERE site_url !~* '^https?://[^\x01-\x20\x7f"<>]*$';
