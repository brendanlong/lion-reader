package com.lionreader.app.narration

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.io.RandomAccessFile
import java.util.UUID

/**
 * Audio still arriving: a file a speech engine is writing while the player already reads it, so
 * playback starts on the first bytes rather than the last. The player reads it through [uri] (see
 * [NarrationDataSource]), waiting at the end of what's written for more, until [finish] or [fail].
 */
class StreamedAudio(file: File) {
    private val lock = Object()
    private var length = 0L
    private var finished = false
    private var failure: IOException? = null

    /** Where the audio is: the file being written, then wherever [finish] moved it. */
    private var file: File = file

    val uri: Uri = Uri.Builder().scheme(SCHEME).authority(UUID.randomUUID().toString()).build()

    init {
        synchronized(registry) { registry[uri.authority!!] = this }
    }

    /** [count] more bytes are in [file]. */
    fun appended(count: Int) =
        synchronized(lock) {
            length += count
            lock.notifyAll()
        }

    /**
     * All of it is written: moves it to [to] (readers already open read on), or leaves it where it
     * is if it can't. Whether it moved.
     */
    fun finish(to: File): Boolean =
        synchronized(lock) {
            val moved = file.renameTo(to)
            if (moved) file = to
            finished = true
            lock.notifyAll()
            moved
        }

    /** It won't arrive: readers past what's written get [SpeechStreamBroken]. */
    fun fail(cause: Exception) =
        synchronized(lock) {
            failure = SpeechStreamBroken(cause)
            lock.notifyAll()
        }

    /**
     * The audio, open at [position]: wherever it is now ([finish] moves it under the same lock).
     * Throws [SpeechStreamBroken] if it stopped partway, so the player gives up on it at once.
     */
    internal fun openAt(position: Long): RandomAccessFile =
        synchronized(lock) {
            failure?.let { throw it }
            RandomAccessFile(file, "r").also { it.seek(position) }
        }

    /**
     * How much is written past [position], once there's some: 0 at the end. Waits for more; throws
     * [SpeechStreamBroken] if the rest won't come, and [InterruptedIOException] if the player gives
     * up on the load (it interrupts the loading thread).
     */
    internal fun awaitAfter(position: Long): Long =
        synchronized(lock) {
            try {
                while (length <= position && !finished && failure == null) lock.wait()
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                throw InterruptedIOException()
            }
            if (length > position) return length - position
            failure?.let { throw it }
            0
        }

    companion object {
        const val SCHEME = "lionreader-stream"

        /**
         * Recent streams by their [uri]'s authority, for [NarrationDataSource]: kept once done too,
         * since the player can open an item again (skipping back), and bounded, since the narrator
         * drops items it's played.
         */
        private val registry =
            object : LinkedHashMap<String, StreamedAudio>() {
                override fun removeEldestEntry(eldest: Map.Entry<String, StreamedAudio>) =
                    size > REMEMBERED
            }
        private const val REMEMBERED = 200

        internal fun forUri(uri: Uri): StreamedAudio? =
            uri.authority?.let { synchronized(registry) { registry[it] } }
    }
}

/** A stream that stopped partway: the chunk has to be heard again from its start. */
class SpeechStreamBroken(cause: Exception) : IOException("The cloud voice stopped partway", cause)

/**
 * What the narration player reads: [StreamedAudio] by its uri (still arriving, or the file it ended
 * up in), anything else as a file.
 */
@OptIn(UnstableApi::class)
class NarrationDataSource : BaseDataSource(/* isNetwork= */ false) {
    private var input: RandomAccessFile? = null
    private var streamed: StreamedAudio? = null
    private var uri: Uri? = null
    private var position = 0L
    private val files = FileDataSource()
    private var reading: DataSource? = null

    override fun open(dataSpec: DataSpec): Long {
        uri = dataSpec.uri
        if (dataSpec.uri.scheme != StreamedAudio.SCHEME) {
            reading = files
            return files.open(dataSpec)
        }
        transferInitializing(dataSpec)
        val audio =
            StreamedAudio.forUri(dataSpec.uri)
                ?: throw IOException("No such narration stream: ${dataSpec.uri}")
        streamed = audio
        input = audio.openAt(dataSpec.position)
        position = dataSpec.position
        transferStarted(dataSpec)
        return C.LENGTH_UNSET.toLong()
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        reading?.let {
            return it.read(buffer, offset, length)
        }
        if (length == 0) return 0
        val available = streamed!!.awaitAfter(position)
        if (available == 0L) return C.RESULT_END_OF_INPUT
        val read = input!!.read(buffer, offset, minOf(available, length.toLong()).toInt())
        if (read < 0) return C.RESULT_END_OF_INPUT
        position += read
        bytesTransferred(read)
        return read
    }

    override fun getUri(): Uri? = reading?.uri ?: uri

    override fun close() {
        reading?.let {
            reading = null
            it.close()
            return
        }
        input?.close()
        input = null
        if (streamed != null) {
            streamed = null
            transferEnded()
        }
    }

    class Factory : DataSource.Factory {
        override fun createDataSource(): DataSource = NarrationDataSource()
    }
}

/**
 * The player's default, except that a [SpeechStreamBroken] isn't retried: the rest won't come, so
 * it's reported at once, for the narrator to say the chunk again.
 */
@OptIn(UnstableApi::class)
class NarrationLoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
    override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
        if (
            generateSequence<Throwable>(loadErrorInfo.exception) { it.cause }
                .any {
                    it is SpeechStreamBroken
                }
        )
            C.TIME_UNSET
        else super.getRetryDelayMsFor(loadErrorInfo)
}
