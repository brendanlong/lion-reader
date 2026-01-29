/**
 * Score Prediction Router
 *
 * Handles ML-based entry score prediction.
 * Trains per-user models and predicts scores for unrated entries.
 */

import { z } from "zod";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  hasEnoughTrainingData,
  trainModel,
  predictScores,
  getModelInfo,
  getPredictedScore,
} from "@/server/services/score-prediction";
import { createJob } from "@/server/jobs/queue";

// ============================================================================
// Validation Schemas
// ============================================================================

const trainInputSchema = z.object({
  /** Whether to run training asynchronously via job queue */
  async: z.boolean().optional().default(false),
});

const predictInputSchema = z.object({
  /** Specific entry IDs to predict (if omitted, predicts all unscored visible entries) */
  entryIds: z.array(z.string().uuid()).optional(),
  /** Whether to run prediction asynchronously via job queue */
  async: z.boolean().optional().default(false),
});

const getScoreInputSchema = z.object({
  entryId: z.string().uuid(),
});

// ============================================================================
// Output Schemas
// ============================================================================

const modelInfoSchema = z.object({
  hasModel: z.boolean(),
  trainingCount: z.number().optional(),
  modelVersion: z.number().optional(),
  trainedAt: z.date().optional(),
  cvMae: z.number().optional(),
  cvCorrelation: z.number().optional(),
  hasEnoughData: z.boolean(),
  minTrainingEntries: z.number(),
});

const trainResultSchema = z.object({
  success: z.boolean(),
  trainingCount: z.number(),
  modelVersion: z.number(),
  cvMae: z.number().optional(),
  cvCorrelation: z.number().optional(),
  error: z.string().optional(),
  async: z.boolean(),
});

const predictResultSchema = z.object({
  success: z.boolean(),
  predictedCount: z.number(),
  error: z.string().optional(),
  async: z.boolean(),
});

const scoreResultSchema = z.object({
  predictedScore: z.number().nullable(),
  confidence: z.number().nullable(),
});

// ============================================================================
// Constants
// ============================================================================

const MIN_TRAINING_ENTRIES = 20;

// ============================================================================
// Router
// ============================================================================

export const scorePredictionRouter = createTRPCRouter({
  /**
   * Get model info for the current user.
   * Returns whether a model exists, training stats, and CV metrics.
   */
  getModelInfo: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/score-prediction/model",
        tags: ["Score Prediction"],
        summary: "Get score prediction model info",
      },
    })
    .input(z.void())
    .output(modelInfoSchema)
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      const [modelInfo, hasEnough] = await Promise.all([
        getModelInfo(ctx.db, userId),
        hasEnoughTrainingData(ctx.db, userId),
      ]);

      return {
        ...modelInfo,
        hasEnoughData: hasEnough,
        minTrainingEntries: MIN_TRAINING_ENTRIES,
      };
    }),

  /**
   * Train a score prediction model for the current user.
   * Requires at least 20 rated entries (explicit or implicit scores).
   */
  train: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/score-prediction/train",
        tags: ["Score Prediction"],
        summary: "Train score prediction model",
      },
    })
    .input(trainInputSchema)
    .output(trainResultSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Check if there's enough training data
      const hasEnough = await hasEnoughTrainingData(ctx.db, userId);
      if (!hasEnough) {
        return {
          success: false,
          trainingCount: 0,
          modelVersion: 0,
          error: `Need at least ${MIN_TRAINING_ENTRIES} rated entries`,
          async: input.async,
        };
      }

      if (input.async) {
        // Queue training job
        await createJob({
          type: "train_score_model",
          payload: { userId },
          nextRunAt: new Date(),
        });

        return {
          success: true,
          trainingCount: 0,
          modelVersion: 0,
          async: true,
        };
      }

      // Train synchronously
      const result = await trainModel(ctx.db, userId);

      return {
        ...result,
        async: false,
      };
    }),

  /**
   * Predict scores for entries.
   * Requires a trained model.
   */
  predict: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/score-prediction/predict",
        tags: ["Score Prediction"],
        summary: "Predict scores for entries",
      },
    })
    .input(predictInputSchema)
    .output(predictResultSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Check if model exists
      const modelInfo = await getModelInfo(ctx.db, userId);
      if (!modelInfo.hasModel) {
        return {
          success: false,
          predictedCount: 0,
          error: "No trained model found. Train a model first.",
          async: input.async,
        };
      }

      if (input.async) {
        // Queue prediction job
        await createJob({
          type: "predict_scores",
          payload: { userId, entryIds: input.entryIds },
          nextRunAt: new Date(),
        });

        return {
          success: true,
          predictedCount: 0,
          async: true,
        };
      }

      // Predict synchronously
      const result = await predictScores(ctx.db, userId, input.entryIds);

      return {
        ...result,
        async: false,
      };
    }),

  /**
   * Get predicted score for a single entry.
   */
  getScore: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/score-prediction/score/{entryId}",
        tags: ["Score Prediction"],
        summary: "Get predicted score for an entry",
      },
    })
    .input(getScoreInputSchema)
    .output(scoreResultSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const prediction = await getPredictedScore(ctx.db, userId, input.entryId);

      if (!prediction) {
        return {
          predictedScore: null,
          confidence: null,
        };
      }

      return {
        predictedScore: prediction.predictedScore,
        confidence: prediction.confidence,
      };
    }),
});
