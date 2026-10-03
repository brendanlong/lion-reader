package com.lionreader.shared.narration

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
    if (text.length <= maxChars) listOf(text)
    else pack(text.split(' ').flatMap { slices(it, maxChars) }, maxChars)

/**
 * [text] in pieces of at most [maxChars], cut anywhere: a run with no space at all (a long URL,
 * unspaced CJK text) would be one chunk the server refuses. Never between a surrogate pair.
 */
private fun slices(text: String, maxChars: Int): List<String> {
    // With fewer, a surrogate pair could never fit and this would never end.
    require(maxChars >= 2) { "maxChars must be at least 2" }
    val pieces = mutableListOf<String>()
    var start = 0
    while (text.length - start > maxChars) {
        var end = start + maxChars
        if (text[end - 1].isHighSurrogate()) end--
        pieces += text.substring(start, end)
        start = end
    }
    pieces += text.substring(start)
    return pieces
}

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
