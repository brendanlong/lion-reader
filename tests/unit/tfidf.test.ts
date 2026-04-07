import { describe, expect, it } from "vitest";
import { TfidfVectorizer } from "../../src/server/ml/tfidf";

const sampleDocs = [
  "the quick brown fox jumps over the lazy dog",
  "a quick brown dog runs in the park",
  "the lazy fox sleeps all day long",
  "quick brown rice is a healthy meal option",
  "the dog and the fox are friends in the park",
];

describe("TfidfVectorizer", () => {
  describe("incremental fitting (startFit/fitDocument/finalizeFit)", () => {
    it("produces the same vocabulary as fit()", () => {
      const config = {
        maxFeatures: 100,
        minDf: 1,
        maxDf: 0.95,
        useBigrams: true,
        minTokenLength: 2,
      };

      const batch = new TfidfVectorizer(config);
      batch.fit(sampleDocs);

      const incremental = new TfidfVectorizer(config);
      incremental.startFit();
      for (const doc of sampleDocs) {
        incremental.fitDocument(doc);
      }
      incremental.finalizeFit();

      expect(incremental.getVocabulary()).toEqual(batch.getVocabulary());
      expect(incremental.getIdfValues()).toEqual(batch.getIdfValues());
      expect(incremental.getFeatureCount()).toBe(batch.getFeatureCount());
    });

    it("produces the same vectors as fitTransform()", () => {
      const config = {
        maxFeatures: 50,
        minDf: 1,
        maxDf: 0.95,
        useBigrams: true,
        minTokenLength: 2,
      };

      const batch = new TfidfVectorizer(config);
      const batchVectors = batch.fitTransform(sampleDocs);

      const incremental = new TfidfVectorizer(config);
      incremental.startFit();
      for (const doc of sampleDocs) {
        incremental.fitDocument(doc);
      }
      incremental.finalizeFit();
      const incrementalVectors = sampleDocs.map((doc) => incremental.transformSingle(doc));

      expect(incrementalVectors).toEqual(batchVectors);
    });

    it("throws if fitDocument called without startFit", () => {
      const v = new TfidfVectorizer();
      expect(() => v.fitDocument("hello")).toThrow("Must call startFit()");
    });

    it("throws if finalizeFit called without startFit", () => {
      const v = new TfidfVectorizer();
      expect(() => v.finalizeFit()).toThrow("Must call startFit()");
    });

    it("can be reused after finalizeFit", () => {
      const v = new TfidfVectorizer({
        maxFeatures: 50,
        minDf: 1,
        maxDf: 0.95,
        useBigrams: false,
        minTokenLength: 2,
      });

      // First fit
      v.startFit();
      for (const doc of sampleDocs) {
        v.fitDocument(doc);
      }
      v.finalizeFit();
      const vocab1 = v.getVocabulary();

      // Second fit with different data
      v.startFit();
      v.fitDocument("completely different text here");
      v.fitDocument("another unique document with words");
      v.finalizeFit();
      const vocab2 = v.getVocabulary();

      expect(vocab1).not.toEqual(vocab2);
    });
  });
});
