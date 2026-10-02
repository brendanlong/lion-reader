package com.lionreader.app.narration

import android.net.Uri
import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MAX_CLOUD_SPEECH_CHARS
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Cloud voices (Kokoro and friends through the server's `/narration/speech`, on the user's or the
 * server's provider key). Each chunk streams: [synthesize] answers as soon as the first audio is
 * in, and the player reads the rest as it arrives ([StreamedAudio]). Audio is cached on disk by
 * model, voice and text, so listening again doesn't pay again; the cache is trimmed to
 * [cacheBytes], least recently used first. Requests run in [scope], not the caller's: every request
 * is paid for, so one the narrator stops waiting for (the user skipped past it) still finishes into
 * the cache.
 */
class CloudVoices(
    private val api: LionReaderApi,
    private val model: String,
    private val voice: String,
    private val cacheDir: File,
    private val scope: CoroutineScope,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val cacheBytes: Long = 50L * 1024 * 1024,
) : SpeechEngine {
    /** Times the server has started answering with speech (not cache hits). */
    private val answered = AtomicLong()

    /**
     * Streams by cache key, from the request until the audio is all in, so the same text twice is
     * one request. Each completes once its audio starts.
     */
    private val inFlight = ConcurrentHashMap<String, Deferred<StreamedAudio>>()

    override val maxChunkChars = MAX_CLOUD_SPEECH_CHARS
    // Requests take anywhere from under a second to many, so a minute ahead,
    // a few at a time (as the web does).
    override val lookaheadChars = 900
    override val parallelism = 3

    override suspend fun synthesize(text: String, dir: File, name: String): Uri {
        val key = key(text)
        val cached = File(cacheDir, "$key.$EXTENSION")
        if (cached.exists()) {
            withContext(io) { cached.setLastModified(System.currentTimeMillis()) }
            return Uri.fromFile(cached)
        }
        val started = CompletableDeferred<StreamedAudio>()
        val stream = stream(key, text, cached, started)
        val running = inFlight.putIfAbsent(key, started)
        if (running == null) stream.start() else stream.cancel()
        return (running ?: started).await().uri
    }

    /**
     * Requests [text] and writes it into [cached] as it arrives, completing [started] once there's
     * audio to play (or with why there won't be). Lazy: started once it's in [inFlight], which it
     * leaves when done.
     */
    private fun stream(
        key: String,
        text: String,
        cached: File,
        started: CompletableDeferred<StreamedAudio>,
    ): Job =
        scope.launch(io, CoroutineStart.LAZY) {
            var writer: CacheWriter? = null
            try {
                request(text) { bytes ->
                    val into = writer ?: CacheWriter(cached).also { writer = it }
                    into.write(bytes)
                    started.complete(into.audio)
                }
                val done = writer ?: throw IOException("The cloud voice sent no audio")
                started.complete(done.finish())
                inFlight.remove(key, started)
                trim()
            } catch (e: Throwable) {
                // First, so the narrator's retry makes a new request rather than get this one.
                inFlight.remove(key, started)
                writer?.fail(e)
                started.completeExceptionally(e)
                if (e is CancellationException) throw e
            }
        }

    /** Writes a stream into the cache, handing each part to the player as it comes. */
    private inner class CacheWriter(private val cached: File) {
        private val partial =
            cacheDir.mkdirs().let {
                File.createTempFile(cached.nameWithoutExtension, ".part", cacheDir)
            }
        private val out = FileOutputStream(partial)

        /** What the player reads. */
        val audio = StreamedAudio(partial)

        fun write(bytes: ByteArray) {
            out.write(bytes)
            audio.appended(bytes.size)
        }

        fun finish(): StreamedAudio {
            out.close()
            // Not cached if it can't be moved, but it plays from where it is.
            audio.finish(cached)
            return audio
        }

        fun fail(cause: Throwable) {
            out.close()
            partial.delete()
            audio.fail(cause as? Exception ?: IOException(cause))
        }
    }

    /**
     * Streams [text] to [onAudio] (on IO: the caller's [scope] dispatcher). Until audio starts,
     * trouble is retried and sorted into the [SpeechEngine] failures; once it has, a failure is the
     * player's to handle ([SpeechStreamBroken]), so it's thrown as is.
     */
    private suspend fun request(text: String, onAudio: suspend (ByteArray) -> Unit) {
        val answeredBefore = answered.get()
        var wait = 1_000L
        var serverTrouble = false
        var busy = false
        for (attempt in 1..ATTEMPTS) {
            var started = false
            try {
                api.streamSpeech(model, voice, text) { bytes ->
                    if (!started) answered.incrementAndGet()
                    started = true
                    onAudio(bytes)
                }
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (started) throw e
                if (e is ApiException) {
                    if (e.status == 0) throw SpeechUnavailable("Sign in to use cloud voices.")
                    if (e.isPermanent || (e.status in 400..499 && e.status != 429)) {
                        throw SpeechUnavailable(e.serverMessage ?: "Cloud voices aren't available.")
                    }
                    serverTrouble = e.status >= 500
                    busy = e.status == 429
                } else {
                    // Network: try again below.
                    serverTrouble = false
                    busy = false
                }
            }
            if (attempt < ATTEMPTS) {
                delay(wait)
                wait *= 2
            }
        }
        // It answers other requests but keeps failing this one: it's this text, so the narrator
        // skips just this chunk (any exception but a SpeechException).
        if (serverTrouble && answered.get() > answeredBefore) {
            throw IOException("The cloud voice couldn't say this part.")
        }
        throw SpeechInterrupted(
            if (serverTrouble || busy) "The cloud voice isn't working right now."
            else "Couldn't reach the cloud voice. Check your connection."
        )
    }

    private fun key(text: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest("$model\n$voice\n$text".toByteArray())
            .joinToString("") { "%02x".format(it) }

    private fun trim() {
        val files = cacheDir.listFiles { file -> file.extension == EXTENSION }.orEmpty()
        // Leftovers of a write the process didn't live to finish, and MP3s from
        // before speech came as MP4.
        cacheDir
            .listFiles { file ->
                file.extension == "mp3" ||
                    (file.extension == "part" &&
                        file.lastModified() < System.currentTimeMillis() - 10 * 60_000)
            }
            ?.forEach { it.delete() }
        var size = files.sumOf { it.length() }
        for (file in files.sortedBy { it.lastModified() }) {
            if (size <= cacheBytes) break
            size -= file.length()
            file.delete()
        }
    }

    private companion object {
        const val ATTEMPTS = 4
        /** AAC in fragmented MP4, as the server sends it. */
        const val EXTENSION = "mp4"
    }
}
