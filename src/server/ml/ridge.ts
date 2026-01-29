/**
 * Ridge Regression Implementation
 *
 * A lightweight TypeScript implementation of Ridge (L2-regularized) linear regression.
 * Uses the closed-form solution: w = (X^T X + λI)^(-1) X^T y
 *
 * Designed for memory efficiency with the score prediction use case:
 * - ~5,000 features (TF-IDF + feed IDs)
 * - ~1,000-10,000 training samples
 * - Single output (predicted score)
 */

import { type SparseVector, sparseToDense } from "./tfidf";

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
 * Simple matrix type for internal calculations.
 * Row-major order: data[row][col]
 */
type Matrix = number[][];

/**
 * Creates a zero matrix of given dimensions.
 */
function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array(cols).fill(0));
}

/**
 * Creates an identity matrix of given size.
 */
function eye(size: number): Matrix {
  const result = zeros(size, size);
  for (let i = 0; i < size; i++) {
    result[i][i] = 1;
  }
  return result;
}

/**
 * Matrix transpose.
 */
function transpose(A: Matrix): Matrix {
  const rows = A.length;
  const cols = A[0].length;
  const result = zeros(cols, rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j][i] = A[i][j];
    }
  }
  return result;
}

/**
 * Matrix multiplication: A @ B
 */
function matmul(A: Matrix, B: Matrix): Matrix {
  const rowsA = A.length;
  const colsA = A[0].length;
  const colsB = B[0].length;

  const result = zeros(rowsA, colsB);
  for (let i = 0; i < rowsA; i++) {
    for (let j = 0; j < colsB; j++) {
      let sum = 0;
      for (let k = 0; k < colsA; k++) {
        sum += A[i][k] * B[k][j];
      }
      result[i][j] = sum;
    }
  }
  return result;
}

/**
 * Matrix-vector multiplication: A @ v
 */
function matvec(A: Matrix, v: number[]): number[] {
  const rows = A.length;
  const cols = A[0].length;
  const result = new Array(rows).fill(0);
  for (let i = 0; i < rows; i++) {
    let sum = 0;
    for (let j = 0; j < cols; j++) {
      sum += A[i][j] * v[j];
    }
    result[i] = sum;
  }
  return result;
}

/**
 * Matrix addition: A + B
 */
function matadd(A: Matrix, B: Matrix): Matrix {
  const rows = A.length;
  const cols = A[0].length;
  const result = zeros(rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[i][j] = A[i][j] + B[i][j];
    }
  }
  return result;
}

/**
 * Scalar multiplication: c * A
 */
function scalarMul(c: number, A: Matrix): Matrix {
  return A.map((row) => row.map((val) => c * val));
}

/**
 * Matrix inversion using Gauss-Jordan elimination.
 * Returns null if matrix is singular.
 */
function inverse(A: Matrix): Matrix | null {
  const n = A.length;
  if (n === 0 || A[0].length !== n) {
    return null;
  }

  // Create augmented matrix [A | I]
  const aug: Matrix = zeros(n, 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      aug[i][j] = A[i][j];
    }
    aug[i][n + i] = 1;
  }

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      const absVal = Math.abs(aug[row][col]);
      if (absVal > maxVal) {
        maxVal = absVal;
        maxRow = row;
      }
    }

    // Check for singularity
    if (maxVal < 1e-10) {
      return null;
    }

    // Swap rows
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    // Scale pivot row
    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    // Eliminate column
    for (let row = 0; row < n; row++) {
      if (row !== col) {
        const factor = aug[row][col];
        for (let j = 0; j < 2 * n; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }
  }

  // Extract inverse from augmented matrix
  const inv = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      inv[i][j] = aug[i][n + j];
    }
  }

  return inv;
}

/**
 * Converts sparse vectors to a dense matrix.
 * Each row is one sample.
 */
function sparseToDenseMatrix(vectors: SparseVector[], numFeatures: number): Matrix {
  return vectors.map((vec) => sparseToDense(vec, numFeatures));
}

/**
 * Computes mean of an array.
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

/**
 * Ridge Regression
 *
 * Solves: min ||Xw - y||² + α||w||²
 * Closed-form solution: w = (X^T X + αI)^(-1) X^T y
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
   * @param numFeatures Total number of features (needed for sparse to dense conversion)
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

    // Convert sparse to dense
    const XDense = sparseToDenseMatrix(X, numFeatures);

    // Center X if fitting intercept (mean-center each feature)
    const featureMeans = new Array(numFeatures).fill(0);
    if (this.config.fitIntercept) {
      for (let j = 0; j < numFeatures; j++) {
        let sum = 0;
        for (let i = 0; i < nSamples; i++) {
          sum += XDense[i][j];
        }
        featureMeans[j] = sum / nSamples;
      }
      for (let i = 0; i < nSamples; i++) {
        for (let j = 0; j < numFeatures; j++) {
          XDense[i][j] -= featureMeans[j];
        }
      }
    }

    // Compute X^T X
    const Xt = transpose(XDense);
    const XtX = matmul(Xt, XDense);

    // Add regularization: X^T X + αI
    const alphaI = scalarMul(this.config.alpha, eye(numFeatures));
    const XtXReg = matadd(XtX, alphaI);

    // Compute (X^T X + αI)^(-1)
    const XtXRegInv = inverse(XtXReg);
    if (!XtXRegInv) {
      throw new Error("Matrix is singular, cannot compute inverse");
    }

    // Compute X^T y
    const Xty = matvec(Xt, yAdjusted);

    // Compute weights: w = (X^T X + αI)^(-1) X^T y
    const weights = matvec(XtXRegInv, Xty);

    // Compute intercept
    let intercept = yMean;
    if (this.config.fitIntercept) {
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
 * @param nFolds Number of CV folds (default: 5)
 * @returns MAE and Pearson correlation
 */
export function crossValidate(
  X: SparseVector[],
  y: number[],
  numFeatures: number,
  config: Partial<RidgeConfig> = {},
  nFolds: number = 5
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
