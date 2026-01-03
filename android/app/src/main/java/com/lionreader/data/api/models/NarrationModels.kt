package com.lionreader.data.api.models

import kotlinx.serialization.Serializable

/**
 * Request to generate narration text for an entry.
 */
@Serializable
data class NarrationGenerateRequest(
    /** Entry ID to generate narration for */
    val id: String,
    /** Whether to use LLM normalization for better quality (default true) */
    val useLlmNormalization: Boolean = true,
)

/**
 * Paragraph mapping entry for highlighting support.
 * Maps a narration paragraph index to the original HTML element index.
 */
@Serializable
data class ParagraphMapEntry(
    /** Narration paragraph index */
    val n: Int,
    /** Original HTML element index (corresponds to data-para-id) */
    val o: Int,
)

/**
 * Response from the narration generation endpoint.
 */
@Serializable
data class NarrationGenerateResponse(
    /** The narration-ready text */
    val narration: String,
    /** Whether this was served from cache */
    val cached: Boolean,
    /** Source of the narration: "llm" or "fallback" */
    val source: String,
    /** Paragraph mapping for highlighting (narration index -> element index) */
    val paragraphMap: List<ParagraphMapEntry>,
)

/**
 * Response from the AI availability check endpoint.
 */
@Serializable
data class NarrationAiAvailableResponse(
    /** Whether AI text processing is available on the server */
    val available: Boolean,
)
