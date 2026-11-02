package com.lionreader.app.narration

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.net.Uri
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

/**
 * Enhanced voices: Phonon on this device ([EnhancedVoiceModel]), speaking with the voice [voice].
 * Each chunk streams into an AAC file that plays from its first audio. Phonon makes one chunk at a
 * time, so the next starts as soon as one is done. One the narrator abandons stops at its next
 * piece of audio: before it's handed over, when the narration asking for it is cancelled; after,
 * when the narrator deletes its file, as it does a skipped or played chunk's. One still waiting its
 * turn when narration moves on doesn't start.
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
                    val file = File(dir, "$name.aac")
                    val writer = StreamingAac(file, PhononTts.SAMPLE_RATE)
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
 * Speech encoded to AAC as it's spoken, in ADTS (each frame with a 7-byte header), for the player
 * to read meanwhile ([audio]). A stream that doesn't say how long it is, so the player plays it to
 * its end, as it does cloud voices': a WAV has to give its length up front, and one that claimed
 * the most it could hold played on in silence after the speech, toward that length.
 */
internal class StreamingAac(file: File, private val sampleRate: Int) {
    val audio = StreamedAudio(file)
    private val out = FileOutputStream(file)
    private val codec =
        MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC).apply {
            configure(
                MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
                    setInteger(
                        MediaFormat.KEY_AAC_PROFILE,
                        MediaCodecInfo.CodecProfileLevel.AACObjectLC,
                    )
                    setInteger(MediaFormat.KEY_BIT_RATE, BITRATE)
                },
                null,
                null,
                MediaCodec.CONFIGURE_FLAG_ENCODE,
            )
            start()
        }
    private val info = MediaCodec.BufferInfo()
    private var frames = 0L

    /** Encodes [pcm] (floats in [-1, 1]), handing the player what the encoder has done so far. */
    fun write(pcm: FloatArray) {
        val bytes = ByteBuffer.allocate(pcm.size * 2).order(ByteOrder.nativeOrder())
        for (sample in pcm) {
            bytes.putShort((sample.coerceIn(-1f, 1f) * Short.MAX_VALUE).toInt().toShort())
        }
        bytes.flip()
        while (bytes.hasRemaining()) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) {
                val input = codec.getInputBuffer(index)!!
                input.clear()
                val count = minOf(input.remaining(), bytes.remaining()) and 1.inv()
                val slice = bytes.duplicate().apply { limit(position() + count) }
                input.put(slice)
                bytes.position(bytes.position() + count)
                codec.queueInputBuffer(index, 0, count, frames * 1_000_000 / sampleRate, 0)
                frames += count / 2
            }
            drain(endOfStream = false)
        }
        drain(endOfStream = false)
    }

    /** Encodes what's left and ends the stream. */
    fun finish(to: File) {
        var queued = false
        while (!queued) {
            val index = codec.dequeueInputBuffer(TIMEOUT_US)
            if (index >= 0) {
                val input = codec.getInputBuffer(index)!!
                input.clear()
                val silence = minOf(input.capacity(), SILENCE_BYTES)
                input.put(ByteArray(silence))
                codec.queueInputBuffer(
                    index,
                    0,
                    silence,
                    frames * 1_000_000 / sampleRate,
                    MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                )
                frames += silence / 2
                queued = true
            }
            drain(endOfStream = false)
        }
        drain(endOfStream = true)
        codec.release()
        out.close()
        audio.finish(to)
    }

    fun fail(cause: Exception) {
        audio.fail(cause)
        codec.release()
        out.close()
    }

    /** Writes out the encoded frames there are; with [endOfStream], until the last. */
    private fun drain(endOfStream: Boolean) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0)
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!endOfStream) return
                continue
            }
            if (index < 0) continue // The output format, which ADTS headers carry instead.
            val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
            if (!config && info.size > 0) {
                val frame = ByteArray(info.size)
                codec.getOutputBuffer(index)!!.apply { position(info.offset) }.get(frame)
                out.write(adtsHeader(frame.size, sampleRate))
                out.write(frame)
                audio.appended(ADTS_HEADER_BYTES + frame.size)
            }
            val last = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
            codec.releaseOutputBuffer(index, false)
            if (last) return
        }
    }

    companion object {
        /** Plenty for one voice. */
        private const val BITRATE = 48_000
        private const val TIMEOUT_US = 10_000L
        private const val ADTS_HEADER_BYTES = 7

        /**
         * One AAC frame of silence (1024 samples) carries the end of the stream: the platform's
         * encoder, given the end in an empty buffer after part of a frame, never signalled it.
         */
        private const val SILENCE_BYTES = 1024 * 2

        /** The AAC sampling frequency indexes (ISO 14496-3), by rate. */
        private val FREQUENCY_INDEX =
            listOf(
                96000,
                88200,
                64000,
                48000,
                44100,
                32000,
                24000,
                22050,
                16000,
                12000,
                11025,
                8000,
            )

        /** The ADTS header of a mono AAC-LC frame of [payload] bytes, without a CRC. */
        fun adtsHeader(payload: Int, sampleRate: Int): ByteArray {
            val length = payload + ADTS_HEADER_BYTES
            val frequency = FREQUENCY_INDEX.indexOf(sampleRate)
            require(frequency >= 0) { "AAC has no rate $sampleRate" }
            val profile = 1 // AAC-LC, less one
            val channels = 1
            return byteArrayOf(
                0xFF.toByte(),
                0xF1.toByte(), // MPEG-4, layer 0, no CRC
                ((profile shl 6) or (frequency shl 2) or (channels shr 2)).toByte(),
                (((channels and 3) shl 6) or (length shr 11)).toByte(),
                ((length shr 3) and 0xFF).toByte(),
                (((length and 7) shl 5) or 0x1F).toByte(), // and the buffer fullness: variable
                0xFC.toByte(),
            )
        }
    }
}
