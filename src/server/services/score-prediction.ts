/**
 * Score Prediction Service
 *
 * Trains and applies ML models to predict entry scores based on user interaction history.
 * Uses TF-IDF + Ridge Regression for personalized score prediction.
 *
 * See docs/features/score-prediction-design.md for design details.
 */

import { eq, and, sql, desc, inArray, isNotNull, or, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, userEntries, userScoreModels, entryScorePredictions } from "@/server/db/schema";
import { TfidfVectorizer, combineFeatures, type SparseVector } from "@/server/ml/tfidf";
import { RidgeRegression, crossValidate } from "@/server/ml/ridge";
import { logger } from "@/lib/logger";

// ============================================================================
// Configuration
// ============================================================================

/** Minimum number of rated entries required before training a model */
const MIN_TRAINING_ENTRIES = 20;

/** Maximum number of entries to use for training (memory constraint) */
const MAX_TRAINING_ENTRIES = 10000;

/** Maximum TF-IDF features.
 * With feed ID features this determines the Gram matrix size (features² × 8 bytes).
 * 3000 TF-IDF + 500 feeds = 3500 features → ~98 MB Gram matrix, fits in 512 MB worker. */
const MAX_TFIDF_FEATURES = 3000;

/** Maximum feed ID features for one-hot encoding.
 * Feeds beyond this are excluded from the feature vector (still used for TF-IDF text).
 * Keeps total features bounded: 3000 TF-IDF + 500 feeds = 3500 max. */
const MAX_FEED_FEATURES = 500;

/** Ridge regression alpha (L2 regularization strength) */
const RIDGE_ALPHA = 1.0;

/** Batch size for prediction inserts */
const PREDICTION_BATCH_SIZE = 100;

// ============================================================================
// Types
// ============================================================================

export interface TrainingData {
  entryId: string;
  feedId: string;
  text: string;
  score: number;
}

export interface TrainModelResult {
  success: boolean;
  trainingCount: number;
  modelVersion: number;
  cvMae?: number;
  cvCorrelation?: number;
  error?: string;
}

export interface PredictScoresResult {
  success: boolean;
  predictedCount: number;
  error?: string;
}

export interface ScorePrediction {
  entryId: string;
  predictedScore: number;
  confidence: number;
}

// ============================================================================
// Training Data Extraction
// ============================================================================

/**
 * Computes the effective score for an entry.
 * Priority: explicit score > implicit signals
 *
 * Implicit score mapping:
 * - has_starred = +2
 * - has_marked_unread = +1
 * - type = 'saved' = +1
 * - has_marked_read_on_list = -1
 * - default = 0
 */
function computeEffectiveScore(row: {
  score: number | null;
  hasStarred: boolean;
  hasMarkedUnread: boolean;
  hasMarkedReadOnList: boolean;
  type: "web" | "email" | "saved";
}): number {
  // Explicit score takes priority
  if (row.score !== null) {
    return row.score;
  }

  // Implicit score based on user actions
  if (row.hasStarred) return 2;
  if (row.hasMarkedUnread) return 1;
  if (row.type === "saved") return 1;
  if (row.hasMarkedReadOnList) return -1;

  return 0;
}

/**
 * Extracts text content from an entry for TF-IDF vectorization.
 * Combines title, summary, and content.
 */
function extractEntryText(entry: {
  title: string | null;
  summary: string | null;
  contentCleaned: string | null;
}): string {
  const parts: string[] = [];

  if (entry.title) {
    // Weight title more heavily by repeating it
    parts.push(entry.title, entry.title);
  }

  if (entry.summary) {
    parts.push(entry.summary);
  }

  if (entry.contentCleaned) {
    // Strip HTML tags for cleaner text
    const textContent = entry.contentCleaned
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Limit content length to avoid memory issues
    parts.push(textContent.slice(0, 5000));
  }

  return parts.join(" ");
}

/**
 * Fetches training data for a user.
 * Returns entries that have either explicit scores or implicit signals.
 */
