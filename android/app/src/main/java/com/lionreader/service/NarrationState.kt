package com.lionreader.service

sealed class NarrationState {
    data object Idle : NarrationState()
    data object Loading : NarrationState()
    data class Playing(
        val entryId: String,
        val currentParagraph: Int,
        val totalParagraphs: Int,
        val entryTitle: String
    ) : NarrationState()
    data class Paused(
        val entryId: String,
        val currentParagraph: Int,
        val totalParagraphs: Int,
        val entryTitle: String
    ) : NarrationState()
    data class Error(val message: String) : NarrationState()
}
