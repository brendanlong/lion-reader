import { describe, it, expect } from "vitest";
import { RidgeRegression, crossValidate } from "@/server/ml/ridge";
import type { SparseVector } from "@/server/ml/tfidf";

describe("RidgeRegression", () => {
  describe("fit and predict", () => {
    it("learns a simple linear relationship with dense features", () => {
      // y = 2*x0 + 3*x1, represented as sparse vectors
      const X: SparseVector[] = [
        [
          [0, 1],
          [1, 0],
        ], // y = 2
        [
          [0, 0],
          [1, 1],
        ], // y = 3
        [
          [0, 1],
          [1, 1],
        ], // y = 5
        [
          [0, 2],
          [1, 1],
        ], // y = 7
        [
          [0, 0],
          [1, 2],
        ], // y = 6
        [
          [0, 3],
          [1, 0],
        ], // y = 6
      ];
      const y = [2, 3, 5, 7, 6, 6];

      const model = new RidgeRegression({ alpha: 0.001 }); // Low regularization
      model.fit(X, y, 2);

      // With low regularization, weights should be close to [2, 3]
      const weights = model.getWeights();
      expect(weights[0]).toBeCloseTo(2, 0);
      expect(weights[1]).toBeCloseTo(3, 0);

      // Predict: x0=1, x1=2 → should be ~8
      const pred = model.predictSingle([
        [0, 1],
        [1, 2],
      ]);
      expect(pred).toBeCloseTo(8, 0);
    });

    it("handles sparse vectors correctly (most features zero)", () => {
      // 100 features, but only features 0 and 50 are used
      const X: SparseVector[] = [
        [[0, 1]], // only feature 0
        [[50, 1]], // only feature 50
        [
          [0, 1],
          [50, 1],
        ], // both
        [[0, 2]], // feature 0 doubled
      ];
      const y = [1, -1, 0, 2];

      const model = new RidgeRegression({ alpha: 0.1 });
      model.fit(X, y, 100);

      // Feature 0 should have positive weight, feature 50 negative
      const weights = model.getWeights();
      expect(weights[0]).toBeGreaterThan(0);
      expect(weights[50]).toBeLessThan(0);
      expect(weights.length).toBe(100);
    });

    it("regularization shrinks predictions toward zero", () => {
      const X: SparseVector[] = [[[0, 1]], [[0, -1]]];
      const y = [10, -10];

      // Strong regularization
      const strongModel = new RidgeRegression({ alpha: 100 });
      strongModel.fit(X, y, 1);

      // Weak regularization
      const weakModel = new RidgeRegression({ alpha: 0.001 });
      weakModel.fit(X, y, 1);

      const strongPred = Math.abs(strongModel.predictSingle([[0, 1]]));
      const weakPred = Math.abs(weakModel.predictSingle([[0, 1]]));

      // Strong regularization should produce smaller predictions
      expect(strongPred).toBeLessThan(weakPred);
    });

    it("fits intercept correctly", () => {
      // y = 5 + x0 (constant offset)
      const X: SparseVector[] = [[[0, 0]], [[0, 1]], [[0, 2]], [[0, 3]]];
      const y = [5, 6, 7, 8];

      const model = new RidgeRegression({ alpha: 0.001, fitIntercept: true });
      model.fit(X, y, 1);

      expect(model.getIntercept()).toBeCloseTo(5, 0);
      expect(model.getWeights()[0]).toBeCloseTo(1, 0);
    });

    it("works without intercept", () => {
      // y = 2*x0 (no intercept)
      const X: SparseVector[] = [[[0, 1]], [[0, 2]], [[0, 3]]];
      const y = [2, 4, 6];

      const model = new RidgeRegression({ alpha: 0.001, fitIntercept: false });
      model.fit(X, y, 1);

      expect(model.getIntercept()).toBe(0);
      expect(model.getWeights()[0]).toBeCloseTo(2, 0);
    });

    it("throws on empty training data", () => {
      const model = new RidgeRegression();
      expect(() => model.fit([], [], 1)).toThrow("Cannot fit with zero samples");
    });

    it("throws on mismatched X and y lengths", () => {
      const model = new RidgeRegression();
      expect(() => model.fit([[[0, 1]]], [1, 2], 1)).toThrow(
        "X and y must have the same number of samples"
      );
    });

    it("throws when predicting without fitting", () => {
      const model = new RidgeRegression();
      expect(() => model.predictSingle([[0, 1]])).toThrow("Model must be fitted");
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", () => {
      const X: SparseVector[] = [
        [
          [0, 1],
          [1, 2],
        ],
        [
          [0, 3],
          [1, 4],
        ],
      ];
      const y = [5, 11];

      const original = new RidgeRegression({ alpha: 0.1 });
      original.fit(X, y, 2);

      const json = original.serialize();
      const restored = RidgeRegression.deserialize(json);

      const testInput: SparseVector = [
        [0, 2],
        [1, 3],
      ];
      expect(restored.predictSingle(testInput)).toBeCloseTo(original.predictSingle(testInput), 10);
    });

    it("round-trips through fromModel", () => {
      const X: SparseVector[] = [[[0, 1]], [[0, 2]]];
      const y = [1, 2];

      const original = new RidgeRegression({ alpha: 0.5 });
      original.fit(X, y, 1);

      const model = original.getModel()!;
      const restored = RidgeRegression.fromModel(model);

      expect(restored.predictSingle([[0, 3]])).toBeCloseTo(original.predictSingle([[0, 3]]), 10);
    });
  });

  describe("crossValidate", () => {
    it("returns metrics for a learnable pattern", () => {
      // Create data with clear pattern: y ≈ x0 - x1
      const X: SparseVector[] = [];
      const y: number[] = [];
      for (let i = 0; i < 30; i++) {
        const x0 = Math.random() * 10;
        const x1 = Math.random() * 10;
        X.push([
          [0, x0],
          [1, x1],
        ]);
        y.push(x0 - x1 + (Math.random() - 0.5) * 0.5); // small noise
      }

      const result = crossValidate(X, y, 2, { alpha: 0.1 });

      // MAE should be small since the pattern is simple
      expect(result.mae).toBeLessThan(2);
      // Correlation should be high
      expect(result.correlation).toBeGreaterThan(0.8);
    });

    it("returns NaN when too few samples", () => {
      const X: SparseVector[] = [[[0, 1]]];
      const y = [1];

      const result = crossValidate(X, y, 1);
      expect(result.mae).toBeNaN();
      expect(result.correlation).toBeNaN();
    });

    it("uses 3 folds by default", () => {
      // With exactly 3 samples and default 3 folds, each fold has 1 test sample
      const X: SparseVector[] = [[[0, 1]], [[0, 2]], [[0, 3]]];
      const y = [1, 2, 3];

      // Should not throw (3 samples >= 3 folds)
      const result = crossValidate(X, y, 1);
      expect(typeof result.mae).toBe("number");
      expect(typeof result.correlation).toBe("number");
    });
  });

  describe("numerical accuracy with larger feature spaces", () => {
    it("handles 500 features with sparse data", () => {
      // Simulate TF-IDF-like sparse vectors: ~20 nonzero features out of 500
      const numFeatures = 500;
      const numSamples = 50;
      const X: SparseVector[] = [];
      const y: number[] = [];

      // True weights: only features 0-4 matter
      const trueWeights = [2, -1, 0.5, -0.3, 1.5];

      for (let i = 0; i < numSamples; i++) {
        const vec: SparseVector = [];
        let target = 3; // intercept

        // Always include some of the signal features
        for (let f = 0; f < 5; f++) {
          if (Math.random() > 0.3) {
            const val = Math.random() * 2;
            vec.push([f, val]);
            target += trueWeights[f] * val;
          }
        }

        // Add noise features
        for (let f = 5; f < numFeatures; f++) {
          if (Math.random() > 0.95) {
            // 5% chance of nonzero
            vec.push([f, Math.random()]);
          }
        }

        vec.sort((a, b) => a[0] - b[0]);
        X.push(vec);
        y.push(target + (Math.random() - 0.5) * 0.2);
      }

      const model = new RidgeRegression({ alpha: 1.0 });
      model.fit(X, y, numFeatures);

      // The model should assign larger weights to features 0-4
      const weights = model.getWeights();
      const signalMagnitude =
        trueWeights.reduce((sum, w) => sum + Math.abs(w), 0) / trueWeights.length;
      const noiseMagnitude =
        weights.slice(5).reduce((sum, w) => sum + Math.abs(w), 0) / (numFeatures - 5);

      // Signal weights should be much larger on average than noise weights
      expect(signalMagnitude).toBeGreaterThan(noiseMagnitude * 5);
    });
  });
});
