-- Each user's plan, which sets their quotas (#2222). Existing users are
-- grandfathered onto the paid plan; new accounts get the instance's default
-- plan from the app.
ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'paid'
  CONSTRAINT users_plan_known CHECK (plan IN ('free', 'paid', 'unlimited'));
