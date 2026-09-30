package com.lionreader.app.narration

import java.io.File
import java.io.RandomAccessFile

private val SEEK_TAGS = listOf("Xing", "Info", "VBRI").map { it.toByteArray(Charsets.US_ASCII) }

/**
 * Where each tag can sit in the first frame: after the side info (mono/stereo, MPEG 1/2), or
 * VBRI's.
 */
private val SEEK_TAG_OFFSETS = listOf(13, 21, 36)

/** How far into a file its first frame is looked for (ID3 tags, padding). */
private const val HEAD_BYTES = 64 * 1024

/**
 * [audio] with its seek header (a Xing, Info or VBRI tag in the first frame) blanked out. Cloud
 * voices can return several MP3s back to back, one per sentence, the first one's header counting
 * only its own frames; ExoPlayer stops where that header says the audio ends, so only the first
 * sentence of each chunk played. Without the tag that frame is an ordinary silent one, and the
 * player reads to the end of the file. The same array when there's no tag.
 */
fun withoutSeekHeader(audio: ByteArray): ByteArray {
    val at = seekTagPosition(audio) ?: return audio
    return audio.copyOf().also { it.fill(0, at, at + 4) }
}

/**
 * [withoutSeekHeader], in place: rewrites only the tag's 4 bytes, never the rest of the file, so a
 * player already reading it is unaffected.
 */
fun blankSeekHeader(file: File) {
    val head = ByteArray(HEAD_BYTES)
    val read =
        file.inputStream().use { input ->
            var total = 0
            while (total < head.size) {
                val n = input.read(head, total, head.size - total)
                if (n < 0) break
                total += n
            }
            total
        }
    val at = seekTagPosition(head.copyOf(read)) ?: return
    RandomAccessFile(file, "rw").use {
        it.seek(at.toLong())
        it.write(ByteArray(4))
    }
}

private fun seekTagPosition(audio: ByteArray): Int? {
    val frame = firstFrame(audio) ?: return null
    return SEEK_TAG_OFFSETS.map { frame + it }
        .firstOrNull { at ->
            SEEK_TAGS.any { tag ->
                tag.indices.all { at + it < audio.size && audio[at + it] == tag[it] }
            }
        }
}

/**
 * Where the first MPEG audio frame starts: past any ID3v2 tags and padding, as ExoPlayer finds it.
 */
private fun firstFrame(audio: ByteArray): Int? {
    var start = 0
    while (start + 10 <= audio.size && audio.startsWith("ID3", start)) {
        val size =
            (6..9).fold(0) { total, i -> (total shl 7) or (audio[start + i].toInt() and 0x7F) }
        val footer = if (audio[start + 5].toInt() and 0x10 != 0) 10 else 0
        start += 10 + size + footer
    }
    return (start..audio.size - 4).firstOrNull { isFrameHeader(audio, it) }
}

private fun ByteArray.startsWith(text: String, at: Int): Boolean =
    text.indices.all { at + it < size && this[at + it] == text[it].code.toByte() }

private fun isFrameHeader(audio: ByteArray, at: Int): Boolean {
    val b1 = audio[at + 1].toInt() and 0xFF
    val b2 = audio[at + 2].toInt() and 0xFF
    return audio[at] == 0xFF.toByte() &&
        b1 and 0xE0 == 0xE0 &&
        (b1 shr 3) and 3 != 1 && // reserved version
        (b1 shr 1) and 3 != 0 && // reserved layer
        b2 shr 4 != 15 && // bad bitrate
        (b2 shr 2) and 3 != 3 // reserved sample rate
}
