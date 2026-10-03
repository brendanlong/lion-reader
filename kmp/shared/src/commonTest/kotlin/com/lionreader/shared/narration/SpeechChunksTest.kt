package com.lionreader.shared.narration

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

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
    fun textWithoutSpacesIsCutToFit() {
        // Unspaced CJK text has no sentence, clause or word breaks to split at.
        val cjk = "这是一个没有空格的很长的段落。".repeat(200)
        val chunks = speechChunks(listOf(cjk), maxChars = 1000)
        assertTrue(chunks.size > 1)
        assertTrue(chunks.all { it.text.length <= 1000 })
        assertEquals(cjk, chunks.joinToString("") { it.text })

        val url = "https://example.com/" + "a".repeat(2500)
        val withUrl = speechChunks(listOf("See $url for more."), maxChars = 1000)
        assertEquals(
            listOf("See", url.take(1000), url.substring(1000, 2000)),
            withUrl.take(3).map { it.text },
        )
        assertEquals("${url.substring(2000)} for more.", withUrl.last().text)
    }

    @Test
    fun aCutNeverSplitsASurrogatePair() {
        val emoji = "😀".repeat(30)
        val chunks = speechChunks(listOf(emoji), maxChars = 7)
        assertTrue(chunks.all { it.text.length <= 7 && !it.text.last().isHighSurrogate() })
        assertEquals(emoji, chunks.joinToString("") { it.text })
    }

    @Test
    fun blankParagraphsSayNothing() {
        assertEquals(listOf(SpeechChunk(1, "Hi.")), speechChunks(listOf("  ", "Hi.")))
    }
}
