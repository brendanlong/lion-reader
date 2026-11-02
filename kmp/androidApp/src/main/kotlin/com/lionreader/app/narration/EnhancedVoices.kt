package com.lionreader.app.narration

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.FragmentedMp4Muxer
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.WritableByteChannel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

/**
 * Enhanced voices: Phonon on this device ([EnhancedVoiceModel]), speaking with the voice [voice].
 * Each chunk streams into a file ([StreamingFmp4]) that plays from its first audio. Phonon makes
 * one chunk at a time, so the next starts as soon as one is done. One the narrator abandons stops
 * at its next piece of audio: before it's handed over, when the narration asking for it is
 * cancelled; after, when the narrator deletes its file, as it does a skipped or played chunk's. One
 * still waiting its turn when narration moves on doesn't start.
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
        val caller = currentCoroutineContext().job
        val started = CompletableDeferred<Uri>()
        scope.launch {
            try {
                model.withModel { tts, removed ->
                    if (!caller.isActive) throw CancellationException("Narration moved on")
                    tts.setVoice(voice)
                    val file = File(dir, "$name.mp4")
                    val writer = StreamingFmp4(file, PhononTts.SAMPLE_RATE)
                    var abandoned = false
                    try {
                        tts.speak(text) { pcm ->
                            abandoned =
                                removed() ||
                                    (!started.isCompleted && !caller.isActive) ||
                                    !file.exists()
                            if (abandoned) return@speak false
                            writer.write(pcm)
                            started.complete(writer.audio.uri)
                            true
                        }
                        if (abandoned) throw IOException("Narration moved on")
                        if (!started.isCompleted) throw IOException("The voice made no audio")
                        writer.finish(file)
                    } catch (e: Exception) {
                        writer.fail(e)
                        throw e
                    }
                }
            } catch (e: Throwable) {
                // Errors too (a native library that won't load): this scope is app-wide, and what
                // escaped it would end the app.
                started.completeExceptionally(e)
            }
        }
        return started.await()
    }
}

/**
 * Speech written as it's spoken, as raw 16-bit audio in fragmented MP4, for the player to read
 * meanwhile ([audio]). The format cloud voices stream in: it doesn't say how long it is, so the
 * player plays each fragment as it comes and the whole to its end. (A WAV has to give its length up
 * front, and one that claimed the most it could hold played on in silence after the speech.)
 */
@OptIn(UnstableApi::class)
internal class StreamingFmp4(file: File, private val sampleRate: Int) {
    val audio = StreamedAudio(file)
    private val out = FileOutputStream(file).channel
    private val muxer =
        FragmentedMp4Muxer.Builder(
                object : WritableByteChannel by out {
                    override fun write(src: ByteBuffer): Int =
                        out.write(src).also { audio.appended(it) }
                }
            )
            .setFragmentDurationMs(FRAGMENT_MS)
            .build()
    private val track =
        muxer.addTrack(
            Format.Builder()
                .setSampleMimeType(MimeTypes.AUDIO_RAW)
                .setPcmEncoding(C.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelCount(1)
                .build()
        )
    private var pending = newSample()
    private var frames = 0L

    /** Adds [pcm] (floats in [-1, 1]). */
    fun write(pcm: FloatArray) {
        for (sample in pcm) {
            pending.putShort((sample.coerceIn(-1f, 1f) * Short.MAX_VALUE).toInt().toShort())
            if (!pending.hasRemaining()) writePending()
        }
    }

    /** Writes what's left and ends the stream. */
    fun finish(to: File) {
        if (pending.position() > 0) writePending()
        // Gives the last sample its length: the muxer otherwise repeats the one before's.
        muxer.writeSampleData(
            track,
            ByteBuffer.allocateDirect(0),
            BufferInfo(timeUs(), 0, C.BUFFER_FLAG_END_OF_STREAM),
        )
        muxer.close()
        out.close()
        audio.finish(to)
    }

    fun fail(cause: Exception) {
        audio.fail(cause)
        out.close()
    }

    private fun writePending() {
        val size = pending.position()
        pending.flip()
        muxer.writeSampleData(track, pending, BufferInfo(timeUs(), size, C.BUFFER_FLAG_KEY_FRAME))
        frames += size / 2
        pending = newSample()
    }

    private fun timeUs() = frames * 1_000_000 / sampleRate

    private fun newSample() =
        ByteBuffer.allocateDirect(sampleRate * SAMPLE_MS / 1000 * 2).order(ByteOrder.LITTLE_ENDIAN)

    private companion object {
        /** How much the player waits for before it can play the start of a chunk. */
        const val FRAGMENT_MS = 250L

        /**
         * Samples are all this long: the muxer takes each one's length from when the next starts,
         * and the last in a fragment's from the one before it.
         */
        const val SAMPLE_MS = 20
    }
}
