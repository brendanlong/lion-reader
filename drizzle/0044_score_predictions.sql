-- Migration: Add score prediction tables for ML-based entry scoring
--
-- Two new tables:
-- 1. user_score_models - stores trained ML models per user
-- 2. entry_score_predictions - stores predicted scores for entries
--
-- See docs/features/score-prediction-design.md for design details.

-- User score models table - stores serialized TF-IDF + Ridge regression models
CREATE TABLE user_score_models (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Serialized model data (Ridge weights as JSON)
  model_data text NOT NULL,

  -- Model metadata for feature extraction
  vocabulary jsonb NOT NULL,           -- TF-IDF vocabulary: {term: index}
  idf_values jsonb NOT NULL,           -- IDF values: [float, ...]
  feed_ids text[] NOT NULL,            -- Feed ID mapping for one-hot encoding

  -- Training info
  training_count integer NOT NULL,     -- Number of entries used for training
  model_version integer NOT NULL DEFAULT 1,
  trained_at timestamptz NOT NULL DEFAULT now(),

  -- Cross-validation metrics (for confidence estimation)
  cv_mae real,                         -- Mean Absolute Error
  cv_correlation real,                 -- Pearson correlation

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Entry score predictions table - stores predicted scores for entries
CREATE TABLE entry_score_predictions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES entries(id) ON DELETE CASCADE,

  -- Prediction results
  predicted_score real NOT NULL,       -- Raw prediction (may be outside -2 to +2)
  confidence real NOT NULL,            -- 0 to 1, based on feature coverage

  -- Metadata
  model_version integer NOT NULL,      -- Version of model used
  predicted_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, entry_id)
);

-- Indexes for efficient querying
CREATE INDEX idx_entry_score_predictions_entry ON entry_score_predictions(entry_id);
CREATE INDEX idx_entry_score_predictions_user_score ON entry_score_predictions(user_id, predicted_score DESC);
CREATE INDEX idx_user_score_models_trained ON user_score_models(trained_at);
