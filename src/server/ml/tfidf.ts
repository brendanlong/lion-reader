/**
 * TF-IDF Vectorizer Implementation
 *
 * A lightweight TypeScript implementation of TF-IDF (Term Frequency-Inverse Document Frequency)
 * for text feature extraction. Designed for memory efficiency with sparse vector representation.
 *
 * Features:
 * - Unigrams and bigrams
 * - Max features limiting
 * - Sparse vector output
 * - Serializable vocabulary for model persistence
 */

/**
 * Configuration for the TF-IDF vectorizer.
 */
export interface TfidfConfig {
  /** Maximum number of features to keep */
  maxFeatures: number;
  /** Minimum document frequency (ignore terms appearing in fewer documents) */
  minDf: number;
  /** Maximum document frequency ratio (ignore terms appearing in more than this fraction of documents) */
  maxDf: number;
  /** Whether to include bigrams */
  useBigrams: boolean;
  /** Minimum token length */
  minTokenLength: number;
}

const DEFAULT_CONFIG: TfidfConfig = {
  maxFeatures: 5000,
  minDf: 2,
  maxDf: 0.95,
  useBigrams: true,
  minTokenLength: 2,
};

/**
 * Sparse vector representation: array of [index, value] pairs.
 */
export type SparseVector = Array<[number, number]>;

/**
 * Tokenizes text into words.
 * Handles basic preprocessing: lowercase, remove punctuation, split on whitespace.
 */
function tokenize(text: string, minLength: number): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ") // Replace punctuation with spaces
    .split(/\s+/)
    .filter((token) => token.length >= minLength);
}

/**
 * Generates n-grams from a token array.
 */
function generateNgrams(tokens: string[], n: number): string[] {
  if (n === 1) return tokens;

  const ngrams: string[] = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(" "));
  }
  return ngrams;
}

/**
 * Extracts terms (unigrams and optionally bigrams) from text.
 */
function extractTerms(text: string, config: TfidfConfig): string[] {
  const tokens = tokenize(text, config.minTokenLength);
  const terms = [...tokens];

  if (config.useBigrams) {
    terms.push(...generateNgrams(tokens, 2));
  }

  return terms;
}

/**
 * TF-IDF Vectorizer
 *
 * Two-phase usage:
 * 1. fit(documents) - Learn vocabulary and IDF values from training data
 * 2. transform(documents) - Convert documents to TF-IDF vectors
 *
 * Or use fitTransform(documents) for combined operation.
 */
export class TfidfVectorizer {
  private config: TfidfConfig;
  private vocabulary: Map<string, number> = new Map();
  private idfValues: number[] = [];
  private fitted = false;