async function getTrainingData(db: typeof dbType, userId: string): Promise<TrainingData[]> {
  // Query entries with scores or implicit signals
  const rows = await db
    .select({
      entryId: entries.id,
      feedId: entries.feedId,
      title: entries.title,
      summary: entries.summary,
      contentCleaned: entries.contentCleaned,
      type: entries.type,
      score: userEntries.score,
      hasStarred: userEntries.hasStarred,
      hasMarkedUnread: userEntries.hasMarkedUnread,
      hasMarkedReadOnList: userEntries.hasMarkedReadOnList,
    })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(
      and(
        eq(userEntries.userId, userId),
        // Only include entries with signals (score or implicit)
        or(
          isNotNull(userEntries.score),
          eq(userEntries.hasStarred, true),
          eq(userEntries.hasMarkedUnread, true),
          eq(userEntries.hasMarkedReadOnList, true),
          eq(entries.type, "saved")
        )
      )
    )
    .orderBy(desc(entries.id)) // Most recent first
    .limit(MAX_TRAINING_ENTRIES);

  return rows.map((row) => ({
    entryId: row.entryId,
    feedId: row.feedId,
    text: extractEntryText(row),
    score: computeEffectiveScore(row),
  }));
}

// ============================================================================
// Model Training
// ============================================================================

/**
 * Trains a score prediction model for a user.
 */
export async function trainModel(db: typeof dbType, userId: string): Promise<TrainModelResult> {
  logger.info("Starting model training", { userId });

  // Fetch training data
  const trainingData = await getTrainingData(db, userId);

  if (trainingData.length < MIN_TRAINING_ENTRIES) {
    logger.info("Not enough training data", {
      userId,
      count: trainingData.length,
      required: MIN_TRAINING_ENTRIES,
    });
    return {
      success: false,
      trainingCount: trainingData.length,
      modelVersion: 0,
      error: `Need at least ${MIN_TRAINING_ENTRIES} rated entries, have ${trainingData.length}`,
    };
  }

  // Extract feed IDs for one-hot encoding, capped to MAX_FEED_FEATURES.
  // Keep the most frequent feeds since they contribute the most training signal.
  const feedCounts = new Map<string, number>();
  for (const d of trainingData) {
    feedCounts.set(d.feedId, (feedCounts.get(d.feedId) ?? 0) + 1);
  }
  const feedIds = Array.from(feedCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FEED_FEATURES)
    .map(([id]) => id);
  const feedIdMap = new Map(feedIds.map((id, i) => [id, i]));

  // Prepare text documents
  const documents = trainingData.map((d) => d.text);
  const scores = trainingData.map((d) => d.score);

  // Fit TF-IDF vectorizer
  logger.debug("Fitting TF-IDF vectorizer", {
    userId,
    documentCount: documents.length,
  });

  const vectorizer = new TfidfVectorizer({
    maxFeatures: MAX_TFIDF_FEATURES,
    minDf: 2,
    maxDf: 0.95,
    useBigrams: true,
  });

  const tfidfVectors = vectorizer.fitTransform(documents);
  const tfidfFeatureCount = vectorizer.getFeatureCount();

  // Combine TF-IDF features with feed ID features
  const combinedVectors: SparseVector[] = trainingData.map((d, i) =>
    combineFeatures(tfidfVectors[i], d.feedId, feedIdMap, tfidfFeatureCount)
  );

  const totalFeatures = tfidfFeatureCount + feedIds.length;

  logger.debug("Training Ridge regression", {
    userId,
    sampleCount: trainingData.length,
    tfidfFeatures: tfidfFeatureCount,
    feedFeatures: feedIds.length,
    feedsCapped: feedCounts.size > MAX_FEED_FEATURES,
    totalFeedsInData: feedCounts.size,
    totalFeatures,
  });

  // Cross-validation for quality metrics
  const cvResults = crossValidate(combinedVectors, scores, totalFeatures, {
    alpha: RIDGE_ALPHA,
  });

  // Train final model on all data
  const model = new RidgeRegression({ alpha: RIDGE_ALPHA });
  model.fit(combinedVectors, scores, totalFeatures);

  // Serialize model
  const modelJson = model.serialize();
  const vocabulary = vectorizer.getVocabulary();
  const idfValues = vectorizer.getIdfValues();

  // Get current model version (if exists) to increment
  const [existingModel] = await db
    .select({ modelVersion: userScoreModels.modelVersion })
    .from(userScoreModels)
    .where(eq(userScoreModels.userId, userId))
    .limit(1);

  const newVersion = (existingModel?.modelVersion ?? 0) + 1;
  const now = new Date();

  // Upsert model
  await db
    .insert(userScoreModels)
    .values({
      userId,
      modelData: modelJson,
      vocabulary,
      idfValues,
      feedIds,
      trainingCount: trainingData.length,
      modelVersion: newVersion,
      trainedAt: now,
      cvMae: cvResults.mae,
      cvCorrelation: cvResults.correlation,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userScoreModels.userId,
      set: {
        modelData: modelJson,
        vocabulary,
        idfValues,
        feedIds,
        trainingCount: trainingData.length,
        modelVersion: newVersion,
        trainedAt: now,
        cvMae: cvResults.mae,
        cvCorrelation: cvResults.correlation,
        updatedAt: now,
      },
    });

  logger.info("Model training completed", {
    userId,
    trainingCount: trainingData.length,
    modelVersion: newVersion,
    cvMae: cvResults.mae,
    cvCorrelation: cvResults.correlation,
  });

  return {
    success: true,
    trainingCount: trainingData.length,
    modelVersion: newVersion,
    cvMae: cvResults.mae,
    cvCorrelation: cvResults.correlation,
  };
}

