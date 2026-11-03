-- Each user's plan, which sets their quotas (#2222). Existing users start on
-- unlimited, which keeps their limits as they were on every instance; an
-- operator moves them to another plan explicitly. New accounts get the
-- instance's default plan from the app.
ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'unlimited'
  CONSTRAINT users_plan_known CHECK (plan IN ('free', 'paid', 'unlimited'));
