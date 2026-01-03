package com.lionreader.service

/**
 * Source of the narration text.
 */
enum class NarrationSource {
    /** Text was processed by LLM for better TTS quality */
    LLM,

    /** Text was converted locally without LLM processing */
    LOCAL,
}

sealed class NarrationState {
    data object Idle : NarrationState()

    data object Loading : NarrationState()

    data class Playing(
        val entryId: String,
        val currentParagraph: Int,
        val totalParagraphs: Int,
        val entryTitle: String,
        /** Source of the narration text */
        val source: NarrationSource = NarrationSource.LOCAL,
    ) : NarrationState()

    data class Paused(
        val entryId: String,
        val currentParagraph: Int,
        val totalParagraphs: Int,
        val entryTitle: String,
        /** Source of the narration text */
        val source: NarrationSource = NarrationSource.LOCAL,
    ) : NarrationState()

    data class Error(
        val message: String,
    ) : NarrationState()
}
