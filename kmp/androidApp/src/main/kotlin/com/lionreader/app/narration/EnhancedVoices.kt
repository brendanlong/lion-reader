package com.lionreader.app.narration

import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Enhanced voices: Phonon on this device ([EnhancedVoiceModel]), speaking with the voice [voice].
 * Each chunk streams into a WAV file that plays from its first audio. Phonon makes one chunk at a
 * time, so the next starts as soon as one is done; one the narrator abandons (deleting its file, as
 * it does a skipped or played chunk's) stops at its next piece of audio.
 */
class EnhancedVoices(
    private val model: EnhancedVoiceModel,
    private val voice: String,
    /** App-wide: a chunk goes on being made after [synthesize] hands it over. */
    private val scope: CoroutineScope,
) : SpeechEngine {
    override val maxChunkChars = 400
    override val lookaheadChars = 450
    override val parallelism = 1

    override suspend fun synthesize(text: String, dir: File, name: String): Uri {
        val started = CompletableDeferred<Uri>()
        scope.launch {
            try {
                model.withModel { tts, removed ->
                    tts.setVoice(voice)
                    val file = File(dir, "$name.wav")
                    val writer = StreamingWav(file, PhononTts.SAMPLE_RATE)
                    var abandoned = false
                    try {
                        tts.speak(text) { pcm ->
                            abandoned = removed() || !file.exists()
                            if (abandoned) return@speak false
                            writer.write(pcm)
                            started.complete(writer.audio.uri)
                            true
                        }
                        if (abandoned) throw IOException("Narration moved on")
                        if (!started.isCompleted) throw IOException("The voice made no audio")
                        writer.finish()
                    } catch (e: Exception) {
                        writer.fail(e)
                        throw e
                    }
                }
            } catch (e: Exception) {
                started.completeExceptionally(e)
            }
        }
        return started.await()
    }
}

/**
 * A 16-bit mono WAV written as it's spoken, for the player to read meanwhile ([audio]). Until
 * [finish] its header gives the most data a WAV can hold, which the player reads as "until the file
 * ends"; then it gives the real size.
 */
internal class StreamingWav(private val file: File, private val sampleRate: Int) {
    val audio = StreamedAudio(file)
    private val out = FileOutputStream(file)
    private var dataBytes = 0L

    init {
        out.write(header(UNKNOWN_SIZE))
        audio.appended(HEADER_BYTES)
    }

    fun write(pcm: FloatArray) {
        val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        for (sample in pcm) {
            bytes.putShort((sample.coerceIn(-1f, 1f) * Short.MAX_VALUE).toInt().toShort())
        }
        out.write(bytes.array())
        dataBytes += bytes.capacity()
        audio.appended(bytes.capacity())
    }

    fun finish() {
        out.close()
        RandomAccessFile(file, "rw").use { it.write(header(dataBytes)) }
        audio.finish(file)
    }

    fun fail(cause: Exception) {
        audio.fail(cause)
        out.close()
    }

    private fun header(dataSize: Long): ByteArray =
        ByteBuffer.allocate(HEADER_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".toByteArray())
            .putInt(if (dataSize == UNKNOWN_SIZE) -1 else (dataSize + HEADER_BYTES - 8).toInt())
            .put("WAVEfmt ".toByteArray())
            .putInt(16)
            .putShort(1) // PCM
            .putShort(1) // mono
            .putInt(sampleRate)
            .putInt(sampleRate * 2)
            .putShort(2)
            .putShort(16)
            .put("data".toByteArray())
            .putInt(if (dataSize == UNKNOWN_SIZE) -1 else dataSize.toInt())
            .array()

    private companion object {
        const val HEADER_BYTES = 44
        const val UNKNOWN_SIZE = -1L
    }
}
