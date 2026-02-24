-- Add user-configurable weights for the Best feed sorting formula.
-- The Best feed sorts by: score_weight * predicted_score + uncertainty_weight * (1 - confidence).
-- Both default to 1.0.
ALTER TABLE users ADD COLUMN best_feed_score_weight real NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN best_feed_uncertainty_weight real NOT NULL DEFAULT 1;
