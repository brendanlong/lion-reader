/**
 * Ridge Regression Implementation
 *
 * A lightweight TypeScript implementation of Ridge (L2-regularized) linear regression.
 * Uses the closed-form solution: w = (X^T X + λI)^(-1) X^T y
 *
 * Memory-efficient: computes X^T X and X^T y directly from sparse vectors,
 * never materializing the full dense design matrix. Uses Cholesky decomposition
 * to solve the system in-place, avoiding the augmented matrix needed by
 * Gauss-Jordan elimination.
 *
 * Memory usage: O(features²) for the Gram matrix, independent of sample count.
 * With 3,000 features this is ~72 MB; with 5,000 features it's ~200 MB.
 */

import { type SparseVector } from "./tfidf";

/**
 * Ridge regression model weights and configuration.
 */
export interface RidgeModel {
  /** Model weights (one per feature) */
  weights: number[];
  /** Intercept term */
  intercept: number;
  /** Regularization strength used during training */
  alpha: number;
  /** Number of features */
  numFeatures: number;
}

/**
 * Configuration for Ridge regression.
 */
export interface RidgeConfig {
  /** L2 regularization strength (default: 1.0) */
  alpha: number;
  /** Whether to fit an intercept term (default: true) */
  fitIntercept: boolean;
}

const DEFAULT_CONFIG: RidgeConfig = {
  alpha: 1.0,
  fitIntercept: true,
};

/**
 * Computes mean of an array.
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

/**
 * Computes feature means from sparse vectors.
 * Returns a dense array of means (one per feature).
 */
function computeFeatureMeans(X: SparseVector[], numFeatures: number, nSamples: number): number[] {
  const sums = new Array<number>(numFeatures).fill(0);
  for (const vec of X) {
    for (const [index, value] of vec) {
      sums[index] += value;
    }
  }
  for (let j = 0; j < numFeatures; j++) {
    sums[j] /= nSamples;
  }
  return sums;
}

/**
 * Computes X^T X directly from sparse vectors, optionally with mean-centering.
 *
 * For centered data: (X - μ)^T (X - μ) = X^T X - n * μ μ^T
 * where μ is the column-wise mean vector.
 *
 * This avoids materializing the dense n×p matrix entirely.
 * Memory: O(p²) for the result matrix.
 */
function sparseXtX(
  X: SparseVector[],
  numFeatures: number,
  featureMeans: number[] | null
): Float64Array {
  const p = numFeatures;
  // Use a flat Float64Array for better memory efficiency than number[][]
  const result = new Float64Array(p * p);

  // Accumulate X^T X from sparse vectors
  for (const vec of X) {
    const len = vec.length;
    for (let a = 0; a < len; a++) {
      const [i, vi] = vec[a];
      // Diagonal
      result[i * p + i] += vi * vi;
      // Upper triangle (symmetric)
      for (let b = a + 1; b < len; b++) {
        const [j, vj] = vec[b];
        const prod = vi * vj;
        result[i * p + j] += prod;
        result[j * p + i] += prod;
      }
    }
  }

  // If centering: subtract n * μ μ^T
  if (featureMeans) {
    const n = X.length;
    for (let i = 0; i < p; i++) {
      if (featureMeans[i] === 0) continue;
      for (let j = i; j < p; j++) {
        if (featureMeans[j] === 0) continue;
        const correction = n * featureMeans[i] * featureMeans[j];
        result[i * p + j] -= correction;
        if (i !== j) {
          result[j * p + i] -= correction;
        }
      }
    }
  }

  return result;
}

/**
 * Computes X^T y directly from sparse vectors, optionally with mean-centering.
 *
 * For centered data: (X - μ)^T (y - ȳ) = X^T y_adj - n * μ * ȳ_adj
 * But since y is already adjusted (ȳ_adj = 0), this simplifies to X^T y_adj - μ * sum(y_adj).
 * And sum(y_adj) = 0 when y is centered, so: (X - μ)^T y_adj = X^T y_adj
 *
 * Wait — that's only true when y_adj is perfectly centered. Since we center y ourselves,
 * sum(y_adj) = 0, so no correction needed for X^T y when y is centered.
 */
