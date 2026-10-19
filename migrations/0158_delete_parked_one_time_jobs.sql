-- Finished one-time jobs are now deleted when they finish instead of being
-- parked a year out for the retention sweep, which no longer looks for them.
-- Clear the ones already parked.
DELETE FROM jobs
WHERE type IN ('process_opml_import', 'fetch_full_content')
  AND running_since IS NULL
  AND next_run_at > now() + interval '180 days';
