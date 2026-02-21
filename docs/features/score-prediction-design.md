# Score Prediction System Design

This document describes the background worker system for predicting entry scores based on user interaction history.

## Overview

The score prediction system uses machine learning to predict how much a user will like an entry based on:

1. Historical interaction data (stars, votes, read behavior)
2. Entry content (title, summary, cleaned content)
3. Feed metadata (title, URL, feed ID)

The system is designed to work with sparse data (users may have few ratings) and limited memory (256 MB typical deployment).

## Requirements

### Functional Requirements

- Train per-user models from interaction history
- Predict scores for new/unscored entries
- Output scores in the -2 to +2 range (matching explicit score range)
- Predict close to zero when uncertain (low confidence)
- Support thousands of entries per scoring run

### Non-Functional Requirements

- Memory: Target 256 MB, graceful degradation with more
- Incremental updates: Rescore recent entries more often than old
- Cold start handling: Reasonable behavior with few ratings
- No external ML services required (runs locally)

## Approach Comparison

### Option A: TF-IDF + Linear SVM (Recommended)

**Approach**: Similar to [arxiv-sanity-lite](https://github.com/karpathy/arxiv-sanity-lite):

1. Build TF-IDF vectors from entry text (title + summary + content)
2. Train LinearSVC on positive/negative examples
3. Use `decision_function()` for continuous scores
4. Shrink predictions toward zero based on confidence

**Pros**:

- Memory efficient (sparse matrices)
- Fast training and inference
- Interpretable (can show "why" via feature weights)
- Works well with sparse training data
- No GPU required

**Cons**:

- Keyword-based, not semantic
- Needs vocabulary management across users

### Option B: Sentence Embeddings + Nearest Neighbors

**Approach**:

1. Generate dense embeddings for entries using a small transformer
2. Find similar entries to user's liked/disliked entries
3. Score based on weighted similarity

**Pros**:

- Captures semantic meaning
- Better generalization to unseen vocabulary

**Cons**:

- Higher memory (dense vectors)
- Slower (transformer inference)
- Requires ONNX model download (~50-100 MB)

### Option C: Hybrid TF-IDF + Feed Features

**Approach**: Extend Option A with explicit feed-level signals:

1. TF-IDF for content matching
2. Add feed ID as a feature (learned preference per feed)
3. Use Ridge regression with L2 regularization

**Pros**:

- Learns "I like everything from feed X"
- Regularization naturally shrinks uncertain predictions
- Combines content + source signals

**Cons**:

- Slightly more complex
- Feed ID features are sparse

## Recommended Design: TF-IDF + Ridge Regression

We recommend **Option C** because:

1. Ridge regression naturally regularizes predictions toward zero when uncertain
2. Feed ID features capture source-level preferences explicitly requested
3. Memory efficient with sparse TF-IDF
4. L2 regularization provides exactly the "predict zero when uncertain" behavior

### Why Ridge Regression Over SVM?

While arxiv-sanity uses SVM, Ridge regression is better suited here because:

- **Continuous output**: Ridge directly outputs continuous values; SVM decision_function can be unbounded
- **Natural uncertainty**: L2 regularization shrinks predictions toward zero when features are sparse
- **Faster training**: No iterative optimization needed for small datasets
- **Better calibrated**: Output magnitude naturally reflects confidence

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Score Prediction Pipeline                     │
└─────────────────────────────────────────────────────────────────┘

1. DATA EXTRACTION
   ┌──────────────┐     ┌──────────────────────────────────────┐
   │   Database   │────▶│  Training Data (per user)            │
   │              │     │  - entry_id, feed_id                 │
   │  user_entries│     │  - title, author, summary, content   │
   │  entries     │     │  - score (explicit or implicit)      │
   │  feeds       │     │  - interaction timestamp             │
   └──────────────┘     └──────────────────────────────────────┘
                                         │
                                         ▼
2. FEATURE EXTRACTION
   ┌──────────────────────────────────────────────────────────────┐
   │  TfidfVectorizer (per user, fitted on their entries)         │
   │  - max_features: 5,000 (memory constraint)                   │
   │  - ngram_range: (1, 2) (unigrams + bigrams)                 │
   │  - min_df: 2 (ignore rare terms)                            │
   │  - max_df: 0.8 (ignore very common terms)                   │
   └──────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Combined Feature Vector                                      │
   │  [TF-IDF features (sparse)] + [feed_id one-hot (sparse)]     │
   └──────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
3. MODEL TRAINING
   ┌──────────────────────────────────────────────────────────────┐
   │  Ridge Regression                                             │
   │  - alpha: 1.0 (regularization strength)                      │
   │  - Target: score (-2 to +2)                                  │
   │  - Weights entries by recency (optional)                     │
   └──────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
4. PREDICTION & CALIBRATION
   ┌──────────────────────────────────────────────────────────────┐
   │  For each unscored entry:                                     │
   │  1. Extract features                                          │
   │  2. Predict raw score                                         │
   │  3. Clip to [-2, +2] range                                   │
   │  4. Apply confidence scaling (shrink toward 0)               │
   └──────────────────────────────────────────────────────────────┘
```

### Confidence-Based Shrinkage

To encourage predictions close to zero when uncertain, we apply shrinkage:

```typescript
function shrinkPrediction(rawScore: number, confidence: number): number {
  // confidence is in [0, 1], based on:
  // - Number of training examples
  // - Feature overlap with training data
  // - Model's cross-validation performance

  // Shrink toward zero proportionally to uncertainty
  return rawScore * confidence;
}
```

Confidence is estimated from:

1. **Training set size**: More examples = higher confidence
2. **Feature coverage**: What % of the entry's important terms were seen in training?
3. **Prediction variance**: If we train on subsets, how stable is the prediction?

### Database Schema

```sql
-- New table for predicted scores
CREATE TABLE entry_score_predictions (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,

  predicted_score REAL NOT NULL,        -- In range [-2, +2]
  confidence REAL NOT NULL,              -- In range [0, 1]

  model_version INTEGER NOT NULL,        -- For cache invalidation
  predicted_at TIMESTAMPTZ NOT NULL,

  PRIMARY KEY (user_id, entry_id)
);

-- Index for finding stale predictions
CREATE INDEX idx_entry_score_predictions_predicted_at
  ON entry_score_predictions(user_id, predicted_at);

-- Track model state per user
CREATE TABLE user_score_models (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Serialized model (sparse, typically <1 MB per user)
  model_data BYTEA,
  vocabulary JSONB,                      -- TF-IDF vocabulary
  feed_ids TEXT[],                       -- Feed ID mapping

  training_count INTEGER NOT NULL,       -- Number of training examples
  model_version INTEGER NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL,

  -- Performance metrics from cross-validation
  cv_mae REAL,                           -- Mean absolute error
  cv_correlation REAL                    -- Pearson correlation
);
```

### Job Queue Integration

Add new job types to the existing job queue:

```typescript
interface JobPayloads {
  // ... existing types

  // Train model for a single user
  train_score_model: {
    userId: string;
  };

  // Predict scores for a batch of entries
  predict_scores: {
    userId: string;
    entryIds: string[];
  };

  // Periodic job to trigger model training
  schedule_score_training: Record<string, never>;
}
```

### Training Data Selection

Only use entries where users have interacted:

```sql
SELECT
  e.id AS entry_id,
  e.feed_id,
  f.title AS feed_title,
  f.url AS feed_url,
  e.title,
  e.author,
  e.summary,
  COALESCE(e.content_cleaned, e.full_content_cleaned, e.content_original) AS content,
  -- Use explicit score if available, otherwise compute implicit
  COALESCE(
    ue.score,
    CASE
      WHEN ue.has_starred THEN 2
      WHEN ue.has_marked_unread THEN 1
      WHEN ue.has_marked_read_on_list THEN -1
      WHEN e.type = 'saved' THEN 1
      ELSE 0
    END
  ) AS score
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
JOIN feeds f ON f.id = e.feed_id
WHERE ue.user_id = $1
  -- Only entries with interaction signals
  AND (
    ue.score IS NOT NULL
    OR ue.starred_changed_at IS NOT NULL
    OR ue.read_changed_at IS NOT NULL
  )
  -- Exclude very old entries (optional, for memory)
  AND e.fetched_at > NOW() - INTERVAL '1 year'
ORDER BY e.fetched_at DESC
LIMIT 10000;  -- Cap for memory
```

### Memory Management

For 512 MB worker deployment:

| Component                                  | Estimated Memory |
| ------------------------------------------ | ---------------- |
| TF-IDF vectorizer (3K features)            | ~5 MB            |
| Gram matrix (3.5K features² × 8B)          | ~98 MB           |
| Feature means + X^T y vectors              | ~0.1 MB          |
| Ridge model weights                        | ~0.03 MB         |
| Training data (10K entries, text + scores) | ~40 MB           |
| Prediction batch (1K entries)              | ~20 MB           |
| Node.js baseline                           | ~80 MB           |
| **Peak per user (during training)**        | **~250 MB**      |

Key memory optimizations:

1. **Sparse X^T X accumulation**: The Gram matrix (X^T X) is computed directly from sparse TF-IDF vectors — the full dense design matrix (n × features) is never materialized
2. **Cholesky solve in-place**: Solves the normal equations without creating an augmented matrix (saves features × features bytes vs Gauss-Jordan)
3. **3-fold CV** (not 5): Reduces peak memory by running fewer training iterations
4. **3,000 max TF-IDF features**: Keeps the Gram matrix under 100 MB
5. Process one user at a time (no parallelism)
6. Stream entries in batches for prediction

### Scoring Schedule

```
┌─────────────────────────────────────────────────────────────────┐
│                      Scoring Schedule                            │
├─────────────────────────────────────────────────────────────────┤
│  Daily:                                                          │
│  - Retrain models for users with new interactions                │
│  - Score entries from last 7 days                                │
│                                                                  │
│  Weekly:                                                         │
│  - Full model retrain for all active users                       │
│  - Rescore all unscored entries                                  │
│                                                                  │
│  On-demand:                                                      │
│  - When user views entry list, score recent unscored entries     │
│  - Rate limited to prevent abuse                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Cold Start Handling

When a user has few interactions (< 20 rated entries):

1. **Don't predict**: Return `null` for predicted scores
2. **Show uncertainty**: If predicting, set confidence very low
3. **Encourage rating**: UI prompts to rate more entries
4. **Feed-level fallback**: If user likes most entries from a feed, assume +1 for new entries from that feed

### Implementation Phases

#### Phase 1: Data Pipeline

- Add `entry_score_predictions` table
- Add `user_score_models` table
- Create training data extraction query
- Add job types to queue

#### Phase 2: Model Training

- Implement TF-IDF vectorization in TypeScript
- Implement Ridge regression (or use a minimal library)
- Serialize/deserialize model state
- Cross-validation for confidence estimation

#### Phase 3: Prediction & Integration

- Batch prediction for new entries
- API endpoint to get predicted scores
- Cache invalidation on new interactions
- UI integration (show predicted scores)

#### Phase 4: Optimization

- Incremental model updates
- Smarter retraining triggers
- A/B testing score quality
- User feedback on predictions

## Alternatives Considered

### External ML Service

Using an external service (like a Python sidecar or cloud ML):

- **Pro**: More sophisticated models, GPU acceleration
- **Con**: Additional infrastructure, latency, cost
- **Decision**: Not recommended for initial version; can add later

### LLM-Based Scoring

Using Anthropic/Groq to score entries:

- **Pro**: Semantic understanding, no training needed
- **Con**: API costs scale with entries, latency
- **Decision**: Too expensive for bulk scoring; consider for explanation

### Collaborative Filtering

Using other users' ratings to predict:

- **Pro**: Works without content analysis
- **Con**: Privacy concerns (sharing ratings), cold start for new feeds
- **Decision**: Not recommended; users don't share data

## Sharing Scores Across Users?

The user asked whether scores should be shared. Considerations:

**Reasons to share:**

- Addresses sparse data problem
- New users get predictions immediately
- Community signal on quality

**Reasons not to share:**

- Privacy: reveals reading habits
- Personalization: what I like differs from what you like
- Gaming: bad actors could manipulate scores

**Recommendation**: Don't share scores by default. Consider:

- Opt-in "community scores" as a separate signal
- Anonymous, aggregated signals (e.g., "60% of readers finished this")
- Feed-level quality metrics visible to all

## Metrics & Monitoring

Track model quality:

- **MAE**: Mean absolute error on held-out data
- **Correlation**: Pearson correlation with actual scores
- **Calibration**: Predicted vs actual score distribution
- **Coverage**: % of entries with predictions

Track system health:

- Model training time per user
- Prediction latency
- Memory usage during training
- Job queue depth

## References

- [arxiv-sanity-lite](https://github.com/karpathy/arxiv-sanity-lite) - TF-IDF + SVM for paper recommendations
- [scikit-learn Ridge Regression](https://scikit-learn.org/stable/modules/linear_model.html#ridge-regression) - L2-regularized regression
- [TF-IDF vs Sentence Embeddings](https://medium.com/@venugopal.adep/comparative-study-of-text-embeddings-tf-idf-vs-sentence-transformer-28627c315f21) - Comparison study
- [Calibrated Regression](https://arxiv.org/abs/1807.00263) - Uncertainty quantification