function sparseXty(
  X: SparseVector[],
  y: number[],
  numFeatures: number,
  featureMeans: number[] | null
): Float64Array {
  const result = new Float64Array(numFeatures);

  for (let i = 0; i < X.length; i++) {
    const yi = y[i];
    if (yi === 0) continue;
    for (const [index, value] of X[i]) {
      result[index] += value * yi;
    }
  }

  // When both X and y are centered:
  // (X-μ)^T (y-ȳ) = X^T(y-ȳ) - μ·Σ(y-ȳ)
  // Since y is centered, Σ(y-ȳ) = 0, so no correction needed.
  // But featureMeans correction is needed for the X centering when y_adj isn't exactly zero-sum
  // (floating point). For safety, apply the correction:
  if (featureMeans) {
    let ySum = 0;
    for (let i = 0; i < y.length; i++) {
      ySum += y[i];
    }
    if (ySum !== 0) {
      for (let j = 0; j < numFeatures; j++) {
        result[j] -= featureMeans[j] * ySum;
      }
    }
  }

  return result;
}

/**
 * Solves (A + αI)x = b in-place using Cholesky decomposition.
 * A must be symmetric positive semi-definite (which X^T X always is).
 * Adding αI (α > 0) makes it positive definite, guaranteeing Cholesky succeeds.
 *
 * Modifies `A` in-place (stores the lower triangular factor L).
 * Returns the solution vector x, or null if decomposition fails.
 *
 * Memory: O(1) extra beyond the input matrix (solves in-place).
 */
function choleskySolve(
  A: Float64Array,
  b: Float64Array,
  n: number,
  alpha: number
): number[] | null {
  // Add regularization in-place: A += αI
  for (let i = 0; i < n; i++) {
    A[i * n + i] += alpha;
  }

  // Cholesky decomposition: A = L L^T (in-place, lower triangle)
  for (let j = 0; j < n; j++) {
    let sum = A[j * n + j];
    for (let k = 0; k < j; k++) {
      sum -= A[j * n + k] * A[j * n + k];
    }
    if (sum <= 0) {
      return null; // Not positive definite
    }
    const ljj = Math.sqrt(sum);
    A[j * n + j] = ljj;

    for (let i = j + 1; i < n; i++) {
      sum = A[i * n + j];
      for (let k = 0; k < j; k++) {
        sum -= A[i * n + k] * A[j * n + k];
      }
      A[i * n + j] = sum / ljj;
    }
  }

  // Forward substitution: L z = b
  const z = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) {
      sum -= A[i * n + k] * z[k];
    }
    z[i] = sum / A[i * n + i];
  }

  // Back substitution: L^T x = z
  const x = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i];
    for (let k = i + 1; k < n; k++) {
      sum -= A[k * n + i] * x[k]; // L^T[i][k] = L[k][i]
    }
    x[i] = sum / A[i * n + i];
  }

  return x;
}

/**
 * Ridge Regression
 *
 * Solves: min ||Xw - y||² + α||w||²
 * Closed-form solution: w = (X^T X + αI)^(-1) X^T y
 *
 * Implementation uses sparse X^T X accumulation + Cholesky solve,
 * avoiding dense matrix materialization entirely.
 */
export class RidgeRegression {
  private config: RidgeConfig;
  private model: RidgeModel | null = null;