// ============================================================================
// Prediction
// ============================================================================

/**
 * Loads a user's trained model.
 */
async function loadModel(
  db: typeof dbType,
  userId: string
): Promise<{
  vectorizer: TfidfVectorizer;
  regression: RidgeRegression;
  feedIdMap: Map<string, number>;
  tfidfFeatureCount: number;
  modelVersion: number;
} | null> {
  const [modelRow] = await db
    .select()
    .from(userScoreModels)
    .where(eq(userScoreModels.userId, userId))
    .limit(1);

  if (!modelRow) {
    return null;
  }

  const vectorizer = TfidfVectorizer.fromSerialized(modelRow.vocabulary, modelRow.idfValues);

  const regression = RidgeRegression.deserialize(modelRow.modelData);

  const feedIdMap = new Map(modelRow.feedIds.map((id, i) => [id, i]));

  return {
    vectorizer,
    regression,
    feedIdMap,
    tfidfFeatureCount: modelRow.idfValues.length,
    modelVersion: modelRow.modelVersion,
  };
}

/**
 * Predicts scores for a batch of entries.
 */
export async function predictScores(
  db: typeof dbType,
  userId: string,
  entryIds?: string[]
): Promise<PredictScoresResult> {
  logger.info("Starting score prediction", { userId, entryCount: entryIds?.length ?? "all" });

  // Load model
  const modelData = await loadModel(db, userId);
  if (!modelData) {
    return {
      success: false,
      predictedCount: 0,
      error: "No trained model found",
    };
  }

  const { vectorizer, regression, feedIdMap, tfidfFeatureCount, modelVersion } = modelData;

  // Fetch entries to predict
  // If entryIds provided, use those; otherwise predict for entries without predictions
  let entriesToPredict: Array<{
    id: string;
    feedId: string;
    title: string | null;
    summary: string | null;
    contentCleaned: string | null;
  }>;

  if (entryIds && entryIds.length > 0) {
    entriesToPredict = await db
      .select({
        id: entries.id,
        feedId: entries.feedId,
        title: entries.title,
        summary: entries.summary,
        contentCleaned: entries.contentCleaned,
      })
      .from(entries)
      .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
      .where(and(eq(userEntries.userId, userId), inArray(entries.id, entryIds)));
  } else {
    // Find entries visible to user that don't have predictions yet
    // Join with user_entries to get only visible entries
    // Left join with predictions to filter out already predicted
    entriesToPredict = await db
      .select({
        id: entries.id,
        feedId: entries.feedId,
        title: entries.title,
        summary: entries.summary,
        contentCleaned: entries.contentCleaned,
      })
      .from(entries)
      .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
      .leftJoin(
        entryScorePredictions,
        and(eq(entryScorePredictions.entryId, entries.id), eq(entryScorePredictions.userId, userId))
      )
      .where(
        and(
          eq(userEntries.userId, userId),
          isNull(entryScorePredictions.entryId) // No existing prediction
        )
      )
      .orderBy(desc(entries.id))
      .limit(1000); // Limit batch size
  }

  if (entriesToPredict.length === 0) {
    logger.info("No entries to predict", { userId });
    return {
      success: true,
      predictedCount: 0,
    };
  }

  logger.debug("Predicting scores", {
    userId,
    entryCount: entriesToPredict.length,
  });

  // Generate predictions
  const predictions: Array<{
    userId: string;
    entryId: string;
    predictedScore: number;
    confidence: number;
    modelVersion: number;
    predictedAt: Date;
  }> = [];

  const now = new Date();

  for (const entry of entriesToPredict) {
    const text = extractEntryText(entry);
    const tfidfVector = vectorizer.transformSingle(text);
    const combinedVector = combineFeatures(tfidfVector, entry.feedId, feedIdMap, tfidfFeatureCount);

    const rawScore = regression.predictSingle(combinedVector);

    // Compute confidence based on feature coverage
    const featureCoverage = vectorizer.getFeatureCoverage(text);
    const feedKnown = feedIdMap.has(entry.feedId) ? 1.0 : 0.5;
    const confidence = featureCoverage * feedKnown;

    // Apply confidence-based shrinkage: uncertain predictions move toward 0
    const shrunkScore = rawScore * confidence;

    // Clip to valid range
    const clippedScore = Math.max(-2, Math.min(2, shrunkScore));

    predictions.push({
      userId,
      entryId: entry.id,
      predictedScore: clippedScore,
      confidence,
      modelVersion,
      predictedAt: now,
    });
  }

  // Insert predictions in batches
  for (let i = 0; i < predictions.length; i += PREDICTION_BATCH_SIZE) {
    const batch = predictions.slice(i, i + PREDICTION_BATCH_SIZE);
    await db
      .insert(entryScorePredictions)
      .values(batch)
      .onConflictDoUpdate({
        target: [entryScorePredictions.userId, entryScorePredictions.entryId],
        set: {
          predictedScore: sql`excluded.predicted_score`,
          confidence: sql`excluded.confidence`,
          modelVersion: sql`excluded.model_version`,
          predictedAt: sql`excluded.predicted_at`,
        },
      });
  }

  logger.info("Score prediction completed", {
    userId,
    predictedCount: predictions.length,
  });

  return {
    success: true,
    predictedCount: predictions.length,
  };
}

