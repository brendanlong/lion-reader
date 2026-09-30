package com.lionreader.app.narration

/** A piece of a paragraph small enough to synthesize quickly; [paragraph] is its index. */
data class SpeechChunk(val paragraph: Int, val text: String)

private val SENTENCE_END = Regex("""(?<=[.!?…])["'”’)\]]*\s+""")
private val CLAUSE_END = Regex("""(?<=[,;:—])\s+""")

/**
 * Splits paragraphs into chunks of whole sentences up to [maxChars], so the first audio is ready
 * fast and the player can move on while later ones synthesize. Highlighting stays per paragraph, so
 * this doesn't need to match the web's sentence splitting.
 */
fun speechChunks(paragraphs: List<String>, maxChars: Int = 400): List<SpeechChunk> =
    paragraphs.flatMapIndexed { index, paragraph ->
        pack(pieces(paragraph.trim(), maxChars), maxChars).map { SpeechChunk(index, it) }
    }

/** Sentences, with any longer than [maxChars] broken at clauses, then words. */
private fun pieces(text: String, maxChars: Int): List<String> =
    text
        .split(SENTENCE_END)
        .filter { it.isNotBlank() }
        .flatMap { sentence ->
            if (sentence.length <= maxChars) listOf(sentence)
            else pack(sentence.split(CLAUSE_END), maxChars).flatMap { breakWords(it, maxChars) }
        }

private fun breakWords(text: String, maxChars: Int): List<String> =
    if (text.length <= maxChars) listOf(text) else pack(text.split(' '), maxChars)

/** Joins consecutive pieces while they fit in [maxChars]. */
private fun pack(pieces: List<String>, maxChars: Int): List<String> {
    val chunks = mutableListOf<String>()
    val current = StringBuilder()
    for (piece in pieces) {
        if (current.isNotEmpty() && current.length + 1 + piece.length > maxChars) {
            chunks += current.toString()
            current.clear()
        }
        if (current.isNotEmpty()) current.append(' ')
        current.append(piece)
    }
    if (current.isNotEmpty()) chunks += current.toString()
    return chunks
}
