-- Collections (#1806): a per-user feed (type 'collection') with a normal
-- subscriptions row, so tags, titles, unread counters and the sidebar treat it
-- like any feed. It has no entries of its own; collection_entries references
-- articles the user can already see, and user_entries.subscription_id keeps
-- pointing at each article's source.

ALTER TABLE feeds DROP CONSTRAINT feed_type_user_id;
--> statement-breakpoint
ALTER TABLE feeds ADD CONSTRAINT feed_type_user_id
  CHECK ((type IN ('email', 'saved', 'collection')) = (user_id IS NOT NULL));
--> statement-breakpoint

-- NOT VALID: existing rows can't violate it, and validating would scan entries.
ALTER TABLE entries ADD CONSTRAINT entries_type_not_collection CHECK (type <> 'collection') NOT VALID;
--> statement-breakpoint

-- Target of the (subscription_id, user_id) foreign key below, which stops a
-- membership row from pointing at another user's collection.
CREATE UNIQUE INDEX uq_subscriptions_id_user ON subscriptions (id, user_id);
--> statement-breakpoint

-- A member needs the user's user_entries row (that's what makes it visible to
-- them). The user_entries delete trigger below removes memberships itself,
-- after taking their contribution off the collection counters: a cascading
-- foreign key would delete them before any trigger could read the state.
-- Deferred, so the check runs after that trigger.
CREATE TABLE collection_entries (
  subscription_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY (subscription_id, entry_id),
  FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, entry_id) REFERENCES user_entries(user_id, entry_id)
    DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE INDEX idx_collection_entries_user_entry ON collection_entries (user_id, entry_id);
--> statement-breakpoint

-- Collection counters: a collection's subscriptions.unread_count /
-- starred_unread_count count its unread, non-spam members, the same
-- contribution rule as the user_entries counters (migration 0092).
CREATE FUNCTION collection_entries_counters_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT n.subscription_id,
           count(*) FILTER (WHERE NOT ue.read AND NOT ue.is_spam)::int AS u,
           count(*) FILTER (WHERE ue.starred AND NOT ue.read AND NOT ue.is_spam)::int AS su
    FROM new_rows n
    JOIN user_entries ue ON ue.user_id = n.user_id AND ue.entry_id = n.entry_id
    GROUP BY n.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION collection_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT o.subscription_id,
           count(*) FILTER (WHERE NOT ue.read AND NOT ue.is_spam)::int AS u,
           count(*) FILTER (WHERE ue.starred AND NOT ue.read AND NOT ue.is_spam)::int AS su
    FROM old_rows o
    JOIN user_entries ue ON ue.user_id = o.user_id AND ue.entry_id = o.entry_id
    GROUP BY o.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER collection_entries_counters_insert_trigger AFTER INSERT ON collection_entries
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_counters_insert();
--> statement-breakpoint
CREATE TRIGGER collection_entries_counters_delete_trigger AFTER DELETE ON collection_entries
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION collection_entries_counters_delete();
--> statement-breakpoint

-- Unsubscribing a collection, by any path, empties it, so its members stop
-- being visible through it and its counters drop to zero. Each removed
-- member's user_entries.updated_at moves so delta sync re-delivers it (or
-- reports it hidden).
CREATE FUNCTION subscriptions_empty_unsubscribed_collection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  WITH removed AS (
    DELETE FROM collection_entries ce
    WHERE ce.subscription_id = NEW.id
    RETURNING ce.user_id, ce.entry_id
  )
  UPDATE user_entries ue
  SET updated_at = now()
  FROM removed r
  WHERE ue.user_id = r.user_id AND ue.entry_id = r.entry_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscriptions_empty_unsubscribed_collection_trigger
  AFTER UPDATE OF unsubscribed_at ON subscriptions
  FOR EACH ROW WHEN (OLD.unsubscribed_at IS NULL AND NEW.unsubscribed_at IS NOT NULL)
  EXECUTE FUNCTION subscriptions_empty_unsubscribed_collection();
--> statement-breakpoint