/**
 * Predicts scores for specific entries after a feed fetch.
 * Called inline by the feed fetcher for new/updated entries.
 *
 * For each user who:
 * 1. Has an active subscription to the feed
 * 2. Has a trained score model
 *
 * This predicts and stores scores for the given entry IDs.
 *
 * @param db - Database connection
 * @param feedId - The feed ID that was just fetched
 * @param entryIds - Entry IDs to predict scores for
 * @returns Count of predictions made
 */
export async function predictScoresForFeedEntries(
  db: typeof dbType,
  feedId: string,
  entryIds: string[]
): Promise<{ predictedCount: number }> {
  if (entryIds.length === 0) {
    return { predictedCount: 0 };
  }

  // Find users who:
  // 1. Have an active subscription to this feed
  // 2. Have a trained model
  const usersWithModels = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT s.user_id
    FROM subscriptions s
    INNER JOIN user_score_models usm ON usm.user_id = s.user_id
    WHERE s.feed_id = ${feedId}
      AND s.unsubscribed_at IS NULL
  `);

  if (usersWithModels.rows.length === 0) {
    logger.debug("No users with models subscribed to feed", { feedId });
    return { predictedCount: 0 };
  }

  let totalPredicted = 0;

  // Predict for each user
  for (const row of usersWithModels.rows) {
    const userId = row.user_id;

    try {
      const result = await predictScores(db, userId, entryIds);
      if (result.success) {
        totalPredicted += result.predictedCount;
      }
    } catch (error) {
      // Log but don't fail the feed fetch
      logger.warn("Failed to predict scores for user after feed fetch", {
        userId,
        feedId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.debug("Predicted scores for feed entries", {
    feedId,
    entryCount: entryIds.length,
    userCount: usersWithModels.rows.length,
    totalPredicted,
  });

  return { predictedCount: totalPredicted };
}
