package com.lionreader.app.narration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechChunksTest {
    @Test
    fun shortParagraphsAreOneChunkEach() {
        assertEquals(
            listOf(SpeechChunk(0, "One. Two."), SpeechChunk(1, "Three?")),
            speechChunks(listOf("One. Two.", "Three?")),
        )
    }

    @Test
    fun longParagraphsSplitBetweenSentences() {
        val sentence = "This sentence is about forty characters. "
        val chunks = speechChunks(listOf(sentence.repeat(20)), maxChars = 100)
        assertTrue(chunks.all { it.paragraph == 0 && it.text.length <= 100 })
        assertTrue(chunks.all { it.text.endsWith("characters.") })
        assertEquals(sentence.repeat(20).trim(), chunks.joinToString(" ") { it.text })
    }

    @Test
    fun aVeryLongSentenceSplitsAtClausesThenWords() {
        val clause = "a clause that goes on for a while, "
        val chunks = speechChunks(listOf(clause.repeat(10) + "end"), maxChars = 80)
        assertTrue(chunks.all { it.text.length <= 80 })
        assertEquals((clause.repeat(10) + "end").trim(), chunks.joinToString(" ") { it.text })

        val words = speechChunks(listOf("word ".repeat(100).trim()), maxChars = 50)
        assertTrue(words.all { it.text.length <= 50 })
    }

    @Test
    fun blankParagraphsSayNothing() {
        assertEquals(listOf(SpeechChunk(1, "Hi.")), speechChunks(listOf("  ", "Hi.")))
    }
}
