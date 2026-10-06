-- PL/pgSQL may switch a function's queries to a generic plan after five calls
-- in a session, and whether it does depends on which users the connection
-- served first. For recompute_list_counters the generic plan is about 15x
-- slower for the heaviest libraries (#1862), so always plan per call.
-- CREATE OR REPLACE FUNCTION drops this setting unless it repeats the SET.
ALTER FUNCTION recompute_list_counters(uuid) SET plan_cache_mode = force_custom_plan;
