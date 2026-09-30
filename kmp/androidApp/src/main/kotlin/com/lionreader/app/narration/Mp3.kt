package com.lionreader.app.narration

private val SEEK_TAGS = listOf("Xing", "Info", "VBRI").map { it.toByteArray(Charsets.US_ASCII) }

/**
 * Where each tag can sit in the first frame: after the side info (mono/stereo, MPEG 1/2), or
 * VBRI's.
 */
private val SEEK_TAG_OFFSETS = listOf(13, 21, 36)

/**
 * [audio] with its seek header (a Xing, Info or VBRI tag in the first frame) blanked out. Cloud
 * voices can return several MP3s back to back, one per sentence, the first one's header counting
 * only its own frames; ExoPlayer stops where that header says the audio ends, so only the first
 * sentence of each chunk played. Without the tag that frame is an ordinary silent one, and the
 * player reads to the end of the file. The same array when there's no tag.
 */
fun withoutSeekHeader(audio: ByteArray): ByteArray {
    val frame = id3v2End(audio)
    val isFrame =
        frame + 4 <= audio.size &&
            audio[frame] == 0xFF.toByte() &&
            audio[frame + 1].toInt() and 0xE0 == 0xE0
    if (!isFrame) return audio
    for (offset in SEEK_TAG_OFFSETS) {
        val at = frame + offset
        if (
            SEEK_TAGS.any { tag ->
                tag.indices.all { at + it < audio.size && audio[at + it] == tag[it] }
            }
        ) {
            return audio.copyOf().also { it.fill(0, at, at + 4) }
        }
    }
    return audio
}

/** Where the audio starts: past a leading ID3v2 tag, if there is one. */
private fun id3v2End(audio: ByteArray): Int {
    if (
        audio.size < 10 ||
            audio[0] != 'I'.code.toByte() ||
            audio[1] != 'D'.code.toByte() ||
            audio[2] != '3'.code.toByte()
    ) {
        return 0
    }
    val size = (6..9).fold(0) { total, i -> (total shl 7) or (audio[i].toInt() and 0x7F) }
    val footer = if (audio[5].toInt() and 0x10 != 0) 10 else 0
    return 10 + size + footer
}