  constructor(config: Partial<TfidfConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Builds vocabulary and IDF values from term frequency counts.
   * Shared by fit() and fitTransform().
   */
  private buildVocabulary(
    numDocs: number,
    termDocFreq: Map<string, number>,
    termTotalFreq: Map<string, number>
  ): void {
    const minDfCount = this.config.minDf;
    const maxDfCount = Math.floor(this.config.maxDf * numDocs);

    const validTerms: Array<{ term: string; df: number; totalFreq: number }> = [];

    for (const [term, df] of termDocFreq.entries()) {
      if (df >= minDfCount && df <= maxDfCount) {
        validTerms.push({ term, df, totalFreq: termTotalFreq.get(term) || 0 });
      }
    }

    // Sort by total frequency and take top maxFeatures
    validTerms.sort((a, b) => b.totalFreq - a.totalFreq);
    const selectedTerms = validTerms.slice(0, this.config.maxFeatures);

    // Build vocabulary and IDF values
    this.vocabulary = new Map();
    this.idfValues = [];

    for (let i = 0; i < selectedTerms.length; i++) {
      const { term, df } = selectedTerms[i];
      this.vocabulary.set(term, i);
      // IDF with smoothing: log((1 + n) / (1 + df)) + 1
      this.idfValues.push(Math.log((1 + numDocs) / (1 + df)) + 1);
    }

    this.fitted = true;
  }

  /**
   * Fits the vectorizer on a corpus of documents.
   * Learns vocabulary and computes IDF values.
   *
   * @param documents Array of text documents
   */
  fit(documents: string[]): void {
    const numDocs = documents.length;
    const termDocFreq = new Map<string, number>();
    const termTotalFreq = new Map<string, number>();

    // Count document frequencies for each term
    for (const doc of documents) {
      const terms = extractTerms(doc, this.config);
      const uniqueTerms = new Set(terms);

      for (const term of uniqueTerms) {
        termDocFreq.set(term, (termDocFreq.get(term) || 0) + 1);
      }

      for (const term of terms) {
        termTotalFreq.set(term, (termTotalFreq.get(term) || 0) + 1);
      }
    }

    this.buildVocabulary(numDocs, termDocFreq, termTotalFreq);
  }

  /**
   * Transforms documents into TF-IDF sparse vectors.
   *
   * @param documents Array of text documents
   * @returns Array of sparse vectors (each vector is an array of [index, value] pairs)
   */
  transform(documents: string[]): SparseVector[] {
    if (!this.fitted) {
      throw new Error("Vectorizer must be fitted before transform");
    }

    return documents.map((doc) => this.transformSingle(doc));
  }

  /**
   * Transforms a single document into a TF-IDF sparse vector.
   */
  transformSingle(document: string): SparseVector {
    if (!this.fitted) {
      throw new Error("Vectorizer must be fitted before transform");
    }

    const terms = extractTerms(document, this.config);
    return this.termsToVector(terms);
  }

  /**
   * Transforms a single document and computes feature coverage in one pass.
   * Avoids the double-tokenization that occurs when calling transformSingle()
   * and getFeatureCoverage() separately.
   */
  transformWithCoverage(document: string): { vector: SparseVector; coverage: number } {
    if (!this.fitted) {
      throw new Error("Vectorizer must be fitted before transform");
    }

    const terms = extractTerms(document, this.config);
    const vector = this.termsToVector(terms);

    // Compute coverage from the same terms (avoids re-tokenizing)
    if (terms.length === 0) {
      return { vector, coverage: 0 };
    }
    const uniqueTerms = new Set(terms);
    let inVocab = 0;
    for (const term of uniqueTerms) {
      if (this.vocabulary.has(term)) {
        inVocab++;
      }
    }
    const coverage = inVocab / uniqueTerms.size;

    return { vector, coverage };
  }

  /**
   * Converts pre-extracted terms into a TF-IDF sparse vector.
   */
  private termsToVector(terms: string[]): SparseVector {
    // Count term frequencies
    const termFreq = new Map<number, number>();
    for (const term of terms) {
      const index = this.vocabulary.get(term);
      if (index !== undefined) {
        termFreq.set(index, (termFreq.get(index) || 0) + 1);
      }
    }

    // Convert to TF-IDF values (sparse)
    const vector: SparseVector = [];
    const docLength = terms.length;

    if (docLength === 0) {
      return vector;
    }

    for (const [index, freq] of termFreq.entries()) {
      // TF: term frequency normalized by document length
      const tf = freq / docLength;
      // TF-IDF
      const tfidf = tf * this.idfValues[index];
      vector.push([index, tfidf]);
    }

    // Sort by index for consistent ordering
    vector.sort((a, b) => a[0] - b[0]);

    // L2 normalize the vector
    const norm = Math.sqrt(vector.reduce((sum, [, val]) => sum + val * val, 0));
    if (norm > 0) {
      for (const pair of vector) {
        pair[1] /= norm;
      }
    }

    return vector;
  }

  /**
   * Fits and transforms in one step.
   * More efficient than calling fit() then transform() separately because
   * it tokenizes each document only once instead of twice.
   */
  fitTransform(documents: string[]): SparseVector[] {
    const numDocs = documents.length;
    const termDocFreq = new Map<string, number>();
    const termTotalFreq = new Map<string, number>();

    // Extract terms once and cache them
    const allTerms: string[][] = new Array(numDocs);

    for (let i = 0; i < numDocs; i++) {
      const terms = extractTerms(documents[i], this.config);
      allTerms[i] = terms;
      const uniqueTerms = new Set(terms);

      for (const term of uniqueTerms) {
        termDocFreq.set(term, (termDocFreq.get(term) || 0) + 1);
      }

      for (const term of terms) {
        termTotalFreq.set(term, (termTotalFreq.get(term) || 0) + 1);
      }
    }

    this.buildVocabulary(numDocs, termDocFreq, termTotalFreq);

    // Transform using cached terms (no re-tokenization)
    return allTerms.map((terms) => this.termsToVector(terms));
  }

  /**
   * Gets the vocabulary as a plain object for serialization.
   */
  getVocabulary(): Record<string, number> {
    return Object.fromEntries(this.vocabulary);
  }

  /**
   * Gets the IDF values array for serialization.
   */
  getIdfValues(): number[] {
    return [...this.idfValues];
  }

  /**
   * Gets the number of features (vocabulary size).
   */
  getFeatureCount(): number {
    return this.vocabulary.size;
  }

  /**
   * Calculates feature coverage: what fraction of terms in a document are in the vocabulary.
   * Used for confidence estimation.
   */
  getFeatureCoverage(document: string): number {
    const terms = extractTerms(document, this.config);
    if (terms.length === 0) return 0;

    const uniqueTerms = new Set(terms);
    let inVocab = 0;

    for (const term of uniqueTerms) {
      if (this.vocabulary.has(term)) {
        inVocab++;
      }
    }

    return inVocab / uniqueTerms.size;
  }

  /**
   * Creates a vectorizer from serialized vocabulary and IDF values.
   * Used for loading a pre-trained model.
   */
  static fromSerialized(
    vocabulary: Record<string, number>,
    idfValues: number[],
    config: Partial<TfidfConfig> = {}
  ): TfidfVectorizer {
    const vectorizer = new TfidfVectorizer(config);
    vectorizer.vocabulary = new Map(Object.entries(vocabulary));
    vectorizer.idfValues = [...idfValues];
    vectorizer.fitted = true;
    return vectorizer;
  }
}

/**
 * Combines TF-IDF features with feed ID one-hot encoding.
 * Returns a sparse vector with TF-IDF features followed by feed ID features.
 *
 * @param tfidfVector TF-IDF sparse vector
 * @param feedId Feed ID string
 * @param feedIdMap Map of feed IDs to indices
 * @param tfidfFeatureCount Number of TF-IDF features
 * @returns Combined sparse vector
 */
export function combineFeatures(
  tfidfVector: SparseVector,
  feedId: string,
  feedIdMap: Map<string, number>,
  tfidfFeatureCount: number
): SparseVector {
  const combined: SparseVector = [...tfidfVector];

  const feedIndex = feedIdMap.get(feedId);
  if (feedIndex !== undefined) {
    // Add one-hot encoded feed ID (offset by TF-IDF feature count)
    combined.push([tfidfFeatureCount + feedIndex, 1.0]);
  }

  return combined;
}