-- The user_entries counter triggers also move the counters of every collection
-- holding a changed row (and the delete trigger removes the memberships). The
-- first two statements of each are unchanged.
CREATE OR REPLACE FUNCTION user_entries_counters_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT subscription_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam)::int AS u,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS su
    FROM old_rows
    WHERE subscription_id IS NOT NULL
    GROUP BY subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count - d.sv,
      starred_unread_count = usr.starred_unread_count - d.st
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM old_rows
    GROUP BY user_id
  ) d
  WHERE usr.id = d.user_id AND (d.sv <> 0 OR d.st <> 0);

  UPDATE subscriptions s
  SET unread_count = s.unread_count - d.u,
      starred_unread_count = s.starred_unread_count - d.su
  FROM (
    SELECT ce.subscription_id,
           count(*) FILTER (WHERE NOT o.read AND NOT o.is_spam)::int AS u,
           count(*) FILTER (WHERE o.starred AND NOT o.read AND NOT o.is_spam)::int AS su
    FROM old_rows o
    JOIN collection_entries ce ON ce.user_id = o.user_id AND ce.entry_id = o.entry_id
    GROUP BY ce.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  -- Already taken off above; the membership delete trigger finds no
  -- user_entries row left and adds nothing.
  DELETE FROM collection_entries ce
  USING old_rows o
  WHERE ce.user_id = o.user_id AND ce.entry_id = o.entry_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_counters_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id,
           count(*) FILTER (WHERE NOT read AND NOT is_spam)::int AS u,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS su
    FROM new_rows
    WHERE subscription_id IS NOT NULL
    GROUP BY subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT user_id,
           count(*) FILTER (WHERE subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
           count(*) FILTER (WHERE starred AND NOT read AND NOT is_spam)::int AS st
    FROM new_rows
    GROUP BY user_id
  ) d
  WHERE usr.id = d.user_id AND (d.sv <> 0 OR d.st <> 0);

  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT ce.subscription_id,
           count(*) FILTER (WHERE NOT n.read AND NOT n.is_spam)::int AS u,
           count(*) FILTER (WHERE n.starred AND NOT n.read AND NOT n.is_spam)::int AS su
    FROM new_rows n
    JOIN collection_entries ce ON ce.user_id = n.user_id AND ce.entry_id = n.entry_id
    GROUP BY ce.subscription_id
  ) d
  WHERE s.id = d.subscription_id AND (d.u <> 0 OR d.su <> 0);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION user_entries_counters_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT subscription_id, sum(u)::int AS u, sum(su)::int AS su
    FROM (
      SELECT subscription_id,
             (NOT read AND NOT is_spam)::int AS u,
             (starred AND NOT read AND NOT is_spam)::int AS su
      FROM new_rows
      WHERE subscription_id IS NOT NULL
      UNION ALL
      SELECT subscription_id,
             -((NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
      WHERE subscription_id IS NOT NULL
    ) x
    GROUP BY subscription_id
    HAVING sum(u) <> 0 OR sum(su) <> 0
  ) d
  WHERE s.id = d.subscription_id;

  UPDATE users usr
  SET saved_unread_count = usr.saved_unread_count + d.sv,
      starred_unread_count = usr.starred_unread_count + d.st
  FROM (
    SELECT user_id, sum(sv)::int AS sv, sum(st)::int AS st
    FROM (
      SELECT user_id,
             (subscription_id IS NULL AND NOT read AND NOT is_spam)::int AS sv,
             (starred AND NOT read AND NOT is_spam)::int AS st
      FROM new_rows
      UNION ALL
      SELECT user_id,
             -((subscription_id IS NULL AND NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
    ) x
    GROUP BY user_id
    HAVING sum(sv) <> 0 OR sum(st) <> 0
  ) d
  WHERE usr.id = d.user_id;

  UPDATE subscriptions s
  SET unread_count = s.unread_count + d.u,
      starred_unread_count = s.starred_unread_count + d.su
  FROM (
    SELECT ce.subscription_id, sum(x.u)::int AS u, sum(x.su)::int AS su
    FROM (
      SELECT user_id, entry_id,
             (NOT read AND NOT is_spam)::int AS u,
             (starred AND NOT read AND NOT is_spam)::int AS su
      FROM new_rows
      UNION ALL
      SELECT user_id, entry_id,
             -((NOT read AND NOT is_spam)::int),
             -((starred AND NOT read AND NOT is_spam)::int)
      FROM old_rows
    ) x
    JOIN collection_entries ce ON ce.user_id = x.user_id AND ce.entry_id = x.entry_id
    GROUP BY ce.subscription_id
    HAVING sum(x.u) <> 0 OR sum(x.su) <> 0
  ) d
  WHERE s.id = d.subscription_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Articles in one of the user's collections stay visible after the user
-- unsubscribes from their source, like starred ones.
CREATE OR REPLACE VIEW visible_entries AS
 SELECT ue.user_id,
    e.id,
    e.feed_id,
    e.type,
    e.guid,
    e.url,
    e.title,
    e.author,
    e.content_original,
    e.content_cleaned,
    e.summary,
    e.site_name,
    e.image_url,
    e.published_at,
    e.fetched_at,
    e.last_seen_at,
    e.content_hash,
    e.full_content_hash,
    e.spam_score,
    e.is_spam,
    e.list_unsubscribe_mailto,
    e.list_unsubscribe_https,
    e.list_unsubscribe_post,
    e.created_at,
    GREATEST(e.updated_at, ue.updated_at) AS updated_at,
    e.full_content_original,
    e.full_content_cleaned,
    e.full_content_fetched_at,
    e.full_content_error,
    ue.read,
    ue.starred,
    s.id AS subscription_id,
    e.unsubscribe_url,
    ue.read_changed_at,
    ue.published_or_fetched_at,
    e.greader_item_id,
    s.greader_stream_id AS subscription_greader_stream_id,
    e.search_vector
   FROM ((user_entries ue
     JOIN entries e ON ((e.id = ue.entry_id)))
     LEFT JOIN subscriptions s ON ((s.id = ue.subscription_id)))
  WHERE (((s.id IS NOT NULL) AND (s.unsubscribed_at IS NULL)) OR (ue.starred = true) OR (e.type = 'saved'::feed_type)
    OR (EXISTS (SELECT 1 FROM collection_entries ce WHERE ce.user_id = ue.user_id AND ce.entry_id = ue.entry_id)));