  constructor(config: Partial<RidgeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Fits the model on training data.
   *
   * @param X Feature vectors (sparse format)
   * @param y Target values
   * @param numFeatures Total number of features
   */
  fit(X: SparseVector[], y: number[], numFeatures: number): void {
    if (X.length !== y.length) {
      throw new Error("X and y must have the same number of samples");
    }
    if (X.length === 0) {
      throw new Error("Cannot fit with zero samples");
    }

    const nSamples = X.length;

    // Center y if fitting intercept
    let yMean = 0;
    let yAdjusted = y;
    if (this.config.fitIntercept) {
      yMean = mean(y);
      yAdjusted = y.map((val) => val - yMean);
    }

    // Compute feature means for centering (only if fitting intercept)
    const featureMeans = this.config.fitIntercept
      ? computeFeatureMeans(X, numFeatures, nSamples)
      : null;

    // Compute X^T X directly from sparse vectors (with centering correction)
    const XtX = sparseXtX(X, numFeatures, featureMeans);

    // Compute X^T y directly from sparse vectors
    const Xty = sparseXty(X, yAdjusted, numFeatures, featureMeans);

    // Solve (X^T X + αI) w = X^T y via Cholesky decomposition
    // Note: choleskySolve modifies XtX in-place
    const weights = choleskySolve(XtX, Xty, numFeatures, this.config.alpha);
    if (!weights) {
      throw new Error("Cholesky decomposition failed - matrix not positive definite");
    }

    // Compute intercept: yMean - Σ(w_j * featureMean_j)
    let intercept = yMean;
    if (this.config.fitIntercept && featureMeans) {
      for (let j = 0; j < numFeatures; j++) {
        intercept -= weights[j] * featureMeans[j];
      }
    }

    this.model = {
      weights,
      intercept,
      alpha: this.config.alpha,
      numFeatures,
    };
  }

  /**
   * Predicts target values for new samples.
   *
   * @param X Feature vectors (sparse format)
   * @returns Predicted values
   */
  predict(X: SparseVector[]): number[] {
    if (!this.model) {
      throw new Error("Model must be fitted before prediction");
    }

    return X.map((vec) => this.predictSingle(vec));
  }

  /**
   * Predicts a single sample.
   */
  predictSingle(x: SparseVector): number {
    if (!this.model) {
      throw new Error("Model must be fitted before prediction");
    }

    let prediction = this.model.intercept;
    for (const [index, value] of x) {
      if (index < this.model.weights.length) {
        prediction += this.model.weights[index] * value;
      }
    }

    return prediction;
  }

  /**
   * Gets the model for serialization.
   */
  getModel(): RidgeModel | null {
    return this.model;
  }

  /**
   * Gets the model weights.
   */
  getWeights(): number[] {
    if (!this.model) {
      throw new Error("Model must be fitted first");
    }
    return [...this.model.weights];
  }

  /**
   * Gets the intercept.
   */
  getIntercept(): number {
    if (!this.model) {
      throw new Error("Model must be fitted first");
    }
    return this.model.intercept;
  }

  /**
   * Creates a regression model from serialized weights.
   */
  static fromModel(model: RidgeModel): RidgeRegression {
    const regression = new RidgeRegression({ alpha: model.alpha });
    regression.model = { ...model };
    return regression;
  }

  /**
   * Serializes the model to a JSON string.
   */
  serialize(): string {
    if (!this.model) {
      throw new Error("Model must be fitted before serialization");
    }
    return JSON.stringify(this.model);
  }

  /**
   * Deserializes a model from a JSON string.
   */
  static deserialize(json: string): RidgeRegression {
    const model = JSON.parse(json) as RidgeModel;
    return RidgeRegression.fromModel(model);
  }
}

/**
 * Computes cross-validation metrics for model quality assessment.
 *
 * @param X Feature vectors
 * @param y Target values
 * @param numFeatures Total number of features
 * @param config Ridge configuration
 * @param nFolds Number of CV folds (default: 3)
 * @returns MAE and Pearson correlation
 */
export function crossValidate(
  X: SparseVector[],
  y: number[],
  numFeatures: number,
  config: Partial<RidgeConfig> = {},
  nFolds: number = 3
): { mae: number; correlation: number } {
  const nSamples = X.length;
  if (nSamples < nFolds) {
    // Not enough samples for CV, return NaN
    return { mae: NaN, correlation: NaN };
  }

  const foldSize = Math.floor(nSamples / nFolds);
  const predictions: number[] = new Array(nSamples);
  const actuals: number[] = [...y];

  // Create shuffled indices for CV
  const indices = Array.from({ length: nSamples }, (_, i) => i);
  for (let i = nSamples - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  for (let fold = 0; fold < nFolds; fold++) {
    const testStart = fold * foldSize;
    const testEnd = fold === nFolds - 1 ? nSamples : (fold + 1) * foldSize;

    // Split data
    const trainIndices: number[] = [];
    const testIndices: number[] = [];

    for (let i = 0; i < nSamples; i++) {
      if (i >= testStart && i < testEnd) {
        testIndices.push(indices[i]);
      } else {
        trainIndices.push(indices[i]);
      }
    }

    const XTrain = trainIndices.map((i) => X[i]);
    const yTrain = trainIndices.map((i) => y[i]);
    const XTest = testIndices.map((i) => X[i]);

    // Train and predict
    const model = new RidgeRegression(config);
    model.fit(XTrain, yTrain, numFeatures);
    const foldPredictions = model.predict(XTest);

    // Store predictions
    for (let i = 0; i < testIndices.length; i++) {
      predictions[testIndices[i]] = foldPredictions[i];
    }
  }

  // Compute MAE
  let totalAbsError = 0;
  for (let i = 0; i < nSamples; i++) {
    totalAbsError += Math.abs(predictions[i] - actuals[i]);
  }
  const mae = totalAbsError / nSamples;

  // Compute Pearson correlation
  const meanPred = mean(predictions);
  const meanActual = mean(actuals);

  let numerator = 0;
  let denomPred = 0;
  let denomActual = 0;

  for (let i = 0; i < nSamples; i++) {
    const diffPred = predictions[i] - meanPred;
    const diffActual = actuals[i] - meanActual;
    numerator += diffPred * diffActual;
    denomPred += diffPred * diffPred;
    denomActual += diffActual * diffActual;
  }

  const correlation =
    denomPred > 0 && denomActual > 0 ? numerator / Math.sqrt(denomPred * denomActual) : 0;

  return { mae, correlation };
}
